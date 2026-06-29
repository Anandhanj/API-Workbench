import { useQueryClient } from '@tanstack/react-query';
import { VariablesPanel } from './VariablesPanel';
import { useVariables, useVariableMutations } from './use-variables';

export interface RequestVariablesTabProps {
  requestId: string;
}

/**
 * Edits variables scoped to a single request — the same add/secret/delete
 * features as the global/workspace Variables page, bound to the `request` scope.
 * Path parameters from an imported OpenAPI spec are seeded here on import, so
 * `{{token}}` in the URL resolves and the value persists with the request.
 *
 * Mutations also invalidate `variableKeys` so URL/field highlighting picks up
 * newly added or removed keys immediately.
 */
export function RequestVariablesTab({ requestId }: RequestVariablesTabProps): JSX.Element {
  const qc = useQueryClient();
  const variables = useVariables('request', requestId);
  const mutations = useVariableMutations('request', requestId);
  const refreshKeys = (): void => void qc.invalidateQueries({ queryKey: ['variableKeys'] });

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted">
        Variables scoped to this request. Path parameters from the imported spec appear here;
        reference them as <code className="text-accent">{'{{name}}'}</code> in the URL. Request
        scope overrides folder, collection, workspace, and global.
      </p>
      <VariablesPanel
        variables={variables.data ?? []}
        busy={mutations.set.isPending}
        error={mutations.set.error instanceof Error ? mutations.set.error.message : null}
        onAdd={({ key, value, secret }) =>
          mutations.set.mutate(
            { scope: 'request', scopeId: requestId, key, value, secret },
            { onSuccess: refreshKeys },
          )
        }
        onDelete={(key) => mutations.remove.mutate(key, { onSuccess: refreshKeys })}
      />
    </div>
  );
}
