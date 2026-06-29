import { createHash } from 'node:crypto';
import type { NormalizedOperation, NormalizedSpec } from '@shared/openapi';
import type { PersistenceService } from '../persistence';

export interface GenerateTarget {
  projectId: string;
  name?: string;
}

export interface GenerateResult {
  collectionId: string;
  collectionName: string;
  foldersCreated: number;
  requestsCreated: number;
}

/** Stable sync identity for an operation. */
export function operationKey(method: string, path: string): string {
  return `${method} ${path}`;
}

export function checksumContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Recursively sorts object keys so equal structures stringify identically. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * A stable fingerprint of a request definition, used to detect whether the spec
 * baseline or the user's local copy changed during a three-way detail merge.
 */
export function detailsKey(details: unknown): string {
  return JSON.stringify(sortKeys(details ?? null));
}

/**
 * Seeds an operation's path-template variables as request-scoped variables, so
 * `{{token}}` in the request URL resolves and the value persists with the
 * request. Non-secret and idempotent (upsert keyed by scope/scopeId/key).
 */
export function seedPathVariables(
  persistence: PersistenceService,
  requestId: string,
  pathVariables: NormalizedOperation['pathVariables'],
): void {
  for (const variable of pathVariables ?? []) {
    persistence.variables.upsert({
      scope: 'request',
      scopeId: requestId,
      key: variable.key,
      value: variable.value,
      secret: false,
      encrypted: false,
    });
  }
}

/**
 * Generates a collection from a normalized spec: one folder per tag, one request
 * per operation, each linked to its spec operation via a `source` baseline so it
 * can later be synced. Records the collection's spec source (checksum). Runs in a
 * single transaction.
 */
export function generateCollection(
  persistence: PersistenceService,
  spec: NormalizedSpec,
  target: GenerateTarget,
  checksum: string,
  sourceUrl?: string | null,
): GenerateResult {
  return persistence.transaction(() => {
    persistence.projects.get(target.projectId); // validate parent
    const collectionName = target.name?.trim() || spec.title;
    const collection = persistence.collections.create({ projectId: target.projectId, name: collectionName });

    const folderByTag = new Map<string, string>();
    for (const tag of spec.tags) {
      const folder = persistence.folders.create({ collectionId: collection.id, name: tag });
      folderByTag.set(tag, folder.id);
    }

    for (const operation of spec.operations) {
      const folderId = operation.tag ? folderByTag.get(operation.tag) ?? null : null;
      const key = operationKey(operation.method, operation.path);
      const created = persistence.requests.createFromSpec({
        collectionId: collection.id,
        folderId,
        name: operation.name,
        method: operation.method,
        url: operation.url,
        ...(operation.details ? { details: operation.details } : {}),
        source: {
          key,
          method: operation.method,
          url: operation.url,
          name: operation.name,
          detailsKey: detailsKey(operation.details),
        },
      });
      seedPathVariables(persistence, created.id, operation.pathVariables);
    }

    persistence.collectionSources.upsert({
      collectionId: collection.id,
      specVersion: spec.specVersion,
      title: spec.title,
      baseUrl: spec.baseUrl,
      checksum,
      sourceUrl: sourceUrl ?? null,
    });

    return {
      collectionId: collection.id,
      collectionName,
      foldersCreated: folderByTag.size,
      requestsCreated: spec.operations.length,
    };
  });
}
