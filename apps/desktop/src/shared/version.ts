import { z } from 'zod';
import { HttpMethod } from './collection';
import { WireAuthConfig } from './auth';
import { RequestSource } from './sync';

/**
 * Transport DTOs for collection version control (Phase 7): immutable snapshots of
 * a collection's tree, the metadata listed in the version history, the diff
 * between a version and the current state (or between two versions), and the
 * change summary shown per version.
 */

/** A folder as captured inside a version snapshot. */
export const VersionFolder = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  name: z.string(),
  position: z.number(),
  /** Folder-level auth; null = inherit. Snapshots from before this default to null. */
  auth: WireAuthConfig.nullable().default(null),
});
export type VersionFolder = z.infer<typeof VersionFolder>;

/** A request as captured inside a version snapshot. */
export const VersionRequest = z.object({
  id: z.string(),
  folderId: z.string().nullable(),
  name: z.string(),
  /** Request type (ADR-0009); snapshots from before Phase 16 default to 'http'. */
  type: z.string().default('http'),
  method: HttpMethod,
  url: z.string(),
  favorite: z.boolean(),
  source: RequestSource.nullable(),
  position: z.number(),
});
export type VersionRequest = z.infer<typeof VersionRequest>;

/** The full serialized shape of a collection at snapshot time. */
export const VersionSnapshot = z.object({
  folders: z.array(VersionFolder),
  requests: z.array(VersionRequest),
});
export type VersionSnapshot = z.infer<typeof VersionSnapshot>;

/** Version metadata (without the full snapshot) shown in the history list. */
export const CollectionVersion = z.object({
  id: z.string(),
  collectionId: z.string(),
  number: z.number(),
  label: z.string().nullable(),
  /** The collection's spec checksum at snapshot time; null if never spec-sourced. */
  checksum: z.string().nullable(),
  createdAt: z.number(),
  counts: z.object({ folders: z.number(), requests: z.number() }),
});
export type CollectionVersion = z.infer<typeof CollectionVersion>;

/** A request field that differs between two states. */
export const RequestFieldChange = z.object({
  field: z.enum(['name', 'method', 'url', 'favorite', 'folderId']),
  before: z.string(),
  after: z.string(),
});
export type RequestFieldChange = z.infer<typeof RequestFieldChange>;

export const DiffRequest = z.object({
  id: z.string(),
  name: z.string(),
  method: HttpMethod,
  url: z.string(),
});
export type DiffRequest = z.infer<typeof DiffRequest>;

export const ModifiedRequest = z.object({
  id: z.string(),
  name: z.string(),
  changes: z.array(RequestFieldChange),
});
export type ModifiedRequest = z.infer<typeof ModifiedRequest>;

export const DiffFolder = z.object({ id: z.string(), name: z.string() });
export type DiffFolder = z.infer<typeof DiffFolder>;

/**
 * The difference between two collection states (a version vs. current, or two
 * versions). "from" is the older/base state, "to" is the newer/target state.
 */
export const VersionDiff = z.object({
  fromVersionId: z.string().nullable(),
  toVersionId: z.string().nullable(),
  addedRequests: z.array(DiffRequest),
  removedRequests: z.array(DiffRequest),
  modifiedRequests: z.array(ModifiedRequest),
  addedFolders: z.array(DiffFolder),
  removedFolders: z.array(DiffFolder),
});
export type VersionDiff = z.infer<typeof VersionDiff>;

/** A short, countable summary of a version relative to its predecessor. */
export const VersionChangeSummary = z.object({
  versionId: z.string(),
  added: z.number(),
  removed: z.number(),
  modified: z.number(),
  text: z.string(),
});
export type VersionChangeSummary = z.infer<typeof VersionChangeSummary>;

/** Outcome of restoring a collection to a prior version. */
export const RestoreResult = z.object({
  collectionId: z.string(),
  versionId: z.string(),
  number: z.number(),
  folders: z.number(),
  requests: z.number(),
});
export type RestoreResult = z.infer<typeof RestoreResult>;
