import { z } from 'zod';
import { WireAuthConfig } from './auth';

/**
 * Transport DTOs for collection management (Phase 4): collections, folders,
 * requests, the flattened explorer tree, favorites, history, and search.
 */

export const HttpMethod = z.enum([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);
export type HttpMethod = z.infer<typeof HttpMethod>;

export const Collection = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string().min(1),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Collection = z.infer<typeof Collection>;

export const Folder = z.object({
  id: z.string(),
  collectionId: z.string(),
  parentId: z.string().nullable(),
  name: z.string().min(1),
  position: z.number(),
  /** Folder-level auth; null = inherit from parent (ADR-0009 inheritance chain). */
  auth: WireAuthConfig.nullable().default(null),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Folder = z.infer<typeof Folder>;

export const RequestSummary = z.object({
  id: z.string(),
  collectionId: z.string(),
  folderId: z.string().nullable(),
  // May be empty for operations imported with no `summary`; the UI falls back to
  // the endpoint path. Creating a request still requires a name (CreateRequestInput).
  name: z.string(),
  /** Request type (ADR-0009): 'http' or `plugin:<pluginId>/<type>`. For
   *  non-HTTP types, `method`/`url` carry the provider's badge/target. */
  type: z.string().default('http'),
  method: HttpMethod,
  url: z.string(),
  favorite: z.boolean(),
  position: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type RequestSummary = z.infer<typeof RequestSummary>;

/** A node in the flattened explorer tree, depth-annotated for virtualization. */
export const TreeNode = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('folder'),
    id: z.string(),
    parentId: z.string().nullable(),
    name: z.string(),
    depth: z.number(),
  }),
  z.object({
    type: z.literal('request'),
    id: z.string(),
    parentId: z.string().nullable(),
    name: z.string(),
    depth: z.number(),
    method: HttpMethod,
    url: z.string(),
    favorite: z.boolean(),
  }),
]);
export type TreeNode = z.infer<typeof TreeNode>;

/** The OpenAPI spec source a collection was last imported/synced from. */
export const CollectionSourceInfo = z.object({
  collectionId: z.string(),
  specVersion: z.string(),
  title: z.string(),
  baseUrl: z.string(),
  checksum: z.string(),
  /** Remote URL the spec came from, or null for pasted/text imports. */
  sourceUrl: z.string().nullable(),
  updatedAt: z.number(),
});
export type CollectionSourceInfo = z.infer<typeof CollectionSourceInfo>;

export const RequestHistoryEntry = z.object({
  id: z.string(),
  requestId: z.string(),
  name: z.string(),
  method: HttpMethod,
  url: z.string(),
  openedAt: z.number(),
});
export type RequestHistoryEntry = z.infer<typeof RequestHistoryEntry>;

// --- Inputs ---

export const CreateCollectionInput = z.object({
  projectId: z.string(),
  name: z.string().min(1),
});
export type CreateCollectionInput = z.infer<typeof CreateCollectionInput>;

export const CreateFolderInput = z.object({
  collectionId: z.string(),
  parentId: z.string().nullable().optional(),
  name: z.string().min(1),
});
export type CreateFolderInput = z.infer<typeof CreateFolderInput>;

export const CreateRequestInput = z.object({
  collectionId: z.string(),
  folderId: z.string().nullable().optional(),
  name: z.string().min(1),
  method: HttpMethod.optional(),
  url: z.string().optional(),
});
export type CreateRequestInput = z.infer<typeof CreateRequestInput>;
