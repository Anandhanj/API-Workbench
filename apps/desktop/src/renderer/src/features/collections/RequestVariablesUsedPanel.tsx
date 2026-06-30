import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, Pencil, Variable, X } from 'lucide-react';
import type { VariableContext, VariableScope } from '@shared/variable';
import { invoke, isBridgeAvailable } from '../../lib/ipc';
import { useVariableKeys } from '../variables/use-variable-keys';
import type { RequestDraft } from '../runner/build-request';
import {
  canChangeScope,
  groupVariablesByScope,
  requestVariableNames,
  scopeIdFor,
  scopeMoveTargets,
} from './request-variables';

const SCOPE_LABEL: Record<VariableScope, string> = {
  global: 'Global',
  workspace: 'Environment',
  collection: 'Collection',
  folder: 'Folder',
  request: 'Request',
  workflow: 'Workflow',
  runtime: 'Runtime',
};

export interface RequestVariablesUsedPanelProps {
  draft: RequestDraft | null;
  variableContext: VariableContext;
  collapsed: boolean;
  onToggle: () => void;
}

/**
 * Right-side collapsible panel listing every `{{variable}}` referenced by the
 * current request, grouped by the scope each resolves from. Each value can be
 * edited inline. Request-local and collection variables can additionally be
 * promoted to Environment or Global via a scope dropdown — a promotion moves the
 * value (writes the new scope, removes the old) so it regroups in the UI.
 */
