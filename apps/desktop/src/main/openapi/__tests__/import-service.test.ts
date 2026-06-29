// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistenceService } from '../../persistence/persistence-service';
import { createSqlJsConnection } from '../../persistence/__tests__/sqljs-connection';
import { CollectionExplorer } from '../../collections/collection-explorer';
import { ImportService } from '../import-service';
import { OpenApiImportError } from '../parser';

const openapi3 = {
  openapi: '3.0.0',
  info: { title: 'Petstore', version: '1.2.3' },
  servers: [{ url: 'https://api.petstore.io/v1' }],
  paths: {
    '/pets': {
      get: {
        tags: ['pets'],
        summary: 'List pets',
        operationId: 'listPets',
        responses: { '200': { content: { 'application/json': { example: { a: 1 } } } } },
      },
      post: { tags: ['pets'], operationId: 'createPet' },
    },
    '/users/{id}': {
      get: { tags: ['users'], summary: 'Get user' },
      delete: {},
    },
  },
  components: { schemas: { Pet: {}, User: {} } },
};

const swagger2 = {
  swagger: '2.0',
  info: { title: 'Legacy', version: '1.0' },
  host: 'legacy.example.com',
  basePath: '/api',
  schemes: ['https'],
  paths: { '/things': { get: { tags: ['things'], summary: 'List things' } } },
  definitions: { Thing: {} },
};

const yamlSpec = `
openapi: 3.0.0
info:
  title: YAML API
  version: 0.1.0
paths:
  /ping:
    get:
      tags: [health]
      summary: Ping
`;

describe('ImportService', () => {
  let dir: string;
  let service: PersistenceService;
  let importer: ImportService;
  let projectId: string;

  beforeEach(async () => {
    const conn = await createSqlJsConnection();
    dir = mkdtempSync(join(tmpdir(), 'awb-oas-'));
    service = new PersistenceService(conn, { backupDir: dir, appVersion: '0.1.0' });
    importer = new ImportService(service);
    const ws = service.workspaces.create({ name: 'WS' });
    projectId = service.projects.create({ workspaceId: ws.id, name: 'P' }).id;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('imports an OpenAPI 3 JSON document', async () => {
    const result = await importer.import({
      projectId,
      source: { type: 'text', content: JSON.stringify(openapi3) },
    });
    expect(result.specVersion).toBe('openapi-3');
    expect(result.format).toBe('json');
    expect(result.title).toBe('Petstore');
    expect(result.baseUrl).toBe('https://api.petstore.io/v1');
    expect(result.operationCount).toBe(4);
    expect(result.foldersCreated).toBe(2); // pets, users
    expect(result.requestsCreated).toBe(4);
    expect(result.schemaCount).toBe(2);
    expect(result.exampleCount).toBe(1);

    const explorer = new CollectionExplorer(service);
    const tree = explorer.getTree(result.collectionId);
    const listPets = tree.find((n) => n.type === 'request' && n.name === 'List pets');
    expect(listPets && listPets.type === 'request' && listPets.url).toBe('https://api.petstore.io/v1/pets');
  });

  it('seeds path parameters as request-scoped variables and rewrites the URL', async () => {
    const result = await importer.import({
      projectId,
      source: { type: 'text', content: JSON.stringify(openapi3) },
    });

    const explorer = new CollectionExplorer(service);
    const tree = explorer.getTree(result.collectionId);
    const getUser = tree.find((n) => n.type === 'request' && n.name === 'Get user');
    expect(getUser && getUser.type === 'request' && getUser.url).toBe(
      'https://api.petstore.io/v1/users/{{id}}',
    );

    const requestId = getUser && getUser.type === 'request' ? getUser.id : '';
    const vars = service.variables.listByScope('request', requestId);
    expect(vars.map((v) => v.key)).toContain('id');
    const idVar = vars.find((v) => v.key === 'id');
    expect(idVar?.secret).toBe(false);
  });

  it('imports a Swagger 2 document and resolves the base URL', async () => {
    const result = await importer.import({
      projectId,
      source: { type: 'text', content: JSON.stringify(swagger2) },
    });
    expect(result.specVersion).toBe('swagger-2');
    expect(result.baseUrl).toBe('https://legacy.example.com/api');
    expect(result.schemaCount).toBe(1);
    expect(result.requestsCreated).toBe(1);
  });

  it('imports a YAML document', async () => {
    const result = await importer.import({ projectId, source: { type: 'text', content: yamlSpec } });
    expect(result.format).toBe('yaml');
    expect(result.title).toBe('YAML API');
    expect(result.requestsCreated).toBe(1);
  });

  it('fetches from a URL via the injected fetcher', async () => {
    const withFetch = new ImportService(service, {
      fetchText: async () => JSON.stringify(swagger2),
    });
    const result = await withFetch.import({
      projectId,
      source: { type: 'url', url: 'https://example.com/spec.json' },
    });
    expect(result.specVersion).toBe('swagger-2');
  });

  it('rejects malformed, unsupported, and incomplete documents', async () => {
    await expect(
      importer.import({ projectId, source: { type: 'text', content: '"unterminated' } }),
    ).rejects.toBeInstanceOf(OpenApiImportError);

    await expect(
      importer.import({ projectId, source: { type: 'text', content: JSON.stringify({ info: {}, paths: {} }) } }),
    ).rejects.toThrow(/openapi|swagger/i);

    await expect(
      importer.import({
        projectId,
        source: { type: 'text', content: JSON.stringify({ openapi: '3.0.0', info: { title: 'x', version: '1' } }) },
      }),
    ).rejects.toThrow(/paths/i);
  });

  it('imports a large specification', async () => {
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < 500; i++) {
      paths[`/resource${i}`] = {
        get: { tags: [`tag${i % 10}`], summary: `get ${i}` },
        post: { tags: [`tag${i % 10}`], summary: `post ${i}` },
      };
    }
    const large = { openapi: '3.0.0', info: { title: 'Big', version: '9' }, paths };

    const t0 = performance.now();
    const result = await importer.import({
      projectId,
      source: { type: 'text', content: JSON.stringify(large) },
    });
    const ms = performance.now() - t0;

    expect(result.operationCount).toBe(1000);
    expect(result.requestsCreated).toBe(1000);
    expect(result.foldersCreated).toBe(10);
    expect(ms).toBeLessThan(10000);
  });
});
