// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistenceService } from '../../persistence/persistence-service';
import { createSqlJsConnection } from '../../persistence/__tests__/sqljs-connection';
import { CollectionExplorer } from '../../collections/collection-explorer';
import { ImportService } from '../import-service';
import { SyncService } from '../sync-service';

interface PathOp {
  tag?: string;
  summary: string;
}

function spec(paths: Record<string, PathOp>): string {
  const out: Record<string, unknown> = {};
  for (const [path, op] of Object.entries(paths)) {
    out[path] = { get: { ...(op.tag ? { tags: [op.tag] } : {}), summary: op.summary } };
  }
  return JSON.stringify({
    openapi: '3.0.0',
    info: { title: 'API', version: '1' },
    servers: [{ url: 'https://api.test' }],
    paths: out,
  });
}

describe('SyncService', () => {
  let dir: string;
  let service: PersistenceService;
  let explorer: CollectionExplorer;
  let sync: SyncService;
  let projectId: string;
  let collectionId: string;

  const v1 = spec({
    '/a': { tag: 't', summary: 'Get A' },
    '/b': { tag: 't', summary: 'Get B' },
    '/c': { summary: 'Get C' },
  });

  const requestByKey = (key: string) =>
    service.requests.listSpecOrigin(collectionId).find((r) => r.source.key === key);

  beforeEach(async () => {
    const conn = await createSqlJsConnection();
    dir = mkdtempSync(join(tmpdir(), 'awb-sync-'));
    service = new PersistenceService(conn, { backupDir: dir, appVersion: '0.1.0' });
    explorer = new CollectionExplorer(service);
    sync = new SyncService(service);
    const ws = service.workspaces.create({ name: 'WS' });
    projectId = service.projects.create({ workspaceId: ws.id, name: 'P' }).id;
    collectionId = (await new ImportService(service).import({
      projectId,
      source: { type: 'text', content: v1 },
    })).collectionId;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds new operations and preserves removed ones in safe mode', async () => {
    const v2 = spec({
      '/a': { tag: 't', summary: 'Get A' },
      '/c': { summary: 'Get C' },
      '/d': { tag: 't', summary: 'Get D' },
    });
    const result = await sync.sync({ collectionId, source: { type: 'text', content: v2 } });
    expect(result.added).toBe(1);
    expect(result.removed).toBe(0); // safe merge never deletes
    expect(result.preserved).toBe(1); // '/b' dropped from the spec but kept

    const names = explorer.getTree(collectionId).filter((n) => n.type === 'request').map((n) => n.name);
    expect(names).toContain('Get D');
    expect(names).toContain('Get B'); // preserved, not removed
  });

  it('deletes operations removed from the spec in replace mode', async () => {
    const v2 = spec({
      '/a': { tag: 't', summary: 'Get A' },
      '/c': { summary: 'Get C' },
      '/d': { tag: 't', summary: 'Get D' },
    });
    const result = await sync.sync({
      collectionId,
      mode: 'replace',
      source: { type: 'text', content: v2 },
    });
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);

    const names = explorer.getTree(collectionId).filter((n) => n.type === 'request').map((n) => n.name);
    expect(names).toContain('Get D');
    expect(names).not.toContain('Get B');
  });

  it('updates an unedited request when the spec changes', async () => {
    const v2 = spec({
      '/a': { tag: 't', summary: 'Get A v2' },
      '/b': { tag: 't', summary: 'Get B' },
      '/c': { summary: 'Get C' },
    });
    const result = await sync.sync({ collectionId, source: { type: 'text', content: v2 } });
    expect(result.updated).toBe(1);
    expect(requestByKey('GET /a')?.name).toBe('Get A v2');
  });

  it('preserves a manual edit and reports a conflict (safe mode)', async () => {
    const edited = requestByKey('GET /a')!;
    service.requests.rename(edited.id, 'My A');

    const v2 = spec({
      '/a': { tag: 't', summary: 'Get A v2' },
      '/b': { tag: 't', summary: 'Get B' },
      '/c': { summary: 'Get C' },
    });
    const result = await sync.sync({ collectionId, source: { type: 'text', content: v2 } });
    expect(result.conflicts).toBe(1);
    expect(requestByKey('GET /a')?.name).toBe('My A'); // manual edit preserved
  });

  it('overwrites a manual edit in replace mode', async () => {
    service.requests.rename(requestByKey('GET /a')!.id, 'My A');
    const v2 = spec({
      '/a': { tag: 't', summary: 'Get A v2' },
      '/b': { tag: 't', summary: 'Get B' },
      '/c': { summary: 'Get C' },
    });
    await sync.sync({ collectionId, mode: 'replace', source: { type: 'text', content: v2 } });
    expect(requestByKey('GET /a')?.name).toBe('Get A v2');
  });

  it('does not flag a conflict when only the local side changed', async () => {
    service.requests.rename(requestByKey('GET /a')!.id, 'My A');
    // sync the SAME spec again
    const result = await sync.sync({ collectionId, source: { type: 'text', content: v1 } });
    expect(result.conflicts).toBe(0);
    expect(requestByKey('GET /a')?.name).toBe('My A');
  });

  it('keeps a removed-but-edited request in safe mode, deletes it in replace mode', async () => {
    service.requests.rename(requestByKey('GET /b')!.id, 'My B');
    const v2 = spec({ '/a': { tag: 't', summary: 'Get A' }, '/c': { summary: 'Get C' } });

    const safe = await sync.sync({ collectionId, source: { type: 'text', content: v2 } });
    expect(safe.preserved).toBe(1);
    expect(requestByKey('GET /b')?.name).toBe('My B');

    const replace = await sync.sync({ collectionId, mode: 'replace', source: { type: 'text', content: v2 } });
    expect(replace.removed).toBe(1);
    expect(requestByKey('GET /b')).toBeUndefined();
  });

  it('records the new spec checksum', async () => {
    const before = service.collectionSources.get(collectionId)?.checksum;
    const v2 = spec({ '/a': { tag: 't', summary: 'Get A v2' }, '/b': { tag: 't', summary: 'Get B' }, '/c': { summary: 'Get C' } });
    await sync.sync({ collectionId, source: { type: 'text', content: v2 } });
    const after = service.collectionSources.get(collectionId)?.checksum;
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
  });
});
