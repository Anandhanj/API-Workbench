import { useEffect, useRef, useState } from 'react';
import type { VariableContext } from '@shared/variable';
import { cn } from '../../lib/cn';
import { splitHighlight } from './highlight';
import { VariableHoverPopover } from './VariableHoverPopover';
import type { VariableSuggestion } from './suggestion';

export interface VariableFieldProps {
  value: string;
  onChange: (value: string) => void;
  suggestions: VariableSuggestion[];
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
  className?: string;
  /** Extra scope context (e.g. collectionId) for resolving/editing on hover. */
  variableContext?: VariableContext;
  'aria-label'?: string;
}

interface Token {
  start: number;
  query: string;
}

function tokenBeforeCaret(text: string, caret: number): Token | null {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf('{{');
  if (start === -1) return null;
  const inner = before.slice(start + 2);
  if (/[}\n]/.test(inner)) return null;
  if (!/^[\w.\- ]*$/.test(inner)) return null;
  return { start, query: inner.trimStart() };
}

const SCOPE_ABBR: Record<string, string> = {
  global: 'glb',
  workspace: 'ws',
  collection: 'col',
  folder: 'fld',
  request: 'req',
  workflow: 'wf',
  runtime: 'rt',
};

/** Whether a `{{token}}`'s key is among the known variables (for valid/unknown coloring). */
function isKnown(token: string, keys: Set<string>): boolean {
  const key = token.slice(2, -2).trim();
  return keys.has(key);
}

/**
 * Text input / textarea that (1) syntax-highlights `{{variable}}` tokens in a
 * distinct color and (2) offers an autocomplete dropdown of available scoped
 * variables. Highlighting uses a colored backdrop behind a transparent-text
 * field whose caret stays visible; the two are kept pixel-aligned by sharing the
 * same box styles and synchronized scrolling.
 */
