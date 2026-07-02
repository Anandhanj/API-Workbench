import type { Migration } from './types';

/**
 * Adds `auth` to `folders`: the folder-level authorization config that requests
 * (and nested folders) can inherit. Holds a serialized `WireAuthConfig` JSON blob
 * or NULL. NULL means "inherit from parent" (the default for every folder that
 * exists today); a concrete config or `{ "type": "none" }` stops the inheritance
 * walk. Resolution happens in the main process at execution time. Must match
 * `../schema.ts`.
 */
export const migration0012: Migration = {
  version: 12,
  name: 'folder-auth',
  up: `
    ALTER TABLE folders ADD COLUMN auth TEXT;
  `,
  // SQLite cannot drop a column on older engines; rebuild the table without it.
  down: `
    CREATE TABLE folders_no_auth (
      id            TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL,
      parent_id     TEXT,
      name          TEXT NOT NULL,
      position      INTEGER NOT NULL,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    INSERT INTO folders_no_auth
      SELECT id, collection_id, parent_id, name, position, created_at, updated_at
      FROM folders;
    DROP TABLE folders;
    ALTER TABLE folders_no_auth RENAME TO folders;
    CREATE INDEX idx_folders_collection ON folders(collection_id);
    CREATE INDEX idx_folders_parent ON folders(parent_id);
  `,
};
