// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistenceService } from '../../persistence/persistence-service';
import { createSqlJsConnection } from '../../persistence/__tests__/sqljs-connection';
import { ImportService } from '../import-service';
import { SyncService } from '../sync-service';
import { applyBaseUrlVariable, baseUrlVariableName } from '../generator';

function spec(server: string | null, props: string[] = ['name']): string {
  const properties: Record<string, unknown> = {};
  for (const p of props) properties[p] = { type: 'string' };
  const doc: Record<string, unknown> = {
    openapi: '3.0.0',
    info: { title: 'API', version: '1' },
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
  };
  if (server) doc.servers = [{ url: server }];
  return JSON.stringify(doc);
}

describe('base-URL workspace variable', () => {
  describe('baseUrlVariableName', () => {
    it('slugifies the collection name and appends _baseUrl', () => {
      expect(baseUrlVariableName('Petstore API')).toBe('Petstore_API_baseUrl');
      expect(baseUrlVariableName('  My API (v2)! ')).toBe('My_API_v2_baseUrl');
      expect(baseUrlVariableName('')).toBe('collection_baseUrl');
    });
  });

  describe('applyBaseUrlVariable', () => {
    it('prefixes the path with the variable, stripping the base URL', () => {
      expect(applyBaseUrlVariable('https://api.test/v1/pets', 'https://api.test/v1', 'X_baseUrl')).toBe(
        '{{X_baseUrl}}/pets',
      );
    });
    it('still prefixes with the variable when there is no base URL', () => {
      expect(applyBaseUrlVariable('/pets', '', 'X_baseUrl')).toBe('{{X_baseUrl}}/pets');
    });
  });

  describe('import and sync', () => {
    let dir: string;
    let service: PersistenceService;
    let workspaceId: string;
    let projectId: string;

    const petUrl = (collectionId: string) =>
      service.requests.listSpecOrigin(collectionId).find((r) => r.source.key === 'POST /pets')!.url;
    const wsVar = (key: string) => service.variables.get('workspace', workspaceId, key);

    beforeEach(async () => {
      const conn = await createSqlJsConnection();
      dir = mkdtempSync(join(tmpdir(), 'awb-baseurl-'));
      service = new PersistenceService(conn, { backupDir: dir, appVersion: '0.1.0' });
      const ws = service.workspaces.create({ name: 'WS' });
      workspaceId = ws.id;
      projectId = service.projects.create({ workspaceId: ws.id, name: 'P' }).id;
    });

    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('creates a workspace variable and prefixes request URLs on import', async () => {
      const { collectionId } = await new ImportService(service).import({
        projectId,
        source: { type: 'text', content: spec('https://api.test/v1') },
      });
      expect(wsVar('API_baseUrl')?.value).toBe('https://api.test/v1');
      expect(petUrl(collectionId)).toBe('{{API_baseUrl}}/pets');
    });

    it('updates the variable (not every URL) when the base URL changes on sync', async () => {
      const { collectionId } = await new ImportService(service).import({
        projectId,
        source: { type: 'text', content: spec('https://api.test/v1') },
      });
      const sync = new SyncService(service);
      const result = await sync.sync({
        collectionId,
        source: { type: 'text', content: spec('https://new.test/v1') },
      });

      // The domain moved into the variable, so the request URL itself is unchanged.
      expect(wsVar('API_baseUrl')?.value).toBe('https://new.test/v1');
      expect(petUrl(collectionId)).toBe('{{API_baseUrl}}/pets');
      expect(result.conflicts).toBe(0);
    });

    it('still creates the variable (empty value) and prefixes URLs when the spec has no server', async () => {
      const { collectionId } = await new ImportService(service).import({
        projectId,
        source: { type: 'text', content: spec(null) },
      });
      expect(wsVar('API_baseUrl')?.value).toBe('');
      expect(petUrl(collectionId)).toBe('{{API_baseUrl}}/pets');
    });
  });
});
