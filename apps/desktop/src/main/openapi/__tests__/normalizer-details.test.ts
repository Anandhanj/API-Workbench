// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { normalizeSpec } from '../normalizer';

describe('normalizeSpec — request details', () => {
  it('extracts headers, query params, and a JSON body example (OpenAPI 3)', () => {
    const doc = {
      openapi: '3.0.0',
      info: { title: 'API', version: '1.0' },
      servers: [{ url: 'https://api.test' }],
      paths: {
        '/pets': {
          post: {
            tags: ['pets'],
            summary: 'Create pet',
            parameters: [
              { name: 'X-Trace', in: 'header', schema: { type: 'string' } },
              { name: 'dryRun', in: 'query', schema: { type: 'boolean' } },
            ],
            requestBody: {
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Pet' },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Pet: { type: 'object', properties: { name: { type: 'string' }, age: { type: 'integer' } } },
        },
      },
    };

    const spec = normalizeSpec(doc, 'openapi-3');
    const op = spec.operations[0];
    expect(op.details).toBeDefined();
    expect(op.details?.headers).toEqual([{ key: 'X-Trace', value: 'string', enabled: true }]);
    expect(op.details?.params).toEqual([{ key: 'dryRun', value: 'true', enabled: true }]);
    expect(op.details?.body.mode).toBe('raw');
    expect(JSON.parse(op.details?.body.rawBody ?? '{}')).toEqual({ name: 'string', age: 0 });
  });

  it('extracts a body example from a Swagger 2 body parameter', () => {
    const doc = {
      swagger: '2.0',
      info: { title: 'API', version: '1.0' },
      host: 'api.test',
      basePath: '/v1',
      paths: {
        '/users': {
          post: {
            summary: 'Create user',
            parameters: [
              {
                name: 'body',
                in: 'body',
                schema: { type: 'object', properties: { email: { type: 'string', format: 'email' } } },
              },
            ],
          },
        },
      },
    };

    const spec = normalizeSpec(doc, 'swagger-2');
    const op = spec.operations[0];
    expect(op.details?.body.mode).toBe('raw');
    expect(JSON.parse(op.details?.body.rawBody ?? '{}')).toEqual({ email: 'user@example.com' });
  });

  it('converts path tokens to {{var}} and emits path variables with example values', () => {
    const doc = {
      openapi: '3.0.0',
      info: { title: 'API', version: '1.0' },
      servers: [{ url: 'https://api.test' }],
      paths: {
        '/users/{userId}/posts/{postId}': {
          get: {
            summary: 'Get post',
            parameters: [
              { name: 'userId', in: 'path', required: true, schema: { type: 'string' }, example: 'u_1' },
              { name: 'postId', in: 'path', required: true, schema: { type: 'integer' } },
            ],
          },
        },
      },
    };

    const spec = normalizeSpec(doc, 'openapi-3');
    const op = spec.operations[0];
    expect(op.url).toBe('https://api.test/users/{{userId}}/posts/{{postId}}');
    expect(op.pathVariables).toEqual([
      { key: 'userId', value: 'u_1' },
      { key: 'postId', value: '0' },
    ]);
  });

  it('emits path variables even when the spec omits the parameter declaration', () => {
    const doc = {
      openapi: '3.0.0',
      info: { title: 'API', version: '1.0' },
      servers: [{ url: 'https://api.test' }],
      paths: { '/orders/{orderId}': { get: { summary: 'Get order' } } },
    };
    const spec = normalizeSpec(doc, 'openapi-3');
    expect(spec.operations[0].url).toBe('https://api.test/orders/{{orderId}}');
    expect(spec.operations[0].pathVariables).toEqual([{ key: 'orderId', value: '' }]);
  });

  it('leaves details undefined for a parameterless GET', () => {
    const doc = {
      openapi: '3.0.0',
      info: { title: 'API', version: '1.0' },
      paths: { '/ping': { get: { summary: 'Ping' } } },
    };
    const spec = normalizeSpec(doc, 'openapi-3');
    expect(spec.operations[0].details).toBeUndefined();
  });
});
