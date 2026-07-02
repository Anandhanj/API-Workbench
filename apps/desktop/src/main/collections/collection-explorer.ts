import type {
  Collection,
  Folder,
  RequestSummary,
  RequestHistoryEntry,
  TreeNode,
  CreateCollectionInput,
  CreateFolderInput,
  CreateRequestInput,
} from '@shared/collection';
import type { CollectionSourceInfo } from '@shared/collection';
import type { RequestDetailFull, SaveRequestInput } from '@shared/request-details';
import type { WireAuthConfig } from '@shared/auth';
import type { PersistenceService } from '../persistence';
import { PersistenceError } from '../persistence/types';

/**
 * Application service for collection management (Phase 4).
 *
 * Orchestrates the collection/folder/request repositories to provide the explorer
 * tree, move/copy with cycle protection, search, favorites, and history. The tree
 * is returned as a flat, depth-annotated list so the renderer can virtualize it
 * and stay responsive at tens of thousands of nodes.
 */
export class CollectionExplorer {
  constructor(private readonly persistence: PersistenceService) {}

  // --- Collections ---

  listCollections(projectId: string): Collection[] {
    return this.persistence.collections.listByProject(projectId);
  }

  createCollection(input: CreateCollectionInput): Collection {
    this.persistence.projects.get(input.projectId); // validate parent
    return this.persistence.collections.create(input);
  }

  renameCollection(id: string, name: string): Collection {
    return this.persistence.collections.rename(id, name);
  }

  deleteCollection(id: string): void {
    this.persistence.transaction(() => {
      // Purge scoped variables/credentials before the cascade removes the
      // folders/requests they are enumerated from (no FK to cascade through).
      this.persistence.scopedData.collection(id);
      this.persistence.collections.delete(id); // cascades folders + requests
    });
  }

  /** The spec source (incl. import URL) a collection was last imported/synced from. */
  getSource(collectionId: string): CollectionSourceInfo | null {
    const row = this.persistence.collectionSources.get(collectionId);
    if (!row) return null;
    return {
      collectionId: row.collectionId,
      specVersion: row.specVersion,
      title: row.title,
      baseUrl: row.baseUrl,
      checksum: row.checksum,
      sourceUrl: row.sourceUrl ?? null,
      updatedAt: row.updatedAt,
    };
  }

  // --- Folders ---

  createFolder(input: CreateFolderInput): Folder {
    this.persistence.collections.get(input.collectionId);
    if (input.parentId) {
      const parent = this.persistence.folders.get(input.parentId);
      if (parent.collectionId !== input.collectionId) {
        throw new PersistenceError('Parent folder belongs to a different collection');
      }
    }
    return this.persistence.folders.create(input);
  }

  renameFolder(id: string, name: string): Folder {
    return this.persistence.folders.rename(id, name);
  }

  /** A single folder, including its own auth config (null = inherit). */
  getFolder(id: string): Folder {
    return this.persistence.folders.get(id);
  }

  /** Sets a folder's own authorization config (null = inherit from parent). */
  updateFolderAuth(id: string, auth: WireAuthConfig | null): Folder {
    this.persistence.folders.get(id); // validate exists
    return this.persistence.folders.updateAuth(id, auth);
  }

  /** Sets every descendant folder and request to inherit auth from this folder. */
  applyAuthToChildren(id: string): { folders: number; requests: number } {
    this.persistence.folders.get(id); // validate exists
    return this.persistence.applyAuthToChildren(id);
  }

  /** Moves a folder under a new parent (or to the root), preventing cycles. */
  moveFolder(id: string, newParentId: string | null): Folder {
    const folder = this.persistence.folders.get(id);
    if (newParentId === id) {
      throw new PersistenceError('A folder cannot be moved into itself');
    }
    if (newParentId !== null) {
      const parent = this.persistence.folders.get(newParentId);
      if (parent.collectionId !== folder.collectionId) {
        throw new PersistenceError('Cannot move a folder across collections');
      }
      if (this.descendantFolderIds(folder.collectionId, id).has(newParentId)) {
        throw new PersistenceError('Cannot move a folder into one of its own descendants');
      }
    }
    return this.persistence.folders.setParent(id, newParentId);
  }

  deleteFolder(id: string): void {
    this.persistence.transaction(() => {
      this.persistence.scopedData.folder(id); // purge scoped data before cascade
      this.persistence.folders.delete(id); // cascades child folders + requests
    });
  }

  private descendantFolderIds(collectionId: string, folderId: string): Set<string> {
    const all = this.persistence.folders.listByCollection(collectionId);
    const childrenByParent = new Map<string | null, Folder[]>();
    for (const folder of all) {
      const list = childrenByParent.get(folder.parentId) ?? [];
      list.push(folder);
      childrenByParent.set(folder.parentId, list);
    }
    const result = new Set<string>();
    const stack = [folderId];
    while (stack.length) {
      const current = stack.pop() as string;
      for (const child of childrenByParent.get(current) ?? []) {
        if (!result.has(child.id)) {
          result.add(child.id);
          stack.push(child.id);
        }
      }
    }
    return result;
  }

