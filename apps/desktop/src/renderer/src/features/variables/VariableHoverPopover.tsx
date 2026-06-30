import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { VariableContext, VariableScope } from '@shared/variable';
import { invoke, isBridgeAvailable } from '../../lib/ipc';
import { useActiveSelection } from '../workspaces/use-workspaces';
import { useRuntimeValues } from './runtime-values';

export interface VariableHoverPopoverProps {
  name: string;
  /** Viewport rect of the token being hovered (for positioning). */
  anchor: { left: number; bottom: number };
  /** The scope the variable currently resolves from, or null if unresolved. */
  currentScope: VariableScope | null;
  secret: boolean;
  /** Extra scope ids (e.g. collectionId) merged with the active workspace. */
  extraContext?: VariableContext;
  /** When set, the token is a flow variable; show its producing step instead of a value. */
  source?: { nodeName: string; field: string };
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

/** Editable scopes offered in the popover (mapped to engine scopes). */
const EDITABLE: { value: VariableScope; label: string }[] = [
  { value: 'global', label: 'Global' },
  { value: 'workspace', label: 'Environment' },
  { value: 'collection', label: 'Collection' },
];

function scopeId(scope: VariableScope, context: VariableContext): string | undefined {
  if (scope === 'workspace') return context.workspaceId;
  if (scope === 'collection') return context.collectionId;
  if (scope === 'folder') return context.folderId;
  if (scope === 'request') return context.requestId;
  return undefined;
}

/**
 * Hover card for a `{{variable}}` token: shows its current resolved value and
 * scope, and lets the user set/override it inline. Rendered in a portal so it is
 * never clipped by the field's overflow.
 */
export function VariableHoverPopover({
  name,
  anchor,
  currentScope,
  secret,
  extraContext,
  source,
  onMouseEnter,
  onMouseLeave,
}: VariableHoverPopoverProps): JSX.Element {
  const qc = useQueryClient();
  const active = useActiveSelection();
  const runtimeValues = useRuntimeValues();
  const runtimeValue = runtimeValues[name];
  const hasRuntime = runtimeValue !== undefined;
  const context: VariableContext = {
    ...(active.data?.workspaceId ? { workspaceId: active.data.workspaceId } : {}),
    ...extraContext,
  };
  const valueQuery = useQuery({
    queryKey: ['evalVar', name, context],
    queryFn: () => invoke('variable.evaluate', { template: `{{${name}}}`, context }),
    enabled: isBridgeAvailable() && !secret && !source && !hasRuntime,
    staleTime: 2_000,
  });

  const initialScope: VariableScope =
    currentScope && EDITABLE.some((e) => e.value === currentScope)
      ? currentScope
      : context.workspaceId
        ? 'workspace'
        : 'global';

  const [editing, setEditing] = useState(false);
  const [draftValue, setDraftValue] = useState('');
  const [scope, setScope] = useState<VariableScope>(initialScope);

  const save = useMutation({
    mutationFn: () =>
      invoke('variable.set', {
        scope,
        ...(scopeId(scope, context) ? { scopeId: scopeId(scope, context) } : {}),
        key: name,
        value: draftValue,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['variableKeys'] });
      void qc.invalidateQueries({ queryKey: ['evalVar', name] });
      void qc.invalidateQueries({ queryKey: ['variables'] });
      setEditing(false);
    },
  });

  const resolved = secret ? '••••••' : (valueQuery.data?.value ?? '');
  const isUnresolved = !secret && !currentScope && resolved === '';

  const startEdit = (): void => {
    setDraftValue(secret ? '' : resolved);
    setEditing(true);
  };

  // Keep the card inside the viewport: anchoring at the token's left would clip
  // the fixed-width card off the right edge when the token sits near it.
  const POPOVER_WIDTH = 256; // matches w-64
  const MARGIN = 8;
  const left = Math.max(MARGIN, Math.min(anchor.left, window.innerWidth - POPOVER_WIDTH - MARGIN));

  return createPortal(
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      // The popover is portaled to <body>, but React synthetic events still
      // bubble along the React tree to the field's wrapper. Without this, every
      // mousemove over the popover reaches the field's hover handler, which finds
      // no token under the cursor and schedules a close — so moving onto the
      // Edit/Save buttons would hide the popover. Stop it at the root.
      onMouseMove={(e) => e.stopPropagation()}
      // Above modals (the workflow request editor opens at z-100) so the value
      // card is visible when hovering a token inside a dialog.
      style={{ position: 'fixed', top: anchor.bottom + 4, left, zIndex: 200 }}
      className="w-64 rounded-md border border-border bg-surface p-3 text-xs shadow-xl"
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="truncate font-mono font-medium text-fg">{name}</span>
        <span className="shrink-0 rounded bg-bg px-1.5 py-0.5 text-[10px] uppercase text-muted">
          {hasRuntime ? 'run' : source ? 'step' : (currentScope ?? 'unresolved')}
        </span>
      </div>

      {hasRuntime ? (
        <div className="space-y-1">
          <div className="break-all rounded bg-bg px-2 py-1 font-mono text-fg">
            {runtimeValue || <span className="text-muted">(empty)</span>}
          </div>
          <p className="text-[11px] text-muted">Current value in this run.</p>
        </div>
      ) : source ? (
        <div className="space-y-1">
          <div className="rounded bg-bg px-2 py-1 text-muted">
            Produced by <span className="font-medium text-fg">{source.nodeName}</span>
            <span className="text-muted"> · {source.field}</span>
          </div>
          <p className="text-[11px] text-muted">Value is available when the workflow runs.</p>
        </div>
      ) : !editing ? (
        <>
          <div className="break-all rounded bg-bg px-2 py-1 font-mono text-muted">
            {isUnresolved ? (
              <span className="text-warning">unresolved</span>
            ) : (
              resolved || <span className="text-muted">(empty)</span>
            )}
          </div>
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              startEdit();
            }}
            className="mt-2 rounded border border-border px-2 py-1 text-[11px] hover:bg-surface-2"
          >
            {isUnresolved ? 'Set value' : 'Edit'}
          </button>
        </>
      ) : (
        <div className="space-y-2">
          <input
            autoFocus
            value={draftValue}
            onChange={(e) => setDraftValue(e.target.value)}
            placeholder="Enter value"
            className="w-full rounded border border-border bg-bg px-2 py-1 font-mono"
            onKeyDown={(e) => {
              if (e.key === 'Enter') save.mutate();
              if (e.key === 'Escape') setEditing(false);
            }}
          />
          <div className="flex items-center gap-2">
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as VariableScope)}
              aria-label="Variable scope"
              className="flex-1 rounded border border-border bg-bg px-1.5 py-1"
            >
              {EDITABLE.filter((e) => e.value !== 'collection' || context.collectionId).map((e) => (
                <option key={e.value} value={e.value}>
                  {e.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onMouseDown={(ev) => {
                ev.preventDefault();
                save.mutate();
              }}
              disabled={save.isPending}
              className="rounded bg-accent px-2 py-1 text-[11px] font-medium text-accent-fg disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
