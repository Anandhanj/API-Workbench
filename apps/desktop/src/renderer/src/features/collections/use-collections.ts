import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateCollectionInput,
  CreateFolderInput,
  CreateRequestInput,
} from '@shared/collection';
import type { SaveRequestInput } from '@shared/request-details';
import { invoke, isBridgeAvailable } from '../../lib/ipc';

/** React Query hooks over the collection-management IPC channels. */

export function useCollections(projectId: string | null | undefined) {
  return useQuery({
    queryKey: ['collections', projectId ?? ''],
    queryFn: () => invoke('collection.list', { projectId: projectId as string }),
    enabled: Boolean(projectId) && isBridgeAvailable(),
  });
}

export function useTree(collectionId: string | null | undefined) {
  return useQuery({
    queryKey: ['tree', collectionId ?? ''],
    queryFn: () => invoke('collection.tree', { collectionId: collectionId as string }),
    enabled: Boolean(collectionId) && isBridgeAvailable(),
  });
}

/**
 * Load the trees for several collections at once (shares the per-collection
 * `['tree', id]` cache with {@link useTree}). Used to search across all
 * collections at once; pass `enabled: false` to skip fetching when not searching.
 */
export function useTrees(collectionIds: string[], enabled: boolean) {
  return useQueries({
    queries: collectionIds.map((id) => ({
      queryKey: ['tree', id],
      queryFn: () => invoke('collection.tree', { collectionId: id }),
      enabled: enabled && isBridgeAvailable(),
    })),
  });
}

export function useCollectionSource(collectionId: string | null | undefined) {
  return useQuery({
    queryKey: ['collectionSource', collectionId ?? ''],
    queryFn: () => invoke('collection.source', { collectionId: collectionId as string }),
    enabled: Boolean(collectionId) && isBridgeAvailable(),
  });
}

export function useFavorites(collectionId: string | null | undefined) {
  return useQuery({
    queryKey: ['favorites', collectionId ?? ''],
    queryFn: () => invoke('request.favorites', { collectionId: collectionId as string }),
    enabled: Boolean(collectionId) && isBridgeAvailable(),
  });
}

export function useSearch(collectionId: string | null | undefined, query: string) {
  return useQuery({
    queryKey: ['search', collectionId ?? '', query],
    queryFn: () => invoke('request.search', { collectionId: collectionId as string, query }),
    enabled: Boolean(collectionId) && query.trim().length > 0 && isBridgeAvailable(),
  });
}

export function useRequestDetail(id: string | null | undefined) {
  return useQuery({
    queryKey: ['request', id ?? ''],
    queryFn: () => invoke('request.get', { id: id as string }),
    enabled: Boolean(id) && isBridgeAvailable(),
  });
}

export function useHistory(limit = 20) {
  return useQuery({
    queryKey: ['history'],
    queryFn: () => invoke('request.history', { limit }),
    enabled: isBridgeAvailable(),
  });
}

export function useCollectionMutations(projectId: string | null | undefined) {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['collections', projectId ?? ''] });
    void qc.invalidateQueries({ queryKey: ['tree'] });
    void qc.invalidateQueries({ queryKey: ['favorites'] });
    void qc.invalidateQueries({ queryKey: ['history'] });
  };

  return {
    createCollection: useMutation({
      mutationFn: (input: CreateCollectionInput) => invoke('collection.create', input),
      onSuccess: invalidate,
    }),
    deleteCollection: useMutation({
      mutationFn: (id: string) => invoke('collection.delete', { id }),
      onSuccess: invalidate,
    }),
    createFolder: useMutation({
      mutationFn: (input: CreateFolderInput) => invoke('folder.create', input),
      onSuccess: invalidate,
    }),
    createRequest: useMutation({
      mutationFn: (input: CreateRequestInput) => invoke('request.create', input),
      onSuccess: invalidate,
    }),
    deleteRequest: useMutation({
      mutationFn: (id: string) => invoke('request.delete', { id }),
      onSuccess: invalidate,
    }),
    deleteFolder: useMutation({
      mutationFn: (id: string) => invoke('folder.delete', { id }),
      onSuccess: invalidate,
    }),
    renameFolder: useMutation({
      mutationFn: (input: { id: string; name: string }) => invoke('folder.rename', input),
      onSuccess: invalidate,
    }),
    renameRequest: useMutation({
      mutationFn: (input: { id: string; name: string }) => invoke('request.rename', input),
      onSuccess: invalidate,
    }),
    moveRequest: useMutation({
      mutationFn: (input: { id: string; folderId: string | null }) => invoke('request.move', input),
      onSuccess: invalidate,
    }),
    duplicateRequest: useMutation({
      mutationFn: (id: string) => invoke('request.copy', { id }),
      onSuccess: invalidate,
    }),
    toggleFavorite: useMutation({
      mutationFn: (id: string) => invoke('request.toggleFavorite', { id }),
      onSuccess: invalidate,
    }),
    openRequest: useMutation({
      mutationFn: (id: string) => invoke('request.open', { id }),
      onSuccess: invalidate,
    }),
    saveRequest: useMutation({
      mutationFn: (input: SaveRequestInput) => invoke('request.save', input),
      onSuccess: (_data, input) => {
        invalidate();
        void qc.invalidateQueries({ queryKey: ['request', input.id] });
      },
    }),
  };
}
