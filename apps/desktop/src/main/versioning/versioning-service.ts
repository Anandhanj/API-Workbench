import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { HttpMethod } from '@shared/collection';
import type {
  CollectionVersion,
  ModifiedRequest,
  RequestFieldChange,
  RestoreResult,
  VersionChangeSummary,
  VersionDiff,
  VersionFolder,
  VersionRequest,
  VersionSnapshot,
} from '@shared/version';
import type { PersistenceService } from '../persistence';
import { PersistenceError } from '../persistence/types';
import type { CollectionVersionRow, FolderRow, RequestRow } from '../persistence/schema';
import { folders as foldersTable, requests as requestsTable } from '../persistence/schema';

/**
 * Collection version control (Phase 7).
 *
 * Captures immutable JSON snapshots of a collection's folder/request tree,
 * computes diffs between a version and the current state (or between two
 * versions), summarizes the change per version, and restores the collection to
 * any prior version. Each snapshot also records the collection's spec checksum
 * at capture time, tying versions back to the OpenAPI source from Phase 6.
 *
 * The acceptance feature is `restore`: it rebuilds the live tree from a snapshot
 * inside a single transaction, preserving the original ids so external links
 * (history, favorites referencing the tree) and the snapshot itself stay stable.
 */
export class VersioningService {
  constructor(private readonly persistence: PersistenceService) {}

  // --- Snapshot ---

  /** Captures the collection's current tree as a new, numbered version. */
  snapshot(collectionId: string, label?: string): CollectionVersion {
    const collection = this.persistence.collections.get(collectionId); // validates existence
    return this.persistence.transaction(() => {
      const snapshot = this.buildSnapshot(collection.id);
      const checksum = this.persistence.collectionSources.get(collection.id)?.checksum ?? null;
      const row = this.persistence.versions.create({
        id: randomUUID(),
        collectionId: collection.id,
        number: this.persistence.versions.nextNumber(collection.id),
        label: label?.trim() ? label.trim() : null,
        checksum,
        createdAt: Date.now(),
        snapshot: JSON.stringify(snapshot),
      });
      return this.toDto(row, snapshot);
    });
  }

  /** Reads the collection's current state into a serializable snapshot. */
  private buildSnapshot(collectionId: string): VersionSnapshot {
    const folders: VersionFolder[] = this.persistence.folders
      .listByCollection(collectionId)
      .map((f) => ({
        id: f.id,
        parentId: f.parentId,
        name: f.name,
        position: f.position,
        auth: f.auth ?? null,
      }));
    const requests: VersionRequest[] = this.persistence.requests
      .listByCollection(collectionId)
      .map((r) => {
        const full = this.persistence.db
          .select()
          .from(requestsTable)
          .where(eq(requestsTable.id, r.id))
          .get();
        return {
          id: r.id,
          folderId: r.folderId,
          name: r.name,
          type: r.type,
          method: r.method,
          url: r.url,
          favorite: r.favorite,
          source: (full?.source ?? null) as VersionRequest['source'],
          position: r.position,
        };
      });
    return { folders, requests };
  }

  // --- History ---

  listVersions(collectionId: string): CollectionVersion[] {
    this.persistence.collections.get(collectionId);
    return this.persistence.versions
      .listByCollection(collectionId)
      .map((row) => this.toDto(row, this.parse(row)));
  }

  getSnapshot(versionId: string): VersionSnapshot {
    return this.parse(this.persistence.versions.get(versionId));
  }

  // --- Diff ---

  /** Diffs a version (base) against the collection's current state (target). */
  diff(versionId: string): VersionDiff {
    const row = this.persistence.versions.get(versionId);
    const from = this.parse(row);
    const to = this.buildSnapshot(row.collectionId);
    return { ...this.computeDiff(from, to), fromVersionId: versionId, toVersionId: null };
  }

  /** Diffs two versions: `aId` is the base, `bId` the target. */
  diffVersions(aId: string, bId: string): VersionDiff {
    const a = this.persistence.versions.get(aId);
    const b = this.persistence.versions.get(bId);
    if (a.collectionId !== b.collectionId) {
      throw new PersistenceError('Cannot diff versions from different collections');
    }
    return {
      ...this.computeDiff(this.parse(a), this.parse(b)),
      fromVersionId: aId,
      toVersionId: bId,
    };
  }

  private computeDiff(
    from: VersionSnapshot,
    to: VersionSnapshot,
  ): Omit<VersionDiff, 'fromVersionId' | 'toVersionId'> {
    const fromReq = new Map(from.requests.map((r) => [r.id, r]));
    const toReq = new Map(to.requests.map((r) => [r.id, r]));

    const addedRequests = to.requests
      .filter((r) => !fromReq.has(r.id))
      .map((r) => ({ id: r.id, name: r.name, method: r.method, url: r.url }));
    const removedRequests = from.requests
      .filter((r) => !toReq.has(r.id))
      .map((r) => ({ id: r.id, name: r.name, method: r.method, url: r.url }));

    const modifiedRequests: ModifiedRequest[] = [];
    for (const before of from.requests) {
      const after = toReq.get(before.id);
      if (!after) continue;
      const changes = this.fieldChanges(before, after);
      if (changes.length > 0) {
        modifiedRequests.push({ id: after.id, name: after.name, changes });
      }
    }

    const fromFolders = new Map(from.folders.map((f) => [f.id, f]));
    const toFolders = new Map(to.folders.map((f) => [f.id, f]));
    const addedFolders = to.folders
      .filter((f) => !fromFolders.has(f.id))
      .map((f) => ({ id: f.id, name: f.name }));
    const removedFolders = from.folders
      .filter((f) => !toFolders.has(f.id))
      .map((f) => ({ id: f.id, name: f.name }));

    return { addedRequests, removedRequests, modifiedRequests, addedFolders, removedFolders };
  }

