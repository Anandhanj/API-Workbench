import { useState } from 'react';
import { ChevronDown, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { ExecutionResponse } from '@shared/execution';
import type {
  ExtractRule,
  NodePolicy,
  RequestNodeConfig,
  UserInputField,
  Workflow,
  WorkflowNode,
} from '@shared/workflow';
import { extractFromResponse } from '@shared/extract';
import { Modal } from '../../components/menu/Modal';
import { RequestEditor } from '../runner/RequestEditor';
import type { FlowNode } from './graph-mapping';
import { NODE_META } from './node-meta';
import type { ProjectRequestRef } from './use-project-requests';
import { draftToNodeConfig, nodeConfigToDraft } from './request-node-draft';
import type { VariableContext } from '@shared/variable';
import { VariableField } from '../variables/VariableField';
import type { VariableSuggestion } from '../variables/suggestion';

const fieldClass =
  'w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-sm outline-none focus:border-accent';
const smallField =
  'rounded-md border border-border bg-bg px-2 py-1 text-xs outline-none focus:border-accent';
const labelClass = 'block text-[11px] font-medium uppercase tracking-wide text-muted';

const METHOD_COLOR: Record<string, string> = {
  GET: 'text-success',
  POST: 'text-warning',
  PUT: 'text-accent',
  PATCH: 'text-violet-400',
  DELETE: 'text-danger',
};
const methodColor = (m: string): string => METHOD_COLOR[m] ?? 'text-muted';

interface NodeInspectorProps {
  node: FlowNode | null;
  workflows: Workflow[];
  /** The selected node's response from the last run, used for live preview. */
  lastResponse?: ExecutionResponse;
  /** Requests across the project's collections, for the request-node picker. */
  projectRequests?: ProjectRequestRef[];
  /** Imports a collection request's definition into the selected request node. */
  onImportRequest?: (requestId: string) => void;
  /** Variables offered for {{ }} autocomplete (stored vars + upstream-step vars). */
  suggestions?: VariableSuggestion[];
  /** Scope context (workspace/collection) for resolving variable values on hover. */
  variableContext?: VariableContext;
  /** Upstream-step variables, forwarded into the request node editor. */
  flowSuggestions?: VariableSuggestion[];
  onRename: (name: string) => void;
  onConfig: (config: WorkflowNode['config']) => void;
  onPolicy: (policy: NodePolicy | undefined) => void;
  onDelete: () => void;
}

export function NodeInspector({
  node,
  workflows,
  lastResponse,
  projectRequests = [],
  onImportRequest,
  suggestions = [],
  variableContext,
  flowSuggestions = [],
  onRename,
  onConfig,
  onPolicy,
  onDelete,
}: NodeInspectorProps): JSX.Element {
  const [editorOpen, setEditorOpen] = useState(false);
  if (!node) {
    return (
      <div className="p-4 text-sm text-muted">
        Select a node to edit it, or drag one in from the palette.
      </div>
    );
  }
  const kind = node.data.kind;
  const meta = NODE_META[kind];
  const Icon = meta.icon;
  const config = node.data.config as Record<string, unknown>;
  const set = (patch: Record<string, unknown>): void =>
    onConfig({ ...config, ...patch } as WorkflowNode['config']);

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <span className={`flex h-7 w-7 items-center justify-center rounded ${meta.accent}`}>
          <Icon size={15} />
        </span>
        <span className="text-sm font-semibold">{meta.label}</span>
      </div>

      {kind !== 'start' && kind !== 'end' && (
        <Field label="Name" id="node-name">
          <input
            id="node-name"
            value={node.data.name}
            onChange={(e) => onRename(e.target.value)}
            className={fieldClass}
          />
        </Field>
      )}

      {kind === 'request' && onImportRequest && (
        <CollectionLink
          requestId={config.requestId as string | undefined}
          requests={projectRequests}
          onImport={onImportRequest}
          onUnlink={() => set({ requestId: undefined })}
        />
      )}

      {kind === 'request' && (
        <>
          <div>
            <span className={labelClass}>Request</span>
            <button
              type="button"
              onClick={() => setEditorOpen(true)}
              className="mt-1 flex w-full items-center justify-between gap-2 rounded-md border border-border bg-bg px-2.5 py-1.5 text-sm hover:bg-surface-2"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="font-mono text-xs font-semibold text-accent">
                  {(config.method as string) ?? 'GET'}
                </span>
                <span className="truncate text-muted">
                  {(config.url as string) || 'Configure…'}
                </span>
              </span>
              <SlidersHorizontal size={14} className="shrink-0 text-muted" />
            </button>
          </div>
          <ExtractEditor
            rules={(config.extract as ExtractRule[]) ?? []}
            response={lastResponse}
            onChange={(extract) => set({ extract })}
          />
        </>
      )}

      {kind === 'set-variable' && (
        <>
          <Field label="Variable name" id="node-key">
            <input
              id="node-key"
              value={(config.key as string) ?? ''}
              onChange={(e) => set({ key: e.target.value })}
              className={fieldClass}
            />
          </Field>
          <Field label="Value (template)" id="node-value">
            <VariableField
              value={(config.value as string) ?? ''}
              onChange={(value) => set({ value })}
              suggestions={suggestions}
              variableContext={variableContext}
              aria-label="Value (template)"
              placeholder="{{token}}"
              className={fieldClass}
            />
          </Field>
        </>
      )}

      {kind === 'transform' && (
        <>
          <Field label="Variable" id="t-var">
            <input
              id="t-var"
              value={(config.variable as string) ?? ''}
              onChange={(e) => set({ variable: e.target.value })}
              className={fieldClass}
            />
          </Field>
          <Field label="Engine" id="t-engine">
            <select
              id="t-engine"
              value={(config.engine as string) ?? 'template'}
              onChange={(e) => set({ engine: e.target.value })}
              className={fieldClass}
            >
              <option value="template">Template ({'{{ }}'})</option>
              <option value="jsonpath">JSONPath</option>
              <option value="jmespath">JMESPath</option>
              <option value="regex">Regex</option>
            </select>
          </Field>
          {config.engine !== 'template' && (
            <Field label="Input (template → source text)" id="t-input">
              <VariableField
                value={(config.input as string) ?? ''}
                onChange={(input) => set({ input })}
                suggestions={suggestions}
                variableContext={variableContext}
                aria-label="Input (template)"
                placeholder="{{responseBody}}"
                className={fieldClass}
              />
            </Field>
          )}
          <Field label={config.engine === 'template' ? 'Template' : 'Expression'} id="t-expr">
            {config.engine === 'template' ? (
              <VariableField
                value={(config.expression as string) ?? ''}
                onChange={(expression) => set({ expression })}
                suggestions={suggestions}
                variableContext={variableContext}
                aria-label="Template"
                placeholder={exprPlaceholder(config.engine as string)}
                className={fieldClass}
              />
            ) : (
              <input
                id="t-expr"
                value={(config.expression as string) ?? ''}
                onChange={(e) => set({ expression: e.target.value })}
                placeholder={exprPlaceholder(config.engine as string)}
                className={fieldClass}
              />
            )}
          </Field>
        </>
      )}

      {kind === 'delay' && (
        <Field label="Delay (milliseconds)" id="node-ms">
          <input
            id="node-ms"
            type="number"
            min={0}
            max={600000}
            value={Number(config.ms ?? 0)}
            onChange={(e) => set({ ms: clamp(e.target.value, 0, 600000) })}
            className={fieldClass}
          />
        </Field>
      )}

      {kind === 'condition' && (
        <Field label="Expression" id="node-expr">
          <VariableField
            value={(config.expression as string) ?? ''}
            onChange={(expression) => set({ expression })}
            suggestions={suggestions}
            variableContext={variableContext}
            aria-label="Expression"
            placeholder="{{status}} == 200"
            className={fieldClass}
          />
          <ExpressionHelp />
        </Field>
      )}

      {kind === 'switch' && (
        <>
          <Field label="Value (template)" id="node-switch-value">
            <VariableField
              value={(config.value as string) ?? ''}
              onChange={(value) => set({ value })}
              suggestions={suggestions}
              variableContext={variableContext}
              aria-label="Switch value (template)"
              placeholder="{{plan}}"
              className={fieldClass}
            />
          </Field>
          <Field label="Cases (comma-separated)" id="node-cases">
            <input
              id="node-cases"
              value={((config.cases as string[]) ?? []).join(', ')}
              onChange={(e) =>
                set({
                  cases: e.target.value
                    .split(',')
                    .map((c) => c.trim())
                    .filter(Boolean),
                })
              }
              placeholder="free, pro, enterprise"
              className={fieldClass}
            />
          </Field>
          <p className="text-[11px] text-muted">
            An unmatched value follows the <code>default</code> handle.
          </p>
        </>
      )}

      {kind === 'loop' && (
        <>
          <Field label="Mode" id="node-loop-mode">
            <select
              id="node-loop-mode"
              value={(config.mode as string) ?? 'times'}
              onChange={(e) =>
                onConfig(
                  e.target.value === 'times'
                    ? { mode: 'times', times: 3 }
                    : { mode: 'while', condition: '', maxIterations: 5 },
                )
              }
              className={fieldClass}
            >
              <option value="times">Repeat N times</option>
              <option value="while">While condition</option>
            </select>
          </Field>
          {config.mode === 'while' ? (
            <>
              <Field label="Condition (truthy = continue)" id="node-loop-cond">
                <VariableField
                  value={(config.condition as string) ?? ''}
                  onChange={(condition) => set({ condition })}
                  suggestions={suggestions}
                  variableContext={variableContext}
                  aria-label="Loop condition"
                  placeholder="{{count}} < 10"
                  className={fieldClass}
                />
                <ExpressionHelp />
              </Field>
              <Field label="Max iterations" id="node-loop-max">
                <input
                  id="node-loop-max"
                  type="number"
                  min={1}
                  max={10000}
                  value={Number(config.maxIterations ?? 5)}
                  onChange={(e) => set({ maxIterations: clamp(e.target.value, 1, 10000) })}
                  className={fieldClass}
                />
              </Field>
            </>
          ) : (
            <Field label="Times" id="node-loop-times">
              <input
                id="node-loop-times"
                type="number"
                min={1}
                max={10000}
                value={Number(config.times ?? 1)}
                onChange={(e) => set({ times: clamp(e.target.value, 1, 10000) })}
                className={fieldClass}
              />
            </Field>
          )}
        </>
      )}

      {kind === 'sub-workflow' && (
        <Field label="Workflow" id="node-sub">
          <select
            id="node-sub"
            value={(config.workflowId as string) ?? ''}
            onChange={(e) => set({ workflowId: e.target.value })}
            className={fieldClass}
          >
            <option value="">Select a workflow…</option>
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      {kind === 'user-input' && (
        <>
          <Field label="Prompt message" id="node-input-message">
            <textarea
              id="node-input-message"
              value={(config.message as string) ?? ''}
              onChange={(e) => set({ message: e.target.value })}
              rows={2}
              placeholder="Shown to the user when the run pauses"
              className={fieldClass}
            />
          </Field>
          <UserInputFieldsEditor
            fields={(config.fields as UserInputField[]) ?? []}
            onChange={(fields) => set({ fields })}
            suggestions={suggestions}
            variableContext={variableContext}
          />
        </>
      )}

      {kind !== 'start' && kind !== 'end' && (
        <ReliabilitySection policy={node.data.policy} onPolicy={onPolicy} />
      )}

      <div className="mt-auto">
        <button
          type="button"
          onClick={onDelete}
          disabled={kind === 'start'}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-rose-500/40 px-3 py-1.5 text-sm text-rose-400 hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Trash2 size={14} /> Delete node
        </button>
      </div>

      {kind === 'request' && editorOpen && (
        <Modal
          title={`Configure: ${node.data.name || 'Request'}`}
          onClose={() => setEditorOpen(false)}
          maxWidth="max-w-5xl"
        >
          <div className="h-[70vh]">
            <RequestEditor
              initial={nodeConfigToDraft(node.data.config as RequestNodeConfig)}
              extraSuggestions={flowSuggestions}
              {...(config.requestId
                ? { scriptContext: { requestId: config.requestId as string } }
                : {})}
              onSave={(draft) => {
                onConfig(
                  draftToNodeConfig(
                    draft,
                    (config.extract as ExtractRule[]) ?? [],
                    config.requestId as string | undefined,
                  ),
                );
                setEditorOpen(false);
              }}
            />
          </div>
        </Modal>
      )}
    </div>
  );
}

function ExtractEditor({
  rules,
  response,
  onChange,
}: {
  rules: ExtractRule[];
  response?: ExecutionResponse;
  onChange: (rules: ExtractRule[]) => void;
}): JSX.Element {
  const update = (i: number, patch: Partial<ExtractRule>): void =>
    onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const add = (): void =>
    onChange([...rules, { variable: '', source: 'body', engine: 'jsonpath', expression: '' }]);
  const remove = (i: number): void => onChange(rules.filter((_, j) => j !== i));

  return (
    <details open className="rounded-md border border-border">
      <summary className="cursor-pointer px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
        Extract (response → variables)
      </summary>
      <div className="flex flex-col gap-2 border-t border-border p-2.5">
        {rules.length === 0 && <p className="text-[11px] text-muted">No mappings yet.</p>}
        {rules.map((rule, i) => {
          const preview = response ? extractFromResponse(response, rule) : null;
          return (
            <div key={i} className="flex flex-col gap-1 rounded-md border border-border p-1.5">
              <div className="flex flex-wrap items-center gap-1">
                <input
                  value={rule.variable}
                  onChange={(e) => update(i, { variable: e.target.value })}
                  placeholder="variable"
                  className={`${smallField} min-w-[5rem] flex-1`}
                />
                <select
                  value={rule.source}
                  onChange={(e) => update(i, { source: e.target.value as ExtractRule['source'] })}
                  className={`${smallField} shrink-0`}
                >
                  <option value="body">body</option>
                  <option value="header">header</option>
                  <option value="status">status</option>
                </select>
                {rule.source === 'body' && (
                  <select
                    value={rule.engine}
                    onChange={(e) => update(i, { engine: e.target.value as ExtractRule['engine'] })}
                    className={`${smallField} shrink-0`}
                  >
                    <option value="jsonpath">JSONPath</option>
                    <option value="jmespath">JMESPath</option>
                    <option value="regex">regex</option>
                  </select>
                )}
                <button
                  type="button"
                  aria-label="Remove mapping"
                  onClick={() => remove(i)}
                  className="ml-auto shrink-0 text-muted hover:text-rose-400"
                >
                  <Trash2 size={13} />
                </button>
              </div>
              {rule.source !== 'status' && (
                <input
                  value={rule.expression}
                  onChange={(e) => update(i, { expression: e.target.value })}
                  placeholder={
                    rule.source === 'header' ? 'Header-Name' : exprPlaceholder(rule.engine)
                  }
                  className={`${smallField} w-full font-mono`}
                />
              )}
              {preview !== null && (
                <p className="truncate text-[10px] text-muted">
                  preview: <span className="font-mono text-fg">{preview || '∅'}</span>
                </p>
              )}
            </div>
          );
        })}
        <button
          type="button"
          onClick={add}
          className="flex items-center justify-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-surface-2"
        >
          <Plus size={12} /> Add mapping
        </button>
      </div>
    </details>
  );
}

function UserInputFieldsEditor({
  fields,
  onChange,
  suggestions,
  variableContext,
}: {
  fields: UserInputField[];
  onChange: (fields: UserInputField[]) => void;
  suggestions: VariableSuggestion[];
  variableContext?: VariableContext;
}): JSX.Element {
  const update = (i: number, patch: Partial<UserInputField>): void =>
    onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const add = (): void =>
    onChange([...fields, { label: '', variable: '', default: '', secret: false }]);
  const remove = (i: number): void => onChange(fields.filter((_, j) => j !== i));

  return (
    <details open className="rounded-md border border-border">
      <summary className="cursor-pointer px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
        Fields (prompt → variables)
      </summary>
      <div className="flex flex-col gap-2 border-t border-border p-2.5">
        {fields.length === 0 && (
          <p className="text-[11px] text-muted">
            No fields — the node is a Continue/Cancel checkpoint.
          </p>
        )}
        {fields.map((field, i) => (
          <div key={i} className="flex flex-col gap-1 rounded-md border border-border p-1.5">
            <div className="flex items-center gap-1">
              <input
                value={field.variable}
                onChange={(e) => update(i, { variable: e.target.value })}
                placeholder="variable"
                className={`${smallField} w-28 font-mono`}
              />
              <input
                value={field.label}
                onChange={(e) => update(i, { label: e.target.value })}
                placeholder="Label"
                className={`${smallField} min-w-0 flex-1`}
              />
              <button
                type="button"
                aria-label="Remove field"
                onClick={() => remove(i)}
                className="ml-auto text-muted hover:text-rose-400"
              >
                <Trash2 size={13} />
              </button>
            </div>
            <VariableField
              value={field.default}
              onChange={(value) => update(i, { default: value })}
              suggestions={suggestions}
              variableContext={variableContext}
              aria-label="Default (template)"
              placeholder="Default (template, e.g. {{token}})"
              className={`${smallField} w-full font-mono`}
            />
            <label className="flex items-center gap-1.5 text-[11px] text-muted">
              <input
                type="checkbox"
                checked={field.secret}
                onChange={(e) => update(i, { secret: e.target.checked })}
              />
              Mask input (secret)
            </label>
          </div>
        ))}
        <button
          type="button"
          onClick={add}
          className="flex items-center justify-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-surface-2"
        >
          <Plus size={12} /> Add field
        </button>
      </div>
    </details>
  );
}

function ReliabilitySection({
  policy,
  onPolicy,
}: {
  policy: NodePolicy | undefined;
  onPolicy: (policy: NodePolicy | undefined) => void;
}): JSX.Element {
  const p = policy ?? {};
  const patch = (next: Partial<NodePolicy>): void => {
    const merged: NodePolicy = { ...p, ...next };
    const cleaned = Object.fromEntries(
      Object.entries(merged).filter(
        ([, v]) => v !== undefined && !(typeof v === 'number' && Number.isNaN(v)),
      ),
    ) as NodePolicy;
    onPolicy(Object.keys(cleaned).length ? cleaned : undefined);
  };
  return (
    <details className="rounded-md border border-border">
      <summary className="cursor-pointer px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
        Reliability
      </summary>
      <div className="flex flex-col gap-2 border-t border-border p-2.5">
        <Field label="Retries" id="pol-retries">
          <input
            id="pol-retries"
            type="number"
            min={0}
            max={10}
            value={Number(p.retries ?? 0)}
            onChange={(e) => patch({ retries: clamp(e.target.value, 0, 10) })}
            className={fieldClass}
          />
        </Field>
        <Field label="Timeout (ms, 0 = none)" id="pol-timeout">
          <input
            id="pol-timeout"
            type="number"
            min={0}
            max={600000}
            value={Number(p.timeoutMs ?? 0)}
            onChange={(e) => patch({ timeoutMs: clamp(e.target.value, 0, 600000) })}
            className={fieldClass}
          />
        </Field>
        <Field label="On error" id="pol-onerror">
          <select
            id="pol-onerror"
            value={p.onError ?? 'fail'}
            onChange={(e) => patch({ onError: e.target.value as NodePolicy['onError'] })}
            className={fieldClass}
          >
            <option value="fail">Fail the run</option>
            <option value="continue">Continue</option>
            <option value="route">Route to error edge</option>
          </select>
        </Field>
      </div>
    </details>
  );
}

function CollectionLink({
  requestId,
  requests,
  onImport,
  onUnlink,
}: {
  requestId: string | undefined;
  requests: ProjectRequestRef[];
  onImport: (id: string) => void;
  onUnlink: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const linked = requestId ? requests.find((r) => r.id === requestId) : undefined;
  const groups = new Map<string, ProjectRequestRef[]>();
  for (const r of requests) {
    const list = groups.get(r.collectionName) ?? [];
    list.push(r);
    groups.set(r.collectionName, list);
  }
  return (
    <div className="rounded-md border border-border p-2.5">
      <span className={labelClass}>Load from collection</span>
      <div className="relative mt-1">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={cn(fieldClass, 'flex items-center justify-between gap-2')}
        >
          <span className="truncate text-muted">
            {requests.length ? 'Choose a request…' : 'No collection requests'}
          </span>
          <ChevronDown size={14} className="shrink-0 text-muted" />
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
            <div className="absolute left-0 right-0 z-20 mt-1 max-h-64 overflow-auto rounded-md border border-border bg-surface shadow-lg">
              {requests.length === 0 && (
                <p className="px-2.5 py-2 text-xs text-muted">No collection requests.</p>
              )}
              {[...groups.entries()].map(([collection, reqs]) => (
                <div key={collection}>
                  <div className="sticky top-0 bg-surface-2 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
                    {collection}
                  </div>
                  {reqs.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => {
                        onImport(r.id);
                        setOpen(false);
                      }}
                      className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-surface-2"
                    >
                      <span
                        className={cn(
                          'w-12 shrink-0 font-mono text-[10px] font-bold',
                          methodColor(r.method),
                        )}
                      >
                        {r.method}
                      </span>
                      <span className="truncate">{r.name}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      {requestId && (
        <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px]">
          <span className="min-w-0 truncate text-muted">
            Linked:{' '}
            <span className="text-fg">
              {linked ? `${linked.collectionName} / ${linked.name}` : 'source removed'}
            </span>
          </span>
          <span className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => onImport(requestId)}
              disabled={!linked}
              className="text-accent hover:underline disabled:opacity-40"
            >
              Re-sync
            </button>
            <button type="button" onClick={onUnlink} className="text-muted hover:text-rose-400">
              Unlink
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  id,
  children,
}: {
  label: string;
  id: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div>
      <label className={labelClass} htmlFor={id}>
        {label}
      </label>
      {children}
    </div>
  );
}

function ExpressionHelp(): JSX.Element {
  return (
    <p className="mt-1 text-[11px] leading-snug text-muted">
      Compare with <code>== != &gt; &lt; &gt;= &lt;=</code>, or <code>contains</code>,{' '}
      <code>startsWith</code>, <code>endsWith</code>, <code>matches</code>; combine with{' '}
      <code>&amp;&amp;</code> / <code>||</code>. A bare value is true unless empty/false/0.
    </p>
  );
}

function exprPlaceholder(engine: string): string {
  if (engine === 'jmespath') return 'data.items[0].id';
  if (engine === 'regex') return 'id=(\\d+)';
  if (engine === 'template') return '{{value}}';
  return '$.data.items[0].id';
}

function clamp(raw: string, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number(raw) || 0));
}
