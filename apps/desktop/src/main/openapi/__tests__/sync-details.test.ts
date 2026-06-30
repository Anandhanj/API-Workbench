// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistenceService } from '../../persistence/persistence-service';
import { createSqlJsConnection } from '../../persistence/__tests__/sqljs-connection';
import { ImportService } from '../import-service';
import { SyncService } from '../sync-service';

/** A spec whose POST /pets carries a header param and a JSON body schema. */
function petSpec(opts: { summary?: string; props?: string[] } = {}): string {
  const summary = opts.summary ?? 'Create pet';
  const props = opts.props ?? ['name'];
  const properties: Record<string, unknown> = {};
  for (const p of props) properties[p] = { type: 'string' };
  return JSON.stringify({
    openapi: '3.0.0',
    info: { title: 'API', version: '1' },
    servers: [{ url: 'https://api.test' }],
    paths: {
      '/ping': { get: { summary: 'Ping' } },
      '/pets': {
        post: {
          summary,
          parameters: [{ name: 'X-Trace', in: 'header', schema: { type: 'string' } }],
          requestBody: {
            content: { 'application/json': { schema: { type: 'object', properties } } },
          },
        },
      },
    },
  });
}

const pingOnly = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'API', version: '1' },
  servers: [{ url: 'https://api.test' }],
  paths: { '/ping': { get: { summary: 'Ping' } } },
});

describe('SyncService — request details merge', () => {
  let dir: string;
  let service: PersistenceService;
  let sync: SyncService;
  let projectId: string;
  let collectionId: string;

  const petRecord = () =>
    service.requests.listSpecOrigin(collectionId).find((r) => r.source.key === 'POST /pets')!;
  const petBody = () => JSON.parse(service.requests.getFull(petRecord().id).details.body.rawBody);

  async function importSpec(content: string): Promise<void> {
    collectionId = (await new ImportService(service).import({ projectId, source: { type: 'text', content } })).collectionId;
  }

  beforeEach(async () => {
    const conn = await createSqlJsConnection();
    dir = mkdtempSync(join(tmpdir(), 'awb-syncd-'));
    service = new PersistenceService(conn, { backupDir: dir, appVersion: '0.1.0' });
    sync = new SyncService(service);
    const ws = service.workspaces.create({ name: 'WS' });
    projectId = service.projects.create({ workspaceId: ws.id, name: 'P' }).id;
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('loads details for an endpoint added during sync', async () => {
    await importSpec(pingOnly);
    const result = await sync.sync({ collectionId, source: { type: 'text', content: petSpec() } });
    expect(result.added).toBe(1);
    const full = service.requests.getFull(petRecord().id);
    expect(full.details.headers).toEqual([{ key: 'X-Trace', value: 'string', enabled: true }]);
    expect(petBody()).toEqual({ name: 'string' });
  });

  it('updates an UNEDITED request when the spec schema changes', async () => {
    await importSpec(petSpec({ props: ['name'] }));
    expect(petBody()).toEqual({ name: 'string' });

    const result = await sync.sync({
      collectionId,
      source: { type: 'text', content: petSpec({ props: ['name', 'age'] }) },
    });
    expect(result.updated).toBe(1);
    expect(petBody()).toEqual({ name: 'string', age: 'string' });
  });

  it('leaves an unedited request unchanged when the spec is identical', async () => {
    await importSpec(petSpec());
    const result = await sync.sync({ collectionId, source: { type: 'text', content: petSpec() } });
    expect(result.updated).toBe(0);
    expect(petBody()).toEqual({ name: 'string' });
  });

  it('overwrites a user-edited spec field (header) when the spec definition changes', async () => {
    await importSpec(petSpec({ props: ['name'] }));
    const rec = petRecord();
    const edited = service.requests.getFull(rec.id).details;
    edited.headers = [{ key: 'X-Trace', value: 'my-value', enabled: true }];
    service.requests.save(rec.id, { details: edited });

    const result = await sync.sync({
      collectionId,
      source: { type: 'text', content: petSpec({ props: ['name', 'age'] }) },
    });
    // Spec-driven fields (headers, params, body) follow the spec, reported as a
    // normal update rather than a conflict.
    expect(result.conflicts).toBe(0);
    expect(result.updated).toBe(1);
    expect(service.requests.getFull(petRecord().id).details.headers[0].value).toBe('string');
    expect(petBody()).toEqual({ name: 'string', age: 'string' });
  });

  it('preserves user auth while overwriting the spec-driven body', async () => {
    await importSpec(petSpec({ props: ['name'] }));
    const rec = petRecord();
    const edited = service.requests.getFull(rec.id).details;
    edited.auth = { type: 'bearer', token: 'secret' };
    // Also edit the body, which must still be overwritten by the spec.
    edited.body = { ...edited.body, rawBody: '{ "name": "hand-edited" }' };
    service.requests.save(rec.id, { details: edited });

    const result = await sync.sync({
      collectionId,
      source: { type: 'text', content: petSpec({ props: ['name', 'age'] }) },
    });
    expect(result.updated).toBe(1);
    const full = service.requests.getFull(petRecord().id);
    expect(JSON.parse(full.details.body.rawBody)).toEqual({ name: 'string', age: 'string' });
    expect(full.details.auth).toEqual({ type: 'bearer', token: 'secret' });
  });

  it('overwrites a user-edited definition in replace mode', async () => {
    await importSpec(petSpec({ props: ['name'] }));
    const rec = petRecord();
    const edited = service.requests.getFull(rec.id).details;
    edited.headers = [{ key: 'X-Trace', value: 'my-value', enabled: true }];
    service.requests.save(rec.id, { details: edited });

    await sync.sync({
      collectionId,
      mode: 'replace',
      source: { type: 'text', content: petSpec({ props: ['name', 'age'] }) },
    });
    const full = service.requests.getFull(petRecord().id);
    expect(full.details.headers[0].value).toBe('string');
    expect(JSON.parse(full.details.body.rawBody)).toEqual({ name: 'string', age: 'string' });
  });

  it('fills missing details for a request that predates the feature', async () => {
    await importSpec(petSpec());
    const rec = petRecord();
    // Simulate an old record: no stored details and no baseline fingerprint.
    service.requests.updateFromSync(rec.id, {
      details: null,
      source: { key: rec.source.key, method: rec.method, url: rec.url, name: rec.name },
    });
    expect(service.requests.getFull(rec.id).details.headers).toEqual([]);

    await sync.sync({ collectionId, source: { type: 'text', content: petSpec() } });
    expect(service.requests.getFull(petRecord().id).details.headers).toEqual([
      { key: 'X-Trace', value: 'string', enabled: true },
    ]);
  });
});
