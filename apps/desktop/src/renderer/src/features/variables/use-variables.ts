import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SetVariableInput, VariableScope } from '@shared/variable';
import { invoke, isBridgeAvailable } from '../../lib/ipc';

/** React Query hooks over the variable engine IPC channels (Phase 8). */

export function useVariables(scope: VariableScope, scopeId?: string) {
  // Every scope except `global` requires a scopeId; without one the main
  // process rejects the request ("Scope … requires a scopeId"). Disable the
  // query rather than firing an invalid request when the id isn't ready yet.
  const hasScopeId = scope === 'global' || Boolean(scopeId);
  return useQuery({
    queryKey: ['variables', scope, scopeId ?? ''],
    queryFn: () =>
      invoke('variable.list', { scope, ...(scopeId ? { scopeId } : {}) }),
    enabled: isBridgeAvailable() && hasScopeId,
  });
}

export function useVariableMutations(scope: VariableScope, scopeId?: string) {
  const qc = useQueryClient();
  const invalidate = () =>
    void qc.invalidateQueries({ queryKey: ['variables', scope, scopeId ?? ''] });

  return {
    set: useMutation({
      mutationFn: (input: SetVariableInput) => invoke('variable.set', input),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (key: string) =>
        invoke('variable.delete', { scope, key, ...(scopeId ? { scopeId } : {}) }),
      onSuccess: invalidate,
    }),
  };
}
