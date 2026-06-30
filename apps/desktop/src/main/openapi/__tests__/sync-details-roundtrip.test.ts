// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistenceService } from '../../persistence/persistence-service';
import { createSqlJsConnection } from '../../persistence/__tests__/sqljs-connection';
import { ImportService } from '../import-service';
import { SyncService } from '../sync-service';

/** A spec whose POST /pets body schema is built from the given property names. */
function petSpec(props: string[]): string {
  const properties: Record<string, unknown> = {};
  for (const p of props) properties[p] = { type: 'string' };
  return JSON.stringify({
    openapi: '3.0.0',
    info: { title: 'API', version: '1' },
    servers: [{ url: 'https://api.test' }],
    paths: {
      '/pets': {
        post: {
          summary: 'Create pet',
          requestBody: {
            content: { 'application/json': { schema: { type: 'object', properties } } },
          },
        },
      },
    },
  });
}

/**
 * Regression: a request that has been opened and saved in the editor (which
 * fills user-only fields like scripts with their defaults) must still receive
 * spec schema updates. Previously the shape difference looked like a manual edit
 * and blocked the update.
 */
describe('SyncService — schema updates survive an editor round-trip', () => {
  let dir: string;
  let service: PersistenceService;
  let sync: SyncService;
  let projectId: string;
  let collectionId: string;

  const petRecord = () =>
    service.requests.listSpecOrigin(collectionId).find((r) => r.source.key === 'POST /pets')!;
  const petFull = () => service.requests.getFull(petRecord().id);
  const petBody = () => JSON.parse(petFull().details.body.rawBody);

  beforeEach(async () => {
    const conn = await createSqlJsConnection();
    dir = mkdtempSync(join(tmpdir(), 'awb-syncrt-'));
    service = new PersistenceService(conn, { backupDir: dir, appVersion: '0.1.0' });
    sync = new SyncService(service);
    const ws = service.workspaces.create({ name: 'WS' });
    projectId = service.projects.create({ workspaceId: ws.id, name: 'P' }).id;
    collectionId = (
      await new ImportService(service).import({
        projectId,
        source: { type: 'text', content: petSpec(['name']) },
      })
    ).collectionId;
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('updates the schema after the request was opened and saved unchanged', async () => {
    // Simulate the editor: read the full (default-filled) definition, save it back.
    const rec = petRecord();
    service.requests.save(rec.id, { details: service.requests.getFull(rec.id).details });

    const result = await sync.sync({
      collectionId,
      source: { type: 'text', content: petSpec(['name', 'age']) },
    });

    expect(result.conflicts).toBe(0);
    expect(result.updated).toBe(1);
    expect(petBody()).toEqual({ name: 'string', age: 'string' });
  });

  it('preserves user scripts while applying a spec schema change', async () => {
    const rec = petRecord();
    const details = service.requests.getFull(rec.id).details;
    details.preRequestScript = 'console.log("pre")';
    details.postResponseScript = 'console.log("post")';
    service.requests.save(rec.id, { details });

    const result = await sync.sync({
      collectionId,
      source: { type: 'text', content: petSpec(['name', 'age']) },
    });

    // The body schema updates, but the user's scripts are untouched.
    expect(result.updated).toBe(1);
    expect(petBody()).toEqual({ name: 'string', age: 'string' });
    expect(petFull().details.preRequestScript).toBe('console.log("pre")');
    expect(petFull().details.postResponseScript).toBe('console.log("post")');
  });
});