  private fieldChanges(before: VersionRequest, after: VersionRequest): RequestFieldChange[] {
    const changes: RequestFieldChange[] = [];
    if (before.name !== after.name) {
      changes.push({ field: 'name', before: before.name, after: after.name });
    }
    if (before.method !== after.method) {
      changes.push({ field: 'method', before: before.method, after: after.method });
    }
    if (before.url !== after.url) {
      changes.push({ field: 'url', before: before.url, after: after.url });
    }
    if (before.favorite !== after.favorite) {
      changes.push({
        field: 'favorite',
        before: String(before.favorite),
        after: String(after.favorite),
      });
    }
    if (before.folderId !== after.folderId) {
      changes.push({
        field: 'folderId',
        before: before.folderId ?? '',
        after: after.folderId ?? '',
      });
    }
    return changes;
  }

  /** A short human + countable summary of a version relative to its predecessor. */
  changeSummary(versionId: string): VersionChangeSummary {
    const row = this.persistence.versions.get(versionId);
    const all = this.persistence.versions.listByCollection(row.collectionId); // newest first
    const idx = all.findIndex((v) => v.id === versionId);
    const previous = idx >= 0 && idx < all.length - 1 ? all[idx + 1] : undefined;
    const base: VersionSnapshot = previous ? this.parse(previous) : { folders: [], requests: [] };
    const diff = this.computeDiff(base, this.parse(row));
    const added = diff.addedRequests.length;
    const removed = diff.removedRequests.length;
    const modified = diff.modifiedRequests.length;
    const parts: string[] = [];
    if (added) parts.push(`${added} added`);
    if (removed) parts.push(`${removed} removed`);
    if (modified) parts.push(`${modified} modified`);
    const text = parts.length ? parts.join(', ') : 'No request changes';
    return { versionId, added, removed, modified, text };
  }

  // --- Restore (acceptance feature) ---

  /**
   * Restores the collection to a version's snapshot. Within one transaction it
   * clears the live folders and requests then recreates them from the snapshot,
   * preserving the original ids. Folders are inserted parents-before-children so
   * the self-referential foreign key always resolves.
   */
  restore(versionId: string): RestoreResult {
    const row = this.persistence.versions.get(versionId);
    const collectionId = row.collectionId;
    this.persistence.collections.get(collectionId); // validate still present
    const snapshot = this.parse(row);
    const now = Date.now();

    return this.persistence.transaction(() => {
      // Clear current tree. Requests first, then folders (folders cascade, but be explicit).
      this.persistence.db.delete(requestsTable).where(eq(requestsTable.collectionId, collectionId)).run();
      this.persistence.db.delete(foldersTable).where(eq(foldersTable.collectionId, collectionId)).run();

      for (const folder of this.orderFoldersParentsFirst(snapshot.folders)) {
        const folderRow: FolderRow = {
          id: folder.id,
          collectionId,
          parentId: folder.parentId,
          name: folder.name,
          position: folder.position,
          // Older snapshots predate folder auth; default to inherit (null).
          auth: folder.auth ?? null,
          createdAt: now,
          updatedAt: now,
        };
        this.persistence.db.insert(foldersTable).values(folderRow).run();
      }

      for (const request of snapshot.requests) {
        const requestRow: RequestRow = {
          id: request.id,
          collectionId,
          folderId: request.folderId,
          name: request.name,
          type: request.type,
          method: request.method,
          url: request.url,
          favorite: request.favorite,
          position: request.position,
          source: request.source,
          createdAt: now,
          updatedAt: now,
          details: null,
        };
        this.persistence.db.insert(requestsTable).values(requestRow).run();
      }

      return {
        collectionId,
        versionId,
        number: row.number,
        folders: snapshot.folders.length,
        requests: snapshot.requests.length,
      };
    });
  }

  /** Orders folders so each folder's parent appears before it (BFS from roots). */
  private orderFoldersParentsFirst(folders: VersionFolder[]): VersionFolder[] {
    const byParent = new Map<string | null, VersionFolder[]>();
    for (const folder of folders) {
      const list = byParent.get(folder.parentId) ?? [];
      list.push(folder);
      byParent.set(folder.parentId, list);
    }
    const known = new Set(folders.map((f) => f.id));
    const ordered: VersionFolder[] = [];
    const seen = new Set<string>();
    // Roots: parentId null, or a parent not present in the snapshot (defensive).
    const queue: VersionFolder[] = folders.filter(
      (f) => f.parentId === null || !known.has(f.parentId),
    );
    while (queue.length) {
      const folder = queue.shift() as VersionFolder;
      if (seen.has(folder.id)) continue;
      seen.add(folder.id);
      ordered.push(folder);
      for (const child of byParent.get(folder.id) ?? []) queue.push(child);
    }
    // Any folders not reached (cycle) are appended; restore still inserts them.
    for (const folder of folders) {
      if (!seen.has(folder.id)) ordered.push(folder);
    }
    return ordered;
  }

  // --- Helpers ---

  private parse(row: CollectionVersionRow): VersionSnapshot {
    const raw = JSON.parse(row.snapshot) as VersionSnapshot;
    return {
      folders: raw.folders ?? [],
      requests: (raw.requests ?? []).map((r) => ({
        ...r,
        method: r.method as HttpMethod,
        source: r.source ?? null,
      })),
    };
  }

  private toDto(row: CollectionVersionRow, snapshot: VersionSnapshot): CollectionVersion {
    return {
      id: row.id,
      collectionId: row.collectionId,
      number: row.number,
      label: row.label,
      checksum: row.checksum,
      createdAt: row.createdAt,
      counts: { folders: snapshot.folders.length, requests: snapshot.requests.length },
    };
  }
}
