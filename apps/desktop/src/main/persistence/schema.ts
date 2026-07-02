import { sqliteTable, text, integer, index, uniqueIndex, primaryKey, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { RequestSource } from '@shared/sync';
import type { WireAuthConfig } from '@shared/auth';
import type { RequestDetails } from '@shared/request-details';
import type { WorkflowGraph } from '@shared/workflow';
import type { PluginManifest } from '@shared/plugins';

/**
 * Drizzle schema — the typed source of truth for all persisted tables.
 *
 * Driver-agnostic: defines table shapes only and imports no concrete SQLite
 * driver. The raw SQL that creates these tables lives in `./migrations`; the two
 * must stay in lockstep. See ADR-0004.
 */

export const schemaMigrations = sqliteTable('schema_migrations', {
  version: integer('version').primaryKey(),
  name: text('name').notNull(),
  appliedAt: integer('applied_at').notNull(),
  checksum: text('checksum').notNull(),
});

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  settings: text('settings', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({ workspaceIdx: index('idx_projects_workspace').on(table.workspaceId) }),
);

export const preferences = sqliteTable('preferences', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const cacheEntries = sqliteTable(
  'cache_entries',
  {
    key: text('key').primaryKey(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => ({ expiryIdx: index('idx_cache_expires').on(table.expiresAt) }),
);

export const collections = sqliteTable(
  'collections',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({ projectIdx: index('idx_collections_project').on(table.projectId) }),
);

export const folders = sqliteTable(
  'folders',
  {
    id: text('id').primaryKey(),
    collectionId: text('collection_id').notNull().references(() => collections.id, { onDelete: 'cascade' }),
    parentId: text('parent_id').references((): AnySQLiteColumn => folders.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    position: integer('position').notNull(),
    /** Folder-level auth config; null = inherit from parent (see ADR / migration 0012). */
    auth: text('auth', { mode: 'json' }).$type<WireAuthConfig>(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    collectionIdx: index('idx_folders_collection').on(table.collectionId),
    parentIdx: index('idx_folders_parent').on(table.parentId),
  }),
);

export const requests = sqliteTable(
  'requests',
  {
    id: text('id').primaryKey(),
    collectionId: text('collection_id').notNull().references(() => collections.id, { onDelete: 'cascade' }),
    folderId: text('folder_id').references(() => folders.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    method: text('method').notNull(),
    url: text('url').notNull(),
    /** Request type (ADR-0009): 'http' or `plugin:<pluginId>/<type>`. For
     *  non-HTTP requests, `method`/`url` hold the provider's badge/target. */
    type: text('type').notNull().default('http'),
    favorite: integer('favorite', { mode: 'boolean' }).notNull(),
    position: integer('position').notNull(),
    /** Spec-imported baseline for sync; null for hand-created requests. */
    source: text('source', { mode: 'json' }).$type<RequestSource>(),
    /** Full editable definition (headers, params, body, auth); null until set. */
    details: text('details', { mode: 'json' }).$type<RequestDetails>(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    collectionIdx: index('idx_requests_collection').on(table.collectionId),
    folderIdx: index('idx_requests_folder').on(table.folderId),
    favoriteIdx: index('idx_requests_favorite').on(table.favorite),
  }),
);

export const requestHistory = sqliteTable(
  'request_history',
  {
    id: text('id').primaryKey(),
    requestId: text('request_id').notNull().references(() => requests.id, { onDelete: 'cascade' }),
    openedAt: integer('opened_at').notNull(),
  },
  (table) => ({
    requestIdx: index('idx_history_request').on(table.requestId),
    openedIdx: index('idx_history_opened').on(table.openedAt),
  }),
);

/** Records the last OpenAPI spec a collection was imported/synced from. */
export const collectionSources = sqliteTable('collection_sources', {
  collectionId: text('collection_id')
    .primaryKey()
    .references(() => collections.id, { onDelete: 'cascade' }),
  specVersion: text('spec_version').notNull(),
  title: text('title').notNull(),
  baseUrl: text('base_url').notNull(),
  checksum: text('checksum').notNull(),
  /** The remote URL the spec was imported from (null for pasted/text imports). */
  sourceUrl: text('source_url'),
  updatedAt: integer('updated_at').notNull(),
});

/** Immutable JSON snapshots of a collection's tree, for version control. */
export const collectionVersions = sqliteTable(
  'collection_versions',
  {
    id: text('id').primaryKey(),
    collectionId: text('collection_id').notNull().references(() => collections.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    label: text('label'),
    checksum: text('checksum'),
    createdAt: integer('created_at').notNull(),
    snapshot: text('snapshot').notNull(),
  },
  (table) => ({ collectionIdx: index('idx_collection_versions_collection').on(table.collectionId) }),
);

/**
 * Scoped variables (Phase 8). `scopeId` is the empty string for global. Secret
 * variables store an encrypted `value` when `encrypted` is true. The unique
 * index on (scope, scopeId, key) enforces one value per key per scope.
 */
export const variables = sqliteTable(
  'variables',
  {
    id: text('id').primaryKey(),
    scope: text('scope').notNull(),
    scopeId: text('scope_id').notNull().default(''),
    key: text('key').notNull(),
    value: text('value').notNull(),
    secret: integer('secret', { mode: 'boolean' }).notNull(),
    encrypted: integer('encrypted', { mode: 'boolean' }).notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    uniqueIdx: uniqueIndex('idx_variables_unique').on(table.scope, table.scopeId, table.key),
    scopeIdx: index('idx_variables_scope').on(table.scope, table.scopeId),
  }),
);

/** Stored, reusable authentication credentials (Phase 9). `config` holds the
 *  serialized AuthConfig, encrypted at rest when `encrypted` is true. */
export const authConfigs = sqliteTable(
  'auth_configs',
  {
    id: text('id').primaryKey(),
    scope: text('scope').notNull(),
    scopeId: text('scope_id').notNull().default(''),
    name: text('name').notNull(),
    type: text('type').notNull(),
    config: text('config').notNull(),
    encrypted: integer('encrypted', { mode: 'boolean' }).notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    uniqueIdx: uniqueIndex('idx_auth_configs_unique').on(table.scope, table.scopeId, table.name),
    scopeIdx: index('idx_auth_configs_scope').on(table.scope, table.scopeId),
  }),
);

/**
 * Workflows (Phase 12). `graph` holds the serialized node/edge graph that both
 * the visual designer and the headless runtime read from. See ADR-0005.
 */
export const workflows = sqliteTable(
  'workflows',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    graph: text('graph', { mode: 'json' }).$type<WorkflowGraph>().notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({ projectIdx: index('idx_workflows_project').on(table.projectId) }),
);

/**
 * Installed plugins (Phase 16, ADR-0007). `manifest` snapshots the validated
 * manifest JSON so listing/contributions need no file reads;
 * `grantedCapabilities` is the user-confirmed subset of what the manifest
 * requested. `plugin_storage` is the quota-enforced per-plugin KV store — the
 * only persistence plugin code can reach.
 */
export const plugins = sqliteTable('plugins', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  version: text('version').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  grantedCapabilities: text('granted_capabilities', { mode: 'json' })
    .$type<string[]>()
    .notNull()
    .default([]),
  installPath: text('install_path').notNull(),
  devMode: integer('dev_mode', { mode: 'boolean' }).notNull().default(false),
  manifest: text('manifest', { mode: 'json' }).$type<PluginManifest>().notNull(),
  installedAt: integer('installed_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const pluginStorage = sqliteTable(
  'plugin_storage',
  {
    pluginId: text('plugin_id').notNull().references(() => plugins.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: text('value').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.pluginId, table.key] }) }),
);

export type WorkspaceRow = typeof workspaces.$inferSelect;
export type WorkspaceInsert = typeof workspaces.$inferInsert;
export type ProjectRow = typeof projects.$inferSelect;
export type ProjectInsert = typeof projects.$inferInsert;
export type PreferenceRow = typeof preferences.$inferSelect;
export type CacheRow = typeof cacheEntries.$inferSelect;
export type CollectionRow = typeof collections.$inferSelect;
export type FolderRow = typeof folders.$inferSelect;
export type RequestRow = typeof requests.$inferSelect;
export type RequestHistoryRow = typeof requestHistory.$inferSelect;
export type CollectionSourceRow = typeof collectionSources.$inferSelect;
export type CollectionVersionRow = typeof collectionVersions.$inferSelect;
export type CollectionVersionInsert = typeof collectionVersions.$inferInsert;
export type VariableRow = typeof variables.$inferSelect;
export type VariableInsert = typeof variables.$inferInsert;
export type AuthConfigRow = typeof authConfigs.$inferSelect;
export type AuthConfigInsert = typeof authConfigs.$inferInsert;
export type WorkflowRow = typeof workflows.$inferSelect;
export type WorkflowInsert = typeof workflows.$inferInsert;
export type PluginRow = typeof plugins.$inferSelect;
export type PluginInsert = typeof plugins.$inferInsert;
export type PluginStorageRow = typeof pluginStorage.$inferSelect;
