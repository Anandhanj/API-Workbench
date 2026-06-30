import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Save, Send, X } from 'lucide-react';
import type { HttpMethod } from '@shared/collection';
import type { ExecutionResponse } from '@shared/execution';
import type { ScriptRunResult } from '@shared/scripting';
import type { VariableContext } from '@shared/variable';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from '../../lib/cn';
import { usePersistentState } from '../../lib/use-persistent-state';
import { ResponseViewer } from './ResponseViewer';
import { KeyValueEditor } from './KeyValueEditor';
import { AuthEditor } from './AuthEditor';
import { BodyEditor } from './BodyEditor';
import { useExecute, useCancel } from './use-execution';
import { useRunScript, useRunPreScript } from './use-script';
import { ScriptEditor } from './ScriptEditor';
import { VariableField } from '../variables/VariableField';
import { RequestVariablesTab } from '../variables/RequestVariablesTab';
import { useVariableKeys } from '../variables/use-variable-keys';
import type { VariableSuggestion } from '../variables/suggestion';
import { useActiveSelection } from '../workspaces/use-workspaces';
import {
  applyParamsToUrl,
  buildExecutionRequest,
  defaultDraft,
  parseQueryParams,
  type KeyValue,
  type RequestDraft,
} from './build-request';

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
type Tab = 'params' | 'auth' | 'headers' | 'body' | 'variables' | 'scripts' | 'settings';

const METHOD_COLOR: Record<string, string> = {
  GET: 'text-success',
  POST: 'text-warning',
  PUT: 'text-accent',
  PATCH: 'text-violet-400',
  DELETE: 'text-danger',
};

const POST_PLACEHOLDER = `// Runs after a successful send. Type "workbench." for suggestions.
const data = workbench.response.json();
workbench.environment.set("token", data.token);      // workspace scope
workbench.collectionVariables.set("id", data.id);    // collection scope
workbench.globals.set("lastStatus", workbench.response.code);
workbench.test("status is 200", () => workbench.response.to.have.status(200));`;

const PRE_PLACEHOLDER = `// Runs before the request is sent. Type "workbench." for suggestions.
// Set variables here and reference them with {{name}} in the request.
workbench.environment.set("ts", String(Date.now()));
workbench.globals.set("nonce", Math.random().toString(36).slice(2));
console.log("sending", workbench.request.method, workbench.request.url);`;

export interface RequestEditorProps {
  initial?: RequestDraft;
  /** When provided, a Save button appears and calls this with the current draft. */
  onSave?: (draft: RequestDraft) => void;
  saving?: boolean;
  saved?: boolean;
  /** Collection/request the editor belongs to, for variable scoping in scripts. */
  scriptContext?: { collectionId?: string; requestId?: string };
  /** Extra suggestions (e.g. upstream-step variables) merged ahead of stored vars. */
  extraSuggestions?: VariableSuggestion[];
  /** Observes the live draft (debounced) — used to drive the variables-used panel. */
  onDraftChange?: (draft: RequestDraft) => void;
}

