import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ImportRequest } from '@shared/openapi';
import { invoke } from '../../lib/ipc';

/** Mutation hook for importing an OpenAPI/Swagger document into a project. */
export function useImport(projectId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (request: ImportRequest) => invoke('openapi.import', request),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['collections', projectId ?? ''] });
      void qc.invalidateQueries({ queryKey: ['tree'] });
      // Import seeds a base-URL workspace variable; refresh variable views.
      void qc.invalidateQueries({ queryKey: ['variables'] });
      void qc.invalidateQueries({ queryKey: ['variableKeys'] });
      void qc.invalidateQueries({ queryKey: ['usedVarValues'] });
    },
  });
}
