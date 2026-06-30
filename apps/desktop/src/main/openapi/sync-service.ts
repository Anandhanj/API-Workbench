import type { NormalizedOperation, NormalizedSpec, SpecVersion } from '@shared/openapi';
import type { RequestSource, SyncChange, SyncMode, SyncRequest, SyncResult } from '@shared/sync';
import type { RequestDetails } from '@shared/request-details';
import type { PersistenceService } from '../persistence';
import type { SpecRequestRecord } from '../persistence/repositories/request-repository';
import { parseDocument, detectVersion, validateBasic } from './parser';
import { normalizeSpec } from './normalizer';
import {
  operationKey,
  checksumContent,
  detailsKey,
  seedPathVariables,
  baseUrlVariableName,
  applyBaseUrlVariable,
  seedBaseUrlVariable,
} from './generator';
import { loadSpecContent, type FetchText } from './load';

/**
 * Builds the request definition to persist when the spec's definition changed.
 *
 * The spec-derived fields (body, query params, headers) always follow the spec —
 * manual edits to those are overwritten on sync. The user's auth and execution
 * options are preserved in safe mode (the spec wins for them in replace mode),
 * and the user-only fields the spec never sets (scripts, description) are always
 * carried over.
 */
function applySpecDetails(
  spec: RequestDetails | null,
  local: RequestDetails | null,
  mode: SyncMode,
): RequestDetails | null {
  const userFields: Partial<RequestDetails> = {
    preRequestScript: local?.preRequestScript ?? '',
    postResponseScript: local?.postResponseScript ?? '',
    ...(local?.description ? { description: local.description } : {}),
  };
  if (spec === null) {
    const hasUserContent =
      Boolean(userFields.preRequestScript) ||
      Boolean(userFields.postResponseScript) ||
      'description' in userFields;
    return hasUserContent ? ({ ...local, ...userFields } as RequestDetails) : null;
  }
  const preserved: Partial<RequestDetails> =
    mode === 'replace' || local === null ? {} : { auth: local.auth, options: local.options };
  return { ...spec, ...preserved, ...userFields };
}

export interface SyncServiceDeps {
  fetchText?: FetchText;
}

type Field = 'name' | 'url' | 'method';
const FIELDS: Field[] = ['name', 'url', 'method'];

type ReconcileOutcome =
  | { kind: 'conflict'; detail: string }
  | { kind: 'updated'; name: string }
  | { kind: 'unchanged' };


/**
 * OpenAPI synchronization engine (Phase 6).
 *
 * Re-imports a changed spec and reconciles it with an existing collection using
 * a three-way merge: for each spec-originated request it compares the current
 * value, the stored spec baseline, and the new spec value. Unedited fields are
 * updated; manually edited fields are preserved (safe mode) and reported as
 * conflicts when the spec also changed; everything is overwritten in replace
 * mode. New operations are added, and operations removed from the spec are
 * deleted — unless they were manually edited, in which case safe mode keeps them.
 */
export class SyncService {
  constructor(
    private readonly persistence: PersistenceService,
    private readonly deps: SyncServiceDeps = {},
  ) {}

  async sync(request: SyncRequest): Promise<SyncResult> {
    const collection = this.persistence.collections.get(request.collectionId);
    const content = await loadSpecContent(request.source, this.deps.fetchText);
    const { document } = parseDocument(content);
    const version = detectVersion(document);
    validateBasic(document);
    const spec = normalizeSpec(document, version);
    const mode: SyncMode = request.mode ?? 'safe';
    const sourceUrl = request.source.type === 'url' ? request.source.url : undefined;

    return this.persistence.transaction(() =>
      this.merge(collection.id, spec, version, content, mode, sourceUrl),
    );
  }

