import { z } from 'zod';
import { HttpMethod } from './collection';
import { RequestDetails } from './request-details';

/**
 * Transport DTOs for the OpenAPI import engine (Phase 5).
 */

export const SpecVersion = z.enum(['openapi-3', 'swagger-2']);
export type SpecVersion = z.infer<typeof SpecVersion>;

export const SpecFormat = z.enum(['json', 'yaml']);
export type SpecFormat = z.infer<typeof SpecFormat>;

/** A single normalized operation extracted from a spec. */
export const NormalizedOperation = z.object({
  method: HttpMethod,
  path: z.string(),
  url: z.string(),
  name: z.string(),
  tag: z.string().nullable(),
  operationId: z.string().optional(),
  /** Headers, params, and a body example extracted from the spec operation. */
  details: RequestDetails.optional(),
  /**
   * Path-template variables (`{userId}` → `{{userId}}`) seeded as request-scoped
   * variables on import, with values from the spec's example/default.
   */
  pathVariables: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
});
export type NormalizedOperation = z.infer<typeof NormalizedOperation>;

/** A spec reduced to the parts the generator needs. */
export const NormalizedSpec = z.object({
  specVersion: SpecVersion,
  title: z.string(),
  apiVersion: z.string(),
  baseUrl: z.string(),
  tags: z.array(z.string()),
  operations: z.array(NormalizedOperation),
  schemaCount: z.number(),
  exampleCount: z.number(),
});
export type NormalizedSpec = z.infer<typeof NormalizedSpec>;

/** Where the spec content comes from. */
export const ImportSource = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), content: z.string() }),
  z.object({ type: z.literal('url'), url: z.string().url() }),
]);
export type ImportSource = z.infer<typeof ImportSource>;

export const ImportRequest = z.object({
  projectId: z.string(),
  name: z.string().optional(),
  source: ImportSource,
});
export type ImportRequest = z.infer<typeof ImportRequest>;

/** Summary of what an import produced. */
export const ImportResult = z.object({
  collectionId: z.string(),
  collectionName: z.string(),
  specVersion: SpecVersion,
  format: SpecFormat,
  title: z.string(),
  apiVersion: z.string(),
  baseUrl: z.string(),
  foldersCreated: z.number(),
  requestsCreated: z.number(),
  operationCount: z.number(),
  schemaCount: z.number(),
  exampleCount: z.number(),
});
export type ImportResult = z.infer<typeof ImportResult>;
