// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { RequestDetailFull } from '@shared/request-details';
import { requestDetailToNodeConfig } from './request-import';

function detail(): RequestDetailFull {
  return {
    id: 'r1',
    collectionId: 'c1',
    folderId: null,
    name: 'Login',
    method: 'POST',
    url: 'https://api.example.com/login?x=1',
    favorite: false,
    details: {
      headers: [
        { key: 'Authorization', value: 'Bearer {{tok}}', enabled: true },
        { key: '', value: '', enabled: true },
        { key: 'X-Off', value: 'no', enabled: false },
      ],
      params: [{ key: 'x', value: '1', enabled: true }],
      auth: { type: 'bearer', token: '{{tok}}' },
      body: { mode: 'raw', rawType: 'json', rawBody: '{"a":1}', formFields: [], binaryBase64: '', binaryFileName: '' },
      options: { timeoutMs: 30000, maxRetries: 0, followRedirects: true },
      preRequestScript: '',
      postResponseScript: '',
    },
  };
}

describe('requestDetailToNodeConfig', () => {
  it('maps method, url, headers, params, body, auth and records the source id', () => {
    const cfg = requestDetailToNodeConfig(detail());
    expect(cfg.method).toBe('POST');
    expect(cfg.url).toBe('https://api.example.com/login?x=1');
    expect(cfg.headers).toEqual({ Authorization: 'Bearer {{tok}}' }); // blank + disabled rows dropped
    expect(cfg.query).toEqual({ x: '1' });
    expect(cfg.body).toEqual({ type: 'json', content: '{"a":1}' });
    expect(cfg.auth).toEqual({ type: 'bearer', token: '{{tok}}' });
    expect(cfg.requestId).toBe('r1');
  });

  it('preserves existing extract rules', () => {
    const cfg = requestDetailToNodeConfig(detail(), [
      { variable: 'v', source: 'body', engine: 'jsonpath', expression: '$.a' },
    ]);
    expect(cfg.extract).toHaveLength(1);
    expect(cfg.extract[0].variable).toBe('v');
  });

  it('omits auth when the request has none', () => {
    const d = detail();
    d.details.auth = { type: 'none' };
    const cfg = requestDetailToNodeConfig(d);
    expect(cfg.auth).toBeUndefined();
  });
});
