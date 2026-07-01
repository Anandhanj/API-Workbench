// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistenceService } from '../../persistence/persistence-service';
import { createSqlJsConnection } from '../../persistence/__tests__/sqljs-connection';
import { ImportService } from '../import-service';
import { SyncService } from '../sync-service';

/** A spec whose GET /pets/{petId} declares a path param with the given example. */
function petByIdSpec(example: string): string {
  return JSON.stringify({
    openapi: '3.0.0',
    info: { title: 'API', version: '1' },
    servers: [{ url: 'https://api.test' }],
    paths: {
      '/pets/{petId}': {
        get: {
          summary: 'Get pet',
          parameters: [{ name: 'petId', in: 'path', required: true, example }],
        },
      },
    },
  });
}

describe('SyncService — path-template variables', () => {
  let dir: string;
  let service: PersistenceService;
  let sync: SyncService;
  let projectId: string;
  let collectionId: string;

  const reqId = () =>
    service.requests.listSpecOrigin(collectionId).find((r) => r.source.key === 'GET /pets/{petId}')!
      .id;
  const petIdVar = (id: string) =>
    service.variables.listByScope('request', id).find((v) => v.key === 'petId')?.value;

  async function importSpec(content: string): Promise<void> {
    collectionId = (
      await new ImportService(service).import({ projectId, source: { type: 'text', content } })
    ).collectionId;
  }

  beforeEach(async () => {
    const conn = await createSqlJsConnection();
    dir = mkdtempSync(join(tmpdir(), 'awb-syncpv-'));
    service = new PersistenceService(conn, { backupDir: dir, appVersion: '0.1.0' });
    sync = new SyncService(service);
    const ws = service.workspaces.create({ name: 'WS' });
    projectId = service.projects.create({ workspaceId: ws.id, name: 'P' }).id;
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('seeds the path variable on import', async () => {
    await importSpec(petByIdSpec('123'));
    expect(petIdVar(reqId())).toBe('123');
  });

  it('re-seeds a missing path variable on a safe-mode sync (repair)', async () => {
    await importSpec(petByIdSpec('123'));
    const id = reqId();
    // Simulate an old/broken request that lost its path-scoped variable.
    service.variables.deleteOne('request', id, 'petId');
    expect(petIdVar(id)).toBeUndefined();

    await sync.sync({ collectionId, source: { type: 'text', content: petByIdSpec('123') } });
    expect(petIdVar(id)).toBe('123');
  });

  it('preserves a user-edited path variable value in safe mode', async () => {
    await importSpec(petByIdSpec('123'));
    const id = reqId();
    service.variables.upsert({
      scope: 'request',
      scopeId: id,
      key: 'petId',
      value: '42',
      secret: false,
      encrypted: false,
    });

    await sync.sync({ collectionId, source: { type: 'text', content: petByIdSpec('999') } });
    expect(petIdVar(id)).toBe('42'); // user value preserved
  });

  it('refreshes the path variable from the spec in replace mode', async () => {
    await importSpec(petByIdSpec('123'));
    const id = reqId();
    service.variables.upsert({
      scope: 'request',
      scopeId: id,
      key: 'petId',
      value: '42',
      secret: false,
      encrypted: false,
    });

    const result = await sync.sync({
      collectionId,
      mode: 'replace',
      source: { type: 'text', content: petByIdSpec('999') },
    });
    expect(petIdVar(id)).toBe('999'); // spec value wins in replace mode
    expect(result.updated).toBe(1); // the refresh is reported
  });
});
