// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { WireAuthConfig } from '@shared/auth';
import { applyMigrations } from '../migrator';
import { MIGRATIONS } from '../migrations';
import { PersistenceService } from '../persistence-service';
import { createSqlJsConnection } from './sqljs-connection';
import type { DatabaseConnection } from '../connection';

const bearer: WireAuthConfig = { type: 'bearer', token: 't' };

describe('migration 0012 (folder auth)', () => {
  it('adds a nullable auth column to folders', async () => {
    const conn = await createSqlJsConnection();
    applyMigrations(conn.db, MIGRATIONS.slice(0, 11)); // through 0011
    let cols = (conn.db.all(sql`PRAGMA table_info(folders)`) as Array<{ name: string }>).map(
      (r) => r.name,
    );
    expect(cols).not.toContain('auth');

    applyMigrations(conn.db, MIGRATIONS); // apply 0012
    cols = (conn.db.all(sql`PRAGMA table_info(folders)`) as Array<{ name: string }>).map(
      (r) => r.name,
    );
    expect(cols).toContain('auth');
  });
});

describe('folder auth persistence', () => {
  let dir: string;
  let conn: DatabaseConnection;
  let service: PersistenceService;
  let collectionId: string;

  beforeEach(async () => {
    conn = await createSqlJsConnection();
    dir = mkdtempSync(join(tmpdir(), 'awb-folder-auth-'));
    service = new PersistenceService(conn, { backupDir: dir, appVersion: '0.1.0' });
    const ws = service.workspaces.create({ name: 'WS' });
    const projectId = service.projects.create({ workspaceId: ws.id, name: 'P' }).id;
    collectionId = service.collections.create({ projectId, name: 'API' }).id;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults new folders to null auth (inherit) and round-trips updateAuth', () => {
    const folder = service.folders.create({ collectionId, name: 'v1' });
    expect(folder.auth).toBeNull();

    const updated = service.folders.updateAuth(folder.id, bearer);
    expect(updated.auth).toEqual(bearer);
    expect(service.folders.get(folder.id).auth).toEqual(bearer);

    const cleared = service.folders.updateAuth(folder.id, null);
    expect(cleared.auth).toBeNull();
  });

  it('descendantFolderIds returns all nested folders', () => {
    const top = service.folders.create({ collectionId, name: 'top' });
    const mid = service.folders.create({ collectionId, parentId: top.id, name: 'mid' });
    const leaf = service.folders.create({ collectionId, parentId: mid.id, name: 'leaf' });
    service.folders.create({ collectionId, name: 'sibling' }); // not a descendant

    const ids = service.folders.descendantFolderIds(top.id);
    expect(new Set(ids)).toEqual(new Set([mid.id, leaf.id]));
  });

  it('applyAuthToChildren sets every descendant folder and request to inherit', () => {
    const top = service.folders.create({ collectionId, name: 'top' });
    const mid = service.folders.create({ collectionId, parentId: top.id, name: 'mid' });

    // Concrete auth on descendants so we can observe the cascade overwrite it.
    service.folders.updateAuth(mid.id, bearer);
    const topReq = service.requests.create({ collectionId, folderId: top.id, name: 'a' });
    const midReq = service.requests.create({ collectionId, folderId: mid.id, name: 'b' });
    service.requests.setAuth(topReq.id, bearer);
    service.requests.setAuth(midReq.id, bearer);
    // A request outside the subtree must be left untouched.
    const outside = service.requests.create({ collectionId, name: 'c' });
    service.requests.setAuth(outside.id, bearer);

    const counts = service.applyAuthToChildren(top.id);
    expect(counts).toEqual({ folders: 1, requests: 2 });

    expect(service.folders.get(mid.id).auth).toEqual({ type: 'inherit' });
    expect(service.requests.getFull(topReq.id).details.auth).toEqual({ type: 'inherit' });
    expect(service.requests.getFull(midReq.id).details.auth).toEqual({ type: 'inherit' });
    // The folder the action was invoked on keeps its own auth.
    expect(service.folders.get(top.id).auth).toBeNull();
    // The outside request is unchanged.
    expect(service.requests.getFull(outside.id).details.auth).toEqual(bearer);
  });
});
