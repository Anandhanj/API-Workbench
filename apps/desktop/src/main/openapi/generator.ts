import { createHash } from 'node:crypto';
import type { NormalizedOperation, NormalizedSpec } from '@shared/openapi';
import { RequestDetails } from '@shared/request-details';
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
 * Fields a request definition carries that the OpenAPI import never produces:
 * the pre-request / post-response scripts and a user description. They are owned
 * entirely by the user, so they must be excluded from the spec-sync fingerprint —
 * otherwise simply opening and saving a request in the editor (which fills these
 * with their schema defaults) would look like a manual edit and block spec
 * updates. See `SyncService.reconcile`, which preserves them across a sync.
 */
const USER_ONLY_DETAIL_FIELDS = ['preRequestScript', 'postResponseScript', 'description'] as const;

/**
 * Canonical, spec-relevant projection of a request definition: default-filled so
 * its shape is stable regardless of how it was produced (fresh from the
 * normalizer vs. round-tripped through the editor), with user-only fields removed.
 */
function specRelevantDetails(details: unknown): unknown {
  if (details === null || details === undefined) return null;
  const projected = { ...RequestDetails.parse(details) } as Record<string, unknown>;
  for (const field of USER_ONLY_DETAIL_FIELDS) delete projected[field];
  return projected;
}

/**
 * A stable fingerprint of a request definition, used to detect whether the spec
 * baseline or the user's local copy changed during a three-way detail merge.
 * Computed over the spec-relevant projection so it ignores default-fill noise and
 * user-only fields the spec never sets.
 */
export function detailsKey(details: unknown): string {
  return JSON.stringify(sortKeys(specRelevantDetails(details)));
}

/**
 * The workspace-variable key that holds a collection's base URL. Built from the
 * collection name (runs of non-alphanumeric characters collapsed to a single
 * underscore) plus a `_baseUrl` suffix, e.g. "Petstore API" -> "Petstore_API_baseUrl".
 */
export function baseUrlVariableName(collectionName: string): string {
  const slug = collectionName
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${slug || 'collection'}_baseUrl`;
}

/**
 * Rewrites a spec operation URL to reference the base-URL workspace variable: the
 * leading base URL is replaced with `{{varName}}` so the domain lives in one
 * editable place (and a re-sync only has to update that variable, not every
 * request). When the spec declares no base URL the variable holds an empty
 * placeholder the user can fill in, and the path is prefixed all the same.
 */
export function applyBaseUrlVariable(url: string, baseUrl: string, varName: string): string {
  const suffix = baseUrl && url.startsWith(baseUrl) ? url.slice(baseUrl.length) : url;
  return `{{${varName}}}${suffix}`;
}

/** Upserts the collection's base-URL workspace variable (non-secret, idempotent). */
export function seedBaseUrlVariable(
  persistence: PersistenceService,
  workspaceId: string,
  varName: string,
  baseUrl: string,
): void {
  persistence.variables.upsert({
    scope: 'workspace',
    scopeId: workspaceId,
    key: varName,
    value: baseUrl,
    secret: false,
    encrypted: false,
  });
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

    const baseUrlVar = baseUrlVariableName(collectionName);
    const workspaceId = persistence.projects.get(target.projectId).workspaceId;
    seedBaseUrlVariable(persistence, workspaceId, baseUrlVar, spec.baseUrl);

    const folderByTag = new Map<string, string>();
    for (const tag of spec.tags) {
      const folder = persistence.folders.create({ collectionId: collection.id, name: tag });
      folderByTag.set(tag, folder.id);
    }

    for (const operation of spec.operations) {
      const folderId = operation.tag ? folderByTag.get(operation.tag) ?? null : null;
      const key = operationKey(operation.method, operation.path);
      const url = applyBaseUrlVariable(operation.url, spec.baseUrl, baseUrlVar);
      const created = persistence.requests.createFromSpec({
        collectionId: collection.id,
        folderId,
        name: operation.name,
        method: operation.method,
        url,
        ...(operation.details ? { details: operation.details } : {}),
        source: {
          key,
          method: operation.method,
          url,
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
