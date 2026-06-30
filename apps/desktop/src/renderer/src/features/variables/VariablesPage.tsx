import { useState } from 'react';
import type { VariableScope } from '@shared/variable';
import { isBridgeAvailable } from '../../lib/ipc';
import { useActiveSelection, useWorkspaceDetail } from '../workspaces/use-workspaces';
import { VariablesPanel } from './VariablesPanel';
import { useVariables, useVariableMutations } from './use-variables';

type EditableScope = Extract<VariableScope, 'global' | 'workspace'>;

const SCOPES: { id: EditableScope; label: string }[] = [
  { id: 'global', label: 'Global' },
  { id: 'workspace', label: 'Workspace' },
];

export function VariablesPage(): JSX.Element {
  const bridge = isBridgeAvailable();
  const active = useActiveSelection();
  const workspaceId = active.data?.workspaceId ?? null;
  const workspaceDetail = useWorkspaceDetail(workspaceId);
  const workspaceName = workspaceDetail.data?.workspace.name ?? null;
  const [scope, setScope] = useState<EditableScope>('global');

  const scopeId = scope === 'workspace' ? (workspaceId ?? undefined) : undefined;
  const variables = useVariables(scope, scopeId);
  const mutations = useVariableMutations(scope, scopeId);

  if (!bridge) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <h1 className="text-2xl font-semibold">Variables</h1>
        <p className="mt-2 text-muted">
          Variable management requires the desktop database, available when running inside the
          application.
        </p>
      </div>
    );
  }

  const needsWorkspace = scope === 'workspace' && !workspaceId;

  return (
    <div className="w-full p-6">
      <h1 className="mb-1 text-xl font-semibold">Variables</h1>
      <p className="mb-4 text-sm text-muted">
        Scoped variables resolve by precedence: global &lt; workspace &lt; collection &lt; folder
        &lt; request &lt; workflow &lt; runtime. Mark a value secret to store it encrypted.
      </p>

      <div className="mb-4 flex gap-2">
        {SCOPES.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setScope(s.id)}
            className={`rounded-md border px-4 py-1.5 text-sm ${
              scope === s.id
                ? 'border-accent bg-accent text-accent-fg'
                : 'border-border text-muted hover:text-fg'
            }`}
          >
            {s.label}
            {s.id === 'workspace' && workspaceName && (
              <span
                className={`ml-1.5 text-xs ${scope === s.id ? 'text-accent-fg/80' : 'text-muted'}`}
              >
                ({workspaceName})
              </span>
            )}
          </button>
        ))}
      </div>

      {needsWorkspace ? (
        <p className="text-muted">Select an active workspace to manage workspace variables.</p>
      ) : (
        <VariablesPanel
          variables={variables.data ?? []}
          busy={mutations.set.isPending}
          error={mutations.set.error instanceof Error ? mutations.set.error.message : null}
          onAdd={({ key, value, secret }) =>
            mutations.set.mutate({ scope, ...(scopeId ? { scopeId } : {}), key, value, secret })
          }
          onDelete={(key) => mutations.remove.mutate(key)}
        />
      )}
    </div>
  );
}