export function VariableField({
  value,
  onChange,
  suggestions,
  multiline,
  rows,
  placeholder,
  className,
  variableContext,
  'aria-label': ariaLabel,
}: VariableFieldProps): JSX.Element {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState<Token | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const pendingCaret = useRef<number | null>(null);

  const [hovered, setHovered] = useState<{ name: string; left: number; bottom: number } | null>(
    null,
  );
  const closeTimer = useRef<number | null>(null);

  const scopeByKey = new Map(suggestions.map((s) => [s.key, s]));
  const cancelClose = (): void => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = (): void => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setHovered(null), 250);
  };

  const handleMouseMove = (e: React.MouseEvent): void => {
    const spans = backdropRef.current?.querySelectorAll<HTMLElement>('[data-var]');
    if (!spans) return;
    for (const span of spans) {
      const r = span.getBoundingClientRect();
      if (
        e.clientX >= r.left &&
        e.clientX <= r.right &&
        e.clientY >= r.top &&
        e.clientY <= r.bottom
      ) {
        cancelClose();
        const name = span.getAttribute('data-var') ?? '';
        if (hovered?.name !== name || hovered.left !== r.left) {
          setHovered({ name, left: r.left, bottom: r.bottom });
        }
        return;
      }
    }
    if (hovered) scheduleClose();
  };

  const known = new Set(suggestions.map((s) => s.key));
  const query = token?.query.toLowerCase() ?? '';
  const matches = open
    ? suggestions.filter((s) => s.key.toLowerCase().includes(query)).slice(0, 8)
    : [];

  useEffect(() => {
    if (pendingCaret.current !== null && ref.current) {
      const pos = pendingCaret.current;
      pendingCaret.current = null;
      ref.current.focus();
      ref.current.setSelectionRange(pos, pos);
    }
  });

  const recompute = (text: string, caret: number): void => {
    const t = tokenBeforeCaret(text, caret);
    setToken(t);
    setOpen(t !== null);
    setActiveIndex(0);
  };

  const syncScroll = (): void => {
    if (ref.current && backdropRef.current) {
      backdropRef.current.scrollTop = ref.current.scrollTop;
      backdropRef.current.scrollLeft = ref.current.scrollLeft;
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    onChange(e.target.value);
    recompute(e.target.value, e.target.selectionStart ?? e.target.value.length);
    requestAnimationFrame(syncScroll);
  };

  const insert = (key: string): void => {
    if (!token) return;
    const after = value.slice(token.start + 2 + token.query.length);
    const next = `${value.slice(0, token.start)}{{${key}}}${after}`;
    pendingCaret.current = token.start + 2 + key.length + 2;
    onChange(next);
    setOpen(false);
    setToken(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (!open || matches.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % matches.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + matches.length) % matches.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      insert(matches[activeIndex].key);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  const wrap = multiline ? 'whitespace-pre-wrap break-words' : 'whitespace-pre';
  // Backdrop shows the real text (with colored tokens); the field text is transparent.
  const backdropClass = cn(
    className,
    'pointer-events-none absolute inset-0 overflow-hidden text-fg',
    wrap,
  );
  const fieldStyle: React.CSSProperties = {
    color: 'transparent',
    background: 'transparent',
    caretColor: 'rgb(var(--color-fg))',
    position: 'relative',
  };

  const shared = {
    ref,
    value,
    placeholder,
    'aria-label': ariaLabel,
    onChange: handleChange,
    onKeyDown: handleKeyDown,
    onScroll: syncScroll,
    onBlur: () => window.setTimeout(() => setOpen(false), 120),
    className: cn(className, 'block bg-transparent'),
    style: fieldStyle,
  };

  const highlighted = splitHighlight(value).map((seg, i) =>
    seg.token ? (
      <span
        key={i}
        data-var={seg.text.slice(2, -2).trim()}
        className={cn('rounded-sm', isKnown(seg.text, known) ? 'text-accent' : 'text-warning')}
      >
        {seg.text}
      </span>
    ) : (
      <span key={i}>{seg.text}</span>
    ),
  );

  return (
    <div className="relative" onMouseMove={handleMouseMove} onMouseLeave={scheduleClose}>
      <div ref={backdropRef} aria-hidden="true" className={backdropClass} data-testid="vf-backdrop">
        {highlighted}
        {/* keep trailing newline visible in multiline */}
        {multiline && value.endsWith('\n') ? ' ' : null}
      </div>
      {multiline ? <textarea {...shared} rows={rows} /> : <input {...shared} type="text" />}

      {open && matches.length > 0 && (
        <ul
          data-testid="variable-suggestions"
          className="absolute left-0 top-full z-50 mt-1 max-h-56 w-72 overflow-auto rounded-md border border-border bg-surface shadow-lg"
        >
          {matches.map((s, i) => (
            <li key={`${s.scope}:${s.key}`}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  insert(s.key);
                }}
                className={cn(
                  'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs',
                  i === activeIndex ? 'bg-surface-2' : 'hover:bg-surface-2',
                )}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-mono">
                    {s.key}
                    {s.secret && <span className="ml-1 text-muted">(secret)</span>}
                  </span>
                  {s.source && (
                    <span className="truncate text-[10px] text-muted">
                      {s.source.nodeName} · {s.source.field}
                    </span>
                  )}
                </span>
                <span className="shrink-0 rounded bg-bg px-1 text-[10px] uppercase text-muted">
                  {s.source ? 'step' : (SCOPE_ABBR[s.scope] ?? s.scope)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {hovered && (
        <VariableHoverPopover
          name={hovered.name}
          anchor={{ left: hovered.left, bottom: hovered.bottom }}
          currentScope={scopeByKey.get(hovered.name)?.scope ?? null}
          secret={scopeByKey.get(hovered.name)?.secret ?? false}
          extraContext={variableContext}
          {...(scopeByKey.get(hovered.name)?.source
            ? { source: scopeByKey.get(hovered.name)!.source }
            : {})}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        />
      )}
    </div>
  );
}