/** A full REST request editor: method/URL/Send plus tabbed params, auth, headers, body, scripts, and settings, with a response panel. */
export function RequestEditor({
  initial,
  onSave,
  saving,
  saved,
  scriptContext,
  extraSuggestions,
  onDraftChange,
}: RequestEditorProps): JSX.Element {
  const [draft, setDraft] = useState<RequestDraft>(
    initial ?? defaultDraft('GET', 'https://httpbin.org/get'),
  );
  const [tab, setTab] = useState<Tab>('params');
  const [scriptPhase, setScriptPhase] = useState<'pre' | 'post'>('pre');
  const [history, setHistory] = useState<{ at: number; response: ExecutionResponse }[]>([]);
  const [viewIndex, setViewIndex] = useState(0);
  const [respHeight, setRespHeight] = usePersistentState('awb.runner.responseHeight', 320);
  const execId = useRef<string | null>(null);

  const execute = useExecute();
  const cancel = useCancel();
  const runScript = useRunScript();
  const runPreScript = useRunPreScript();
  const storedKeys = useVariableKeys(scriptContext ?? {});
  const suggestions = useMemo<VariableSuggestion[]>(() => {
    const extra = extraSuggestions ?? [];
    const seen = new Set(extra.map((s) => s.key));
    return [...extra, ...storedKeys.filter((k) => !seen.has(k.key))];
  }, [extraSuggestions, storedKeys]);
  const active = useActiveSelection();
  const qc = useQueryClient();

  const patch = (p: Partial<RequestDraft>): void => setDraft((d) => ({ ...d, ...p }));

  // Report the live draft upward (debounced) so a parent can show variables in use.
  useEffect(() => {
    if (!onDraftChange) return;
    const t = setTimeout(() => onDraftChange(draft), 250);
    return () => clearTimeout(t);
  }, [draft, onDraftChange]);

  const onUrlChange = (url: string): void =>
    setDraft((d) => ({ ...d, url, params: parseQueryParams(url) }));
  const onParamsChange = (rows: KeyValue[]): void =>
    setDraft((d) => ({ ...d, params: rows, url: applyParamsToUrl(d.url, rows) }));

  const activeCount = (rows: RequestDraft['headers']): number =>
    rows.filter((r) => r.enabled && r.key.trim()).length;

  const scriptCtx = (): VariableContext => ({
    ...(active.data?.workspaceId ? { workspaceId: active.data.workspaceId } : {}),
    ...(scriptContext?.collectionId ? { collectionId: scriptContext.collectionId } : {}),
    ...(scriptContext?.requestId ? { requestId: scriptContext.requestId } : {}),
  });

  const invalidateVars = (): void => {
    void qc.invalidateQueries({ queryKey: ['variable'] });
    void qc.invalidateQueries({ queryKey: ['variables'] });
  };

  const runScriptAgainst = (response: Parameters<typeof runScript.mutate>[0]['response']): void => {
    if (!draft.postResponseScript.trim()) return;
    runScript.mutate(
      { script: draft.postResponseScript, response, context: scriptCtx() },
      { onSuccess: invalidateVars },
    );
  };

  /** Runs the pre-request script (manually or before send) against the current request. */
  const runPreAgainst = async (): Promise<void> => {
    if (!draft.preRequestScript.trim()) return;
    const req = buildExecutionRequest(draft);
    await runPreScript.mutateAsync({
      script: draft.preRequestScript,
      request: { method: req.method, url: req.url, headers: req.headers },
      context: scriptCtx(),
    });
    invalidateVars();
  };

  const send = async (): Promise<void> => {
    const id = crypto.randomUUID();
    execId.current = id;
    runPreScript.reset();
    runScript.reset();
    // Pre-request script first — it may set variables the request resolves.
    await runPreAgainst();
    const response = await execute.mutateAsync(buildExecutionRequest(draft, id, scriptCtx()));
    setHistory((prev) => [{ at: Date.now(), response }, ...prev].slice(0, 25));
    setViewIndex(0);
    runScriptAgainst(response);
  };

  const stop = (): void => {
    if (execId.current) cancel.mutate(execId.current);
  };

  // Vertical drag-resize of the response area (persisted).
  const startRespResize = (e: React.MouseEvent): void => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = respHeight;
    const move = (ev: MouseEvent): void =>
      setRespHeight(Math.min(900, Math.max(140, startH + (ev.clientY - startY))));
    const up = (): void => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const shownResponse =
    history.length > 0
      ? history[Math.min(viewIndex, history.length - 1)].response
      : (execute.data ?? null);

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: 'params', label: 'Params', badge: activeCount(draft.params) },
    { id: 'auth', label: 'Authorization' },
    { id: 'headers', label: 'Headers', badge: activeCount(draft.headers) },
    { id: 'body', label: 'Body' },
    ...(scriptContext?.requestId ? [{ id: 'variables' as Tab, label: 'Variables' }] : []),
    {
      id: 'scripts',
      label: 'Scripts',
      badge: draft.preRequestScript.trim() || draft.postResponseScript.trim() ? 1 : 0,
    },
    { id: 'settings', label: 'Settings' },
  ];

  return (
    <div className="flex h-full flex-col">
      {/* Address bar */}
      <div className="flex gap-2">
        <select
          value={draft.method}
          onChange={(e) => patch({ method: e.target.value as HttpMethod })}
          aria-label="HTTP method"
          className={cn(
            'rounded-md border border-border bg-surface px-3 py-2 text-sm font-bold',
            METHOD_COLOR[draft.method],
          )}
        >
          {METHODS.map((m) => (
            <option key={m} value={m} className="text-fg">
              {m}
            </option>
          ))}
        </select>
        <div className="min-w-0 flex-1">
          <VariableField
            value={draft.url}
            onChange={onUrlChange}
            suggestions={suggestions}
            {...(scriptContext ? { variableContext: scriptContext } : {})}
            aria-label="Request URL"
            placeholder="{{baseUrl}}/path  — supports variables"
            className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm"
          />
        </div>
        {execute.isPending ? (
          <button
            type="button"
            onClick={stop}
            className="flex items-center gap-1.5 rounded-md border border-border px-4 py-2 text-sm"
          >
            <X size={15} /> Cancel
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void send()}
            className="flex items-center gap-1.5 rounded-md bg-accent px-5 py-2 text-sm font-semibold text-accent-fg"
          >
            <Send size={15} /> Send
          </button>
        )}
        {onSave && (
          <button
            type="button"
            onClick={() => onSave(draft)}
            disabled={saving}
            aria-label="Save request"
            className="flex items-center gap-1.5 rounded-md border border-border px-4 py-2 text-sm hover:bg-surface-2 disabled:opacity-50"
          >
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
            {saved ? 'Saved' : 'Save'}
          </button>
        )}
      </div>

      {/* Tab bar */}
      <div className="mt-3 flex gap-1 border-b border-border text-sm">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              'border-b-2 px-3 py-2',
              tab === t.id
                ? 'border-accent text-fg'
                : 'border-transparent text-muted hover:text-fg',
            )}
          >
            {t.label}
            {t.badge ? <span className="ml-1 text-xs text-accent">●</span> : null}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="mt-3">
        {tab === 'params' && (
          <div className="rounded-md border border-border">
            <KeyValueEditor
              rows={draft.params}
              onChange={onParamsChange}
              suggestions={suggestions}
            />
          </div>
        )}
        {tab === 'headers' && (
          <div className="rounded-md border border-border">
            <KeyValueEditor
              rows={draft.headers}
              onChange={(rows) => patch({ headers: rows })}
              keyPlaceholder="Header"
              suggestions={suggestions}
            />
          </div>
        )}
        {tab === 'variables' && scriptContext?.requestId && (
          <RequestVariablesTab requestId={scriptContext.requestId} />
        )}
        {tab === 'auth' && (
          <AuthEditor
            auth={draft.auth}
            onChange={(auth) => patch({ auth })}
            suggestions={suggestions}
          />
        )}
        {tab === 'body' && (
          <BodyEditor
            mode={draft.bodyMode}
            rawType={draft.rawType}
            rawBody={draft.rawBody}
            formFields={draft.formFields}
            binaryBase64={draft.binaryBase64}
            binaryFileName={draft.binaryFileName}
            suggestions={suggestions}
            onChange={patch}
          />
        )}
        {tab === 'scripts' && (
          <div className="flex gap-4">
            <div className="w-36 shrink-0 space-y-1">
              {(['pre', 'post'] as const).map((p) => {
                const has = (
                  p === 'pre' ? draft.preRequestScript : draft.postResponseScript
                ).trim();
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setScriptPhase(p)}
                    className={cn(
                      'block w-full rounded-md px-3 py-1.5 text-left text-sm',
                      scriptPhase === p ? 'bg-surface-2 text-fg' : 'text-muted hover:text-fg',
                    )}
                  >
                    {p === 'pre' ? 'Pre-request' : 'Post-response'}
                    {has ? <span className="ml-1 text-xs text-accent">●</span> : null}
                  </button>
                );
              })}
            </div>

            <div className="min-w-0 flex-1 space-y-2">
              {scriptPhase === 'pre' ? (
                <>
                  <p className="text-xs text-muted">
                    Runs <strong>before</strong> the request is sent. Set variables with{' '}
                    <code className="text-accent">
                      workbench.environment/globals/collectionVariables.set()
                    </code>{' '}
                    and read the outgoing request via{' '}
                    <code className="text-accent">workbench.request</code>.
                  </p>
                  <ScriptEditor
                    value={draft.preRequestScript}
                    onChange={(v) => patch({ preRequestScript: v })}
                    ariaLabel="Pre-request script"
                    placeholder={PRE_PLACEHOLDER}
                  />
                  <button
                    type="button"
                    onClick={() => void runPreAgainst()}
                    disabled={!draft.preRequestScript.trim() || runPreScript.isPending}
                    className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-2 disabled:opacity-50"
                  >
                    Run pre-request script
                  </button>
                  <ScriptResults result={runPreScript.data ?? null} />
                </>
              ) : (
                <>
                  <p className="text-xs text-muted">
                    Runs <strong>after</strong> a successful send. Read{' '}
                    <code className="text-accent">workbench.response</code> and write variables with{' '}
                    <code className="text-accent">
                      workbench.environment/globals/collectionVariables.set()
                    </code>
                    .
                  </p>
                  <ScriptEditor
                    value={draft.postResponseScript}
                    onChange={(v) => patch({ postResponseScript: v })}
                    ariaLabel="Post-response script"
                    placeholder={POST_PLACEHOLDER}
                  />
                  <button
                    type="button"
                    onClick={() => execute.data && runScriptAgainst(execute.data)}
                    disabled={!execute.data || runScript.isPending}
                    className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-2 disabled:opacity-50"
                  >
                    Run against last response
                  </button>
                  <ScriptResults result={runScript.data ?? null} />
                </>
              )}
            </div>
          </div>
        )}
        {tab === 'settings' && (
          <div className="grid max-w-md grid-cols-2 items-center gap-3 text-sm">
            <label htmlFor="timeout">Timeout (ms)</label>
            <input
              id="timeout"
              type="number"
              value={draft.options.timeoutMs}
              onChange={(e) =>
                patch({ options: { ...draft.options, timeoutMs: Number(e.target.value) } })
              }
              className="rounded-md border border-border bg-bg px-3 py-1.5"
            />
            <label htmlFor="retries">Max retries</label>
            <input
              id="retries"
              type="number"
              value={draft.options.maxRetries}
              onChange={(e) =>
                patch({ options: { ...draft.options, maxRetries: Number(e.target.value) } })
              }
              className="rounded-md border border-border bg-bg px-3 py-1.5"
            />
            <label htmlFor="redirects">Follow redirects</label>
            <input
              id="redirects"
              type="checkbox"
              checked={draft.options.followRedirects}
              onChange={(e) =>
                patch({ options: { ...draft.options, followRedirects: e.target.checked } })
              }
            />
          </div>
        )}
      </div>

      {/* Response — dedicated, vertically resizable area with a history selector */}
      <div className="mt-4">
        {execute.error instanceof Error && (
          <p className="mb-2 text-sm text-danger">{execute.error.message}</p>
        )}

        <div className="mb-1 flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-muted">
            Response
            {execute.isPending && <Loader2 size={12} className="animate-spin" />}
          </span>
          {history.length > 0 && (
            <select
              value={viewIndex}
              onChange={(e) => setViewIndex(Number(e.target.value))}
              aria-label="Response history"
              className="rounded-md border border-border bg-surface px-2 py-1 text-xs"
            >
              {history.map((h, i) => (
                <option key={h.at} value={i}>
                  {new Date(h.at).toLocaleTimeString()} · {h.response.status}
                  {i === 0 ? ' (latest)' : ''}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Drag handle to resize the response area */}
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize response area"
          onMouseDown={startRespResize}
          className="group flex h-2 cursor-row-resize items-center justify-center"
        >
          <div className="h-0.5 w-10 rounded bg-border group-hover:bg-accent" />
        </div>

        <div
          style={{ height: respHeight }}
          className="overflow-auto rounded-md border border-border"
        >
          <ResponseViewer response={shownResponse} loading={execute.isPending} />
        </div>
      </div>
    </div>
  );
}

/** Renders console logs, pm.test() results, and variable changes from a script run. */
function ScriptResults({ result }: { result: ScriptRunResult | null }): JSX.Element | null {
  if (!result) return null;
  return (
    <div className="space-y-2 rounded-md border border-border bg-surface p-3 text-xs">
      {result.error && <p className="text-danger">Script error: {result.error}</p>}

      {result.tests.length > 0 && (
        <div className="space-y-1">
          {result.tests.map((t, i) => (
            <div key={i} className={t.passed ? 'text-success' : 'text-danger'}>
              {t.passed ? '✓' : '✗'} {t.name}
              {t.error ? <span className="text-muted"> — {t.error}</span> : null}
            </div>
          ))}
        </div>
      )}

      {result.variables.length > 0 && (
        <div>
          <p className="mb-1 font-medium text-muted">Variables</p>
          {result.variables.map((v, i) => (
            <div key={i} className="font-mono">
              <span className="text-accent">{v.scope}</span>.{v.action === 'set' ? 'set' : 'unset'}(
              {v.key}
              {v.action === 'set' && v.value !== undefined ? `, ${v.value}` : ''})
            </div>
          ))}
        </div>
      )}

      {result.logs.length > 0 && (
        <div>
          <p className="mb-1 font-medium text-muted">Console</p>
          <pre className="whitespace-pre-wrap font-mono text-muted">{result.logs.join('\n')}</pre>
        </div>
      )}

      {!result.error &&
        result.tests.length === 0 &&
        result.variables.length === 0 &&
        result.logs.length === 0 && <p className="text-muted">Script ran with no output.</p>}
    </div>
  );
}
