import { useQuery } from '@tanstack/react-query';
import { invoke, isBridgeAvailable } from '../../lib/ipc';

/** A request anywhere in a project's collections, flattened for the picker. */
export interface ProjectRequestRef {
  id: string;
  name: string;
  method: string;
  url: string;
  collectionId: string;
  collectionName: string;
}

/**
 * Lists every request across all of a project's collections, so a workflow
 * request node can be populated from an existing collection request. One query
 * fans out over the project's collections and flattens their trees.
 */
export function useProjectRequests(projectId: string | null | undefined) {
  return useQuery({
    queryKey: ['projectRequests', projectId ?? ''],
    enabled: Boolean(projectId) && isBridgeAvailable(),
    queryFn: async (): Promise<ProjectRequestRef[]> => {
      const collections = await invoke('collection.list', { projectId: projectId as string });
      const out: ProjectRequestRef[] = [];
      for (const collection of collections) {
        const tree = await invoke('collection.tree', { collectionId: collection.id });
        for (const node of tree) {
          if (node.type === 'request') {
            out.push({
              id: node.id,
              name: node.name,
              method: node.method,
              url: node.url,
              collectionId: collection.id,
              collectionName: collection.name,
            });
          }
        }
      }
      return out;
    },
  });
}