export function RequestVariablesUsedPanel({
  draft,
  variableContext,
  collapsed,
  onToggle,
}: RequestVariablesUsedPanelProps): JSX.Element {
  const qc = useQueryClient();
  const names = useMemo(() => requestVariableNames(draft), [draft]);
  const keys = useVariableKeys(variableContext);
  const scopeByName = useMemo(() => {
    const map = new Map<string, { scope: VariableScope; secret: boolean }>();
    for (const k of keys) map.set(k.key, { scope: k.scope, secret: k.secret });
    return map;
  }, [keys]);

  const values = useQuery({
    queryKey: ['usedVarValues', names, variableContext],
    queryFn: async () => {
      const entries = await Promise.all(
        names.map(async (name) => {
          if (scopeByName.get(name)?.secret) return [name, '••••••'] as const;
          const r = await invoke('variable.evaluate', {
            template: `{{${name}}}`,
            context: variableContext,
          });
          return [name, r.value] as const;
        }),
      );
      return Object.fromEntries(entries) as Record<string, string>;
    },
    enabled: isBridgeAvailable() && names.length > 0,
    staleTime: 2_000,
  });

  const [editing, setEditing] = useState<string | null>(null);
  const [draftValue, setDraftValue] = useState('');
  const [draftScope, setDraftScope] = useState<VariableScope>('global');

  const saveVar = useMutation({
    mutationFn: async (input: {
      name: string;
      value: string;
      fromScope?: VariableScope;
      toScope: VariableScope;
    }) => {
      const toId = scopeIdFor(input.toScope, variableContext);
      await invoke('variable.set', {
        scope: input.toScope,
        ...(toId ? { scopeId: toId } : {}),
        key: input.name,
        value: input.value,
      });
      // Promoting to a broader scope: remove the old (narrower) definition so the
      // value actually resolves from — and regroups under — the new scope.
      if (input.fromScope && input.fromScope !== input.toScope) {
        const fromId = scopeIdFor(input.fromScope, variableContext);
        await invoke('variable.delete', {
          scope: input.fromScope,
          ...(fromId ? { scopeId: fromId } : {}),
          key: input.name,
        });
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['usedVarValues'] });
      void qc.invalidateQueries({ queryKey: ['variableKeys'] });
      void qc.invalidateQueries({ queryKey: ['variables'] });
      setEditing(null);
    },
  });

  const startEdit = (name: string): void => {
    const cur = scopeByName.get(name)?.scope;
    setDraftScope(cur ?? (variableContext.workspaceId ? 'workspace' : 'global'));
    setDraftValue(scopeByName.get(name)?.secret ? '' : (values.data?.[name] ?? ''));
    setEditing(name);
  };

  const save = (name: string): void => {
    const cur = scopeByName.get(name)?.scope;
    const movable = canChangeScope(cur);
    const toScope = movable
      ? draftScope
      : (cur ?? (variableContext.workspaceId ? 'workspace' : 'global'));
    saveVar.mutate({ name, value: draftValue, toScope, ...(movable ? { fromScope: cur } : {}) });
  };

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onToggle}
        title="Show variables used"
        aria-label="Show variables used"
        className="sticky top-0 flex w-9 shrink-0 flex-col items-center gap-2 self-start rounded-md border border-border py-2 text-muted hover:bg-surface-2"
      >
        <Variable size={15} />
        <span className="[writing-mode:vertical-rl] text-[11px] font-semibold uppercase tracking-wide">
          Variables
        </span>
        {names.length > 0 && (
          <span className="rounded-full bg-accent px-1.5 text-[10px] font-semibold text-accent-fg">
            {names.length}
          </span>
        )}
      </button>
    );
  }

  const { groups, unresolved } = groupVariablesByScope(
    names,
    (name) => scopeByName.get(name)?.scope,
  );

  const renderRow = (name: string, tone: 'resolved' | 'unresolved'): JSX.Element => {
    const isEditing = editing === name;
    const cur = scopeByName.get(name)?.scope;
    const movable = canChangeScope(cur);
    return (
      <div key={name} className="group border-b border-border px-2 py-1 last:border-0">
        <div className="flex items-center gap-1">
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-accent">{`{{${name}}}`}</span>
          {!isEditing && (
            <button
              type="button"
              aria-label={`Edit ${name}`}
              title="Edit value"
              onClick={() => startEdit(name)}
              className="shrink-0 text-muted opacity-0 hover:text-fg group-hover:opacity-100"
            >
              <Pencil size={12} />
            </button>
          )}
        </div>

        {isEditing ? (
          <div className="mt-1 space-y-1">
            <input
              autoFocus
              value={draftValue}
              onChange={(e) => setDraftValue(e.target.value)}
              placeholder="Value"
              onKeyDown={(e) => {
                if (e.key === 'Enter') save(name);
                else if (e.key === 'Escape') setEditing(null);
              }}
              className="w-full rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-[11px] outline-none focus:border-accent"
            />
            <div className="flex items-center gap-1">
              {movable && cur ? (
                <select
                  value={draftScope}
                  onChange={(e) => setDraftScope(e.target.value as VariableScope)}
                  aria-label="Scope"
                  className="min-w-0 flex-1 rounded border border-border bg-bg px-1 py-0.5 text-[11px]"
                >
                  {scopeMoveTargets(cur, variableContext).map((sc) => (
                    <option key={sc} value={sc}>
                      {sc === cur ? `Keep in ${SCOPE_LABEL[sc]}` : `Move to ${SCOPE_LABEL[sc]}`}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="min-w-0 flex-1 truncate text-[10px] uppercase tracking-wide text-muted">
                  {cur ? SCOPE_LABEL[cur] : variableContext.workspaceId ? 'Environment' : 'Global'}
                </span>
              )}
              <button
                type="button"
                aria-label="Save value"
                disabled={saveVar.isPending}
                onClick={() => save(name)}
                className="shrink-0 rounded bg-accent p-1 text-accent-fg disabled:opacity-50"
              >
                <Check size={12} />
              </button>
              <button
                type="button"
                aria-label="Cancel"
                onClick={() => setEditing(null)}
                className="shrink-0 rounded border border-border p-1 text-muted hover:text-fg"
              >
                <X size={12} />
              </button>
            </div>
          </div>
        ) : (
          <p className="truncate font-mono text-[11px] text-muted">
            {tone === 'unresolved' ? (
              <span className="text-warning">unresolved</span>
            ) : (
              (values.data?.[name] ?? <span className="text-muted/60">…</span>)
            )}
          </p>
        )}
      </div>
    );
  };

  return (
    <aside className="sticky top-0 flex w-64 shrink-0 flex-col self-start rounded-md border border-border">
      <button
        type="button"
        onClick={onToggle}
        className="flex shrink-0 items-center gap-1.5 border-b border-border bg-surface-2 px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted hover:text-fg"
      >
        <ChevronRight size={13} className="rotate-180" />
        <Variable size={12} /> Variables used
        <span className="ml-auto rounded bg-bg px-1.5 text-[10px] normal-case text-muted">
          {names.length}
        </span>
      </button>

      <div className="max-h-[60vh] overflow-y-auto p-2">
        {names.length === 0 ? (
          <p className="px-1 py-2 text-[11px] text-muted">
            No variables referenced in this request.
          </p>
        ) : (
          <div className="flex flex-col gap-2.5">
            {groups.map(({ scope, names: groupNames }) => (
              <div key={scope}>
                <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
                  {SCOPE_LABEL[scope]} <span className="text-muted/70">({groupNames.length})</span>
                </p>
                <div className="rounded border border-border">
                  {groupNames.map((name) => renderRow(name, 'resolved'))}
                </div>
              </div>
            ))}
            {unresolved.length > 0 && (
              <div>
                <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-warning">
                  Unresolved <span className="text-muted/70">({unresolved.length})</span>
                </p>
                <div className="rounded border border-border">
                  {unresolved.map((name) => renderRow(name, 'unresolved'))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
