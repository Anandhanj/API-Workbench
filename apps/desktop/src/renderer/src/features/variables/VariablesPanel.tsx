import { useState } from 'react';
import { Check, KeyRound, Lock, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { Variable } from '@shared/variable';

const SECRET_MASK = '••••••••';

export interface VariablesPanelProps {
  variables: Variable[];
  busy?: boolean;
  error?: string | null;
  onAdd: (input: { key: string; value: string; secret: boolean }) => void;
  onDelete: (key: string) => void;
}

/**
 * Presentational variable manager for a single scope: add a key/value, mark it
 * secret (stored encrypted, shown masked), list the current variables, edit a
 * value in place, and delete. Editing reuses the upsert behind `onAdd` (same key
 * overwrites). Secret values are never received from the main process — masked
 * rows show a placeholder, and editing one replaces it with a freshly typed value.
 */
export function VariablesPanel({
  variables,
  busy,
  error,
  onAdd,
  onDelete,
}: VariablesPanelProps): JSX.Element {
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [secret, setSecret] = useState(false);

  // Inline edit state: the key being edited and its draft value.
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  const beginEdit = (v: Variable): void => {
    setEditingKey(v.key);
    // Secret plaintext never reaches the renderer, so start blank for secrets.
    setEditValue(v.secret ? '' : (v.value ?? ''));
  };
  const cancelEdit = (): void => {
    setEditingKey(null);
    setEditValue('');
  };
  const saveEdit = (v: Variable): void => {
    onAdd({ key: v.key, value: editValue, secret: v.secret });
    cancelEdit();
  };

  return (
    <div className="rounded-md border border-border bg-surface p-4">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!key.trim()) return;
          onAdd({ key: key.trim(), value, secret });
          setKey('');
          setValue('');
          setSecret(false);
        }}
      >
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Key"
          aria-label="Variable key"
          className="min-w-0 flex-1 rounded-md border border-border bg-bg px-3 py-1.5 text-sm"
        />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Value"
          aria-label="Variable value"
          type={secret ? 'password' : 'text'}
          className="min-w-0 flex-1 rounded-md border border-border bg-bg px-3 py-1.5 text-sm"
        />
        <label className="flex items-center gap-1.5 text-sm text-muted">
          <input
            type="checkbox"
            checked={secret}
            onChange={(e) => setSecret(e.target.checked)}
            aria-label="Secret"
          />
          Secret
        </label>
        <button
          type="submit"
          disabled={busy}
          aria-label="Add variable"
          className="flex items-center gap-1.5 rounded-md bg-accent px-4 py-1.5 text-sm text-accent-fg disabled:opacity-60"
        >
          <Plus size={14} /> Add
        </button>
      </form>

      {error && <p className="mt-3 text-sm text-danger">{error}</p>}

      <ul className="mt-3 space-y-2">
        {variables.map((v) => {
          const editing = editingKey === v.key;
          return (
            <li
              key={v.id}
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-bg p-3"
            >
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {v.secret ? (
                  <Lock size={14} className="shrink-0 text-muted" />
                ) : (
                  <KeyRound size={14} className="shrink-0 text-muted" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{v.key}</p>
                  {editing ? (
                    <input
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      placeholder={v.secret ? 'Enter a new secret value' : 'Value'}
                      aria-label={`Edit value for ${v.key}`}
                      type={v.secret ? 'password' : 'text'}
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveEdit(v);
                        if (e.key === 'Escape') cancelEdit();
                      }}
                      className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs"
                    />
                  ) : (
                    <p className="truncate font-mono text-xs text-muted">
                      {v.secret ? SECRET_MASK : (v.value ?? '')}
                    </p>
                  )}
                </div>
              </div>
              {editing ? (
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => saveEdit(v)}
                    disabled={busy}
                    aria-label={`Save ${v.key}`}
                    className="rounded-md bg-accent px-2 py-1 text-accent-fg disabled:opacity-60"
                  >
                    <Check size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={cancelEdit}
                    aria-label={`Cancel editing ${v.key}`}
                    className="rounded-md border border-border px-2 py-1 text-muted hover:text-fg"
                  >
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => beginEdit(v)}
                    aria-label={`Edit ${v.key}`}
                  >
                    <Pencil size={14} className="text-muted hover:text-accent" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(v.key)}
                    aria-label={`Delete ${v.key}`}
                  >
                    <Trash2 size={14} className="text-muted hover:text-danger" />
                  </button>
                </div>
              )}
            </li>
          );
        })}
        {variables.length === 0 && (
          <li className="px-1 py-2 text-sm text-muted">
            No variables in this scope yet. Add one above.
          </li>
        )}
      </ul>
    </div>
  );
}