  // --- Requests ---

  createRequest(input: CreateRequestInput): RequestSummary {
    this.persistence.collections.get(input.collectionId);
    if (input.folderId) {
      const folder = this.persistence.folders.get(input.folderId);
      if (folder.collectionId !== input.collectionId) {
        throw new PersistenceError('Folder belongs to a different collection');
      }
    }
    return this.persistence.requests.create(input);
  }

  renameRequest(id: string, name: string): RequestSummary {
    return this.persistence.requests.rename(id, name);
  }

  /** Returns a request with its full editable definition for the editor. */
  getRequest(id: string): RequestDetailFull {
    return this.persistence.requests.getFull(id);
  }

  /** Saves edits to a request (identity plus the full definition). */
  saveRequest(input: SaveRequestInput): RequestSummary {
    const { id, ...rest } = input;
    return this.persistence.requests.save(id, rest);
  }

  updateRequest(
    id: string,
    patch: { name?: string; method?: RequestSummary['method']; url?: string },
  ): RequestSummary {
    return this.persistence.requests.update(id, patch);
  }

  moveRequest(id: string, folderId: string | null): RequestSummary {
    if (folderId !== null) {
      const request = this.persistence.requests.get(id);
      const folder = this.persistence.folders.get(folderId);
      if (folder.collectionId !== request.collectionId) {
        throw new PersistenceError('Cannot move a request across collections');
      }
    }
    return this.persistence.requests.setFolder(id, folderId);
  }

  copyRequest(id: string, targetFolderId?: string | null): RequestSummary {
    return this.persistence.requests.duplicate(id, targetFolderId);
  }

  deleteRequest(id: string): void {
    this.persistence.transaction(() => {
      this.persistence.scopedData.request(id); // purge scoped data
      this.persistence.requests.delete(id);
    });
  }

  toggleFavorite(id: string): RequestSummary {
    const request = this.persistence.requests.get(id);
    return this.persistence.requests.setFavorite(id, !request.favorite);
  }

  listFavorites(collectionId: string): RequestSummary[] {
    return this.persistence.requests.listFavorites(collectionId);
  }

  // --- Tree ---

  /** Returns the collection as a flat, depth-annotated, ordered list of nodes. */
  getTree(collectionId: string): TreeNode[] {
    const folders = this.persistence.folders.listByCollection(collectionId);
    const requests = this.persistence.requests.listByCollection(collectionId);

    const byPosition = <T extends { position: number; name: string }>(a: T, b: T): number =>
      a.position - b.position || a.name.localeCompare(b.name);

    const foldersByParent = new Map<string | null, Folder[]>();
    for (const folder of folders) {
      const list = foldersByParent.get(folder.parentId) ?? [];
      list.push(folder);
      foldersByParent.set(folder.parentId, list);
    }
    const requestsByFolder = new Map<string | null, RequestSummary[]>();
    for (const request of requests) {
      const list = requestsByFolder.get(request.folderId) ?? [];
      list.push(request);
      requestsByFolder.set(request.folderId, list);
    }

    const out: TreeNode[] = [];
    const walk = (parentId: string | null, depth: number): void => {
      for (const folder of (foldersByParent.get(parentId) ?? []).sort(byPosition)) {
        out.push({ type: 'folder', id: folder.id, parentId, name: folder.name, depth });
        walk(folder.id, depth + 1);
      }
      for (const request of (requestsByFolder.get(parentId) ?? []).sort(byPosition)) {
        out.push({
          type: 'request',
          id: request.id,
          parentId,
          name: request.name,
          depth,
          method: request.method,
          url: request.url,
          favorite: request.favorite,
        });
      }
    };
    walk(null, 0);
    return out;
  }

  // --- Search ---

  searchRequests(collectionId: string, query: string): RequestSummary[] {
    if (!query.trim()) return [];
    return this.persistence.requests.search(collectionId, query.trim());
  }

  searchProject(projectId: string, query: string): RequestSummary[] {
    if (!query.trim()) return [];
    const collections = this.persistence.collections.listByProject(projectId);
    return collections.flatMap((c) => this.persistence.requests.search(c.id, query.trim()));
  }

  // --- History ---

  openRequest(id: string, now: number = Date.now()): RequestSummary {
    const request = this.persistence.requests.get(id);
    this.persistence.history.record(id, now);
    return request;
  }

  listHistory(limit = 20): RequestHistoryEntry[] {
    return this.persistence.history.list(limit);
  }

  clearHistory(): void {
    this.persistence.history.clear();
  }
}