  private merge(
    collectionId: string,
    spec: NormalizedSpec,
    version: SpecVersion,
    content: string,
    mode: SyncMode,
    sourceUrl?: string,
  ): SyncResult {
    // Keep the collection's base-URL workspace variable in sync with the spec, so
    // a changed domain propagates to every request through the `{{...baseUrl}}`
    // reference without rewriting each URL.
    const collection = this.persistence.collections.get(collectionId);
    const baseUrlVar = baseUrlVariableName(collection.name);
    const workspaceId = this.persistence.projects.get(collection.projectId).workspaceId;
    seedBaseUrlVariable(this.persistence, workspaceId, baseUrlVar, spec.baseUrl);

    const existing = this.persistence.requests.listSpecOrigin(collectionId);
    const byKey = new Map<string, SpecRequestRecord>(existing.map((r) => [r.source.key, r]));
    const specOps = new Map<string, NormalizedOperation>();
    for (const op of spec.operations) {
      const url = applyBaseUrlVariable(op.url, spec.baseUrl, baseUrlVar);
      specOps.set(operationKey(op.method, op.path), { ...op, url });
    }

    const changes: SyncChange[] = [];
    let added = 0;
    let updated = 0;
    let removed = 0;
    let conflicts = 0;
    let preserved = 0;
    let unchanged = 0;

    // Root tag folders, reused / created lazily for added operations.
    const folderByTag = new Map<string, string>();
    for (const folder of this.persistence.folders.listByCollection(collectionId)) {
      if (folder.parentId === null) folderByTag.set(folder.name, folder.id);
    }
    const ensureFolder = (tag: string | null): string | null => {
      if (!tag) return null;
      const existingId = folderByTag.get(tag);
      if (existingId) return existingId;
      const created = this.persistence.folders.create({ collectionId, name: tag });
      folderByTag.set(tag, created.id);
      return created.id;
    };

    // Additions and reconciliation.
    for (const [key, op] of specOps) {
      const record = byKey.get(key);
      if (!record) {
        const created = this.persistence.requests.createFromSpec({
          collectionId,
          folderId: ensureFolder(op.tag),
          name: op.name,
          method: op.method,
          url: op.url,
          ...(op.details ? { details: op.details } : {}),
          source: {
            key,
            method: op.method,
            url: op.url,
            name: op.name,
            detailsKey: detailsKey(op.details),
          },
        });
        // Seed path variables for newly-added requests only; existing requests'
        // variables are preserved (may carry user-edited values).
        seedPathVariables(this.persistence, created.id, op.pathVariables);
        changes.push({ type: 'added', key, name: op.name });
        added += 1;
        continue;
      }

      const outcome = this.reconcile(record, op, mode);
      if (outcome.kind === 'conflict') {
        conflicts += 1;
        changes.push({ type: 'conflict', key, name: record.name, detail: outcome.detail });
      } else if (outcome.kind === 'updated') {
        updated += 1;
        changes.push({ type: 'updated', key, name: outcome.name });
      } else {
        unchanged += 1;
      }
    }

    // Removals.
    for (const [key, record] of byKey) {
      if (specOps.has(key)) continue;
      const edited =
        record.name !== record.source.name ||
        record.url !== record.source.url ||
        record.method !== record.source.method;
      if (mode === 'replace' || !edited) {
        this.persistence.requests.delete(record.id);
        removed += 1;
        changes.push({ type: 'removed', key, name: record.name });
      } else {
        preserved += 1;
        changes.push({
          type: 'preserved',
          key,
          name: record.name,
          detail: 'Removed from spec but kept (manually edited)',
        });
      }
    }

    this.persistence.collectionSources.upsert({
      collectionId,
      specVersion: version,
      title: spec.title,
      baseUrl: spec.baseUrl,
      checksum: checksumContent(content),
      ...(sourceUrl !== undefined ? { sourceUrl } : {}),
    });

    return { collectionId, mode, added, updated, removed, conflicts, preserved, unchanged, changes };
  }

  private reconcile(
    record: SpecRequestRecord,
    op: NormalizedOperation,
    mode: SyncMode,
  ): ReconcileOutcome {
    const specVals: Record<Field, string> = { name: op.name, url: op.url, method: op.method };
    const next: Record<Field, string> = {
      name: record.name,
      url: record.url,
      method: record.method,
    };

    let conflict = false;
    let changed = false;
    const conflictFields: Field[] = [];

    for (const field of FIELDS) {
      const current = String(record[field]);
      const baseline = String(record.source[field]);
      const specVal = specVals[field];
      const manualEdit = current !== baseline;
      const specChanged = specVal !== baseline;

      if (!manualEdit) {
        if (specChanged) {
          next[field] = specVal;
          changed = true;
        }
      } else if (specChanged) {
        conflict = true;
        conflictFields.push(field);
        if (mode === 'replace') {
          next[field] = specVal;
          changed = true;
        }
      }
    }

    // The request definition's spec-driven fields (body, query params, headers)
    // always follow the spec: when the spec definition changes we re-apply it,
    // overwriting any manual edits to those fields. `applySpecDetails` preserves
    // the user's auth/options (safe mode) and scripts/description. The stored
    // baseline is `source.detailsKey`; when absent (request predates the baseline)
    // we adopt the local copy so spec changes still flow through.
    const specDetails = op.details ?? null;
    const specDetailsKey = detailsKey(specDetails);
    const localDetailsKey = detailsKey(record.details);
    const baselineDetailsKey = record.source.detailsKey ?? localDetailsKey;
    const detailsSpecChanged = specDetailsKey !== baselineDetailsKey;

    let detailsToWrite: RequestDetails | null | undefined;
    if (detailsSpecChanged) {
      detailsToWrite = applySpecDetails(specDetails, record.details, mode);
    }
    const detailsChanged = detailsToWrite !== undefined;

    const newSource: RequestSource = {
      key: record.source.key,
      method: op.method,
      url: op.url,
      name: op.name,
      detailsKey: specDetailsKey,
    };
    const baselineChanged =
      newSource.name !== record.source.name ||
      newSource.url !== record.source.url ||
      newSource.method !== record.source.method ||
      newSource.detailsKey !== record.source.detailsKey;

    if (changed || baselineChanged || detailsChanged) {
      this.persistence.requests.updateFromSync(record.id, {
        name: next.name,
        url: next.url,
        method: next.method,
        source: newSource,
        ...(detailsChanged ? { details: detailsToWrite } : {}),
      });
    }

    if (conflict) {
      return {
        kind: 'conflict',
        detail: `spec changed ${conflictFields.join(', ')}; local edits preserved`,
      };
    }
    if (changed || detailsChanged) return { kind: 'updated', name: next.name };
    return { kind: 'unchanged' };
  }
}
