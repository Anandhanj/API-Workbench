import { z } from 'zod';
import { HttpMethod } from './collection';
import { AuthConfig } from './auth';
import { RequestBody, ExecutionOptions, ExecutionResponse } from './execution';

/**
 * Transport DTOs for the Workflow Engine (Phases 12–14).
 *
 * Workflows are modelled as a framework-independent domain graph — nodes, edges,
 * and per-node configuration — entirely separate from the React Flow canvas that
 * edits them (ADR-0005). The runtime executes this graph deterministically and
 * headlessly in the main process.
 *
 * Phase 14 adds control flow: condition/switch/loop nodes route execution along
 * labelled edges (the edge's `sourceHandle` names the branch), and any node may
 * carry a reliability {@link NodePolicy} (retry, timeout, error handling). The
 * graph may now branch (only from branch nodes) and contain cycles (loops);
 * termination is bounded by per-loop limits and a global step cap.
 */

/** Discriminator for every supported node type. */
export const WorkflowNodeKind = z.enum([
  'start',
  'request',
  'set-variable',
  'delay',
  'sub-workflow',
  'condition',
  'switch',
  'loop',
  'transform',
  'user-input',
  'end',
]);
export type WorkflowNodeKind = z.infer<typeof WorkflowNodeKind>;

/** Node kinds that may have multiple labelled outgoing edges. */
export const BRANCH_KINDS: WorkflowNodeKind[] = ['condition', 'switch', 'loop'];

// --- Reliability policy (Phase 14) ---

/**
 * Per-node reliability controls. Applied uniformly by the runtime: a node is
 * retried up to `retries` times with `retryBackoffMs` between attempts, aborted
 * if it exceeds `timeoutMs`, and on final failure handled per `onError` —
 * `fail` stops the run, `continue` proceeds to the next node, `route` follows an
 * `error`-labelled outgoing edge when present.
 */
export const NodePolicy = z.object({
  retries: z.number().int().min(0).max(10).optional(),
  retryBackoffMs: z.number().int().min(0).max(60_000).optional(),
  timeoutMs: z.number().int().min(0).max(600_000).optional(),
  onError: z.enum(['fail', 'continue', 'route']).optional(),
});
export type NodePolicy = z.infer<typeof NodePolicy>;

// --- Per-kind configuration ---

export const StartNodeConfig = z.object({}).strict();
export type StartNodeConfig = z.infer<typeof StartNodeConfig>;

export const EndNodeConfig = z.object({}).strict();
export type EndNodeConfig = z.infer<typeof EndNodeConfig>;

/** Extraction engines for mapping data out of a response (Phase 15). */
export const ExtractEngine = z.enum(['jsonpath', 'jmespath', 'regex']);
export type ExtractEngine = z.infer<typeof ExtractEngine>;

/** Where in a response a value is read from. */
export const ExtractSource = z.enum(['body', 'header', 'status']);
export type ExtractSource = z.infer<typeof ExtractSource>;

/**
 * A single response → variable mapping. `body` sources apply `engine`/`expression`
 * to the response body; `header` reads the header named by `expression`; `status`
 * captures the numeric status. The captured value is written to the runtime
 * variable `variable`, so later nodes can reference `{{ variable }}`.
 */
export const ExtractRule = z.object({
  variable: z.string(),
  source: ExtractSource.default('body'),
  engine: ExtractEngine.default('jsonpath'),
  expression: z.string().default(''),
});
export type ExtractRule = z.infer<typeof ExtractRule>;

export const RequestNodeConfig = z.object({
  method: HttpMethod,
  url: z.string(),
  headers: z.record(z.string()).default({}),
  query: z.record(z.string()).default({}),
  body: RequestBody.default({ type: 'none' }),
  auth: AuthConfig.optional(),
  credentialId: z.string().optional(),
  options: ExecutionOptions.partial().optional(),
  /** Response → variable mappings applied after the request succeeds. */
  extract: z.array(ExtractRule).default([]),
  /** The collection request this node was imported from (for display / re-sync). */
  requestId: z.string().optional(),
});
export type RequestNodeConfig = z.infer<typeof RequestNodeConfig>;

/**
 * Computes a runtime variable from existing context. `template` evaluates a
 * `{{ template }}`; the path/regex engines apply `expression` to `input` (a
 * template that resolves to the source text/JSON). The result is written to
 * `variable`.
 */
export const TransformNodeConfig = z.object({
  variable: z.string(),
  engine: z.enum(['template', 'jsonpath', 'jmespath', 'regex']).default('template'),
  input: z.string().default(''),
  expression: z.string().default(''),
});
export type TransformNodeConfig = z.infer<typeof TransformNodeConfig>;

export const SetVariableNodeConfig = z.object({
  key: z.string(),
  value: z.string(),
});
export type SetVariableNodeConfig = z.infer<typeof SetVariableNodeConfig>;

/**
 * A single value the run asks the user to supply when it reaches a user-input
 * node. `variable` is the runtime variable the submitted value is written to;
 * `default` is a template, evaluated against the run context, used to pre-fill
 * the prompt; `secret` masks the input field.
 */
export const UserInputField = z.object({
  label: z.string().default(''),
  variable: z.string(),
  default: z.string().default(''),
  secret: z.boolean().default(false),
});
export type UserInputField = z.infer<typeof UserInputField>;

/**
 * Pauses the run and asks the user to fill in `fields`; the submitted values are
 * written to the runtime variables named by each field, so later nodes can
 * reference them via `{{ variable }}`. With no fields it is a plain checkpoint
 * (Continue/Cancel). Runs headlessly (no input port) by falling back to the
 * fields' evaluated defaults.
 */
export const UserInputNodeConfig = z.object({
  message: z.string().default(''),
  fields: z.array(UserInputField).default([]),
});
export type UserInputNodeConfig = z.infer<typeof UserInputNodeConfig>;

export const DelayNodeConfig = z.object({
  ms: z.number().int().min(0).max(600_000),
});
export type DelayNodeConfig = z.infer<typeof DelayNodeConfig>;

export const SubWorkflowNodeConfig = z.object({
  workflowId: z.string(),
});
export type SubWorkflowNodeConfig = z.infer<typeof SubWorkflowNodeConfig>;

/**
 * Branches on a condition. Outgoing edges are labelled `true`/`false` (edge
 * `sourceHandle`). The expression supports comparisons (`==` `!=` `>` `>=` `<`
 * `<=`), string ops (`contains`, `startsWith`, `endsWith`, `matches`), and
 * `&&`/`||`; operands resolve `{{ templates }}`. A bare value (no operator) is
 * truthy unless it is empty or one of false/0/no/null/undefined. See
 * {@link evaluateCondition} in `shared/condition`.
 */
export const ConditionNodeConfig = z.object({
  expression: z.string(),
});
export type ConditionNodeConfig = z.infer<typeof ConditionNodeConfig>;

/**
 * Branches on a value against named cases. The matching case's `sourceHandle`
 * is followed; if none match, the `default` handle is used.
 */
export const SwitchNodeConfig = z.object({
  value: z.string(),
  cases: z.array(z.string()).default([]),
});
export type SwitchNodeConfig = z.infer<typeof SwitchNodeConfig>;

/**
 * Repeats its `body` branch, then takes the `done` branch. `times` repeats a
 * fixed number of iterations; `while` repeats while a condition is truthy, both
 * bounded by a hard iteration cap so runs always terminate.
 */
export const LoopNodeConfig = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('times'), times: z.number().int().min(1).max(10_000) }),
  z.object({
    mode: z.literal('while'),
    condition: z.string(),
    maxIterations: z.number().int().min(1).max(10_000),
  }),
]);
export type LoopNodeConfig = z.infer<typeof LoopNodeConfig>;

// --- Node / edge / graph ---

export const NodePosition = z.object({ x: z.number(), y: z.number() });
export type NodePosition = z.infer<typeof NodePosition>;

const nodeBase = {
  id: z.string(),
  name: z.string(),
  position: NodePosition,
  policy: NodePolicy.optional(),
};

/** A workflow node: a discriminated union over {@link WorkflowNodeKind}. */
export const WorkflowNode = z.discriminatedUnion('kind', [
  z.object({ ...nodeBase, kind: z.literal('start'), config: StartNodeConfig }),
  z.object({ ...nodeBase, kind: z.literal('request'), config: RequestNodeConfig }),
  z.object({ ...nodeBase, kind: z.literal('set-variable'), config: SetVariableNodeConfig }),
  z.object({ ...nodeBase, kind: z.literal('delay'), config: DelayNodeConfig }),
  z.object({ ...nodeBase, kind: z.literal('sub-workflow'), config: SubWorkflowNodeConfig }),
  z.object({ ...nodeBase, kind: z.literal('condition'), config: ConditionNodeConfig }),
  z.object({ ...nodeBase, kind: z.literal('switch'), config: SwitchNodeConfig }),
  z.object({ ...nodeBase, kind: z.literal('loop'), config: LoopNodeConfig }),
  z.object({ ...nodeBase, kind: z.literal('transform'), config: TransformNodeConfig }),
  z.object({ ...nodeBase, kind: z.literal('user-input'), config: UserInputNodeConfig }),
  z.object({ ...nodeBase, kind: z.literal('end'), config: EndNodeConfig }),
]);
export type WorkflowNode = z.infer<typeof WorkflowNode>;

/** A directed connection; `sourceHandle` names the branch for branch nodes. */
export const WorkflowEdge = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  sourceHandle: z.string().nullable().optional(),
  targetHandle: z.string().nullable().optional(),
});
export type WorkflowEdge = z.infer<typeof WorkflowEdge>;

/**
 * A visual grouping of nodes (Phase 13). Groups are view-layer only; the runtime
 * ignores them (it reads only `nodes`/`edges`).
 */
export const WorkflowGroup = z.object({
  id: z.string(),
  name: z.string(),
  childIds: z.array(z.string()),
});
export type WorkflowGroup = z.infer<typeof WorkflowGroup>;

/** The complete editable/executable graph. The single source of truth. */
export const WorkflowGraph = z.object({
  nodes: z.array(WorkflowNode),
  edges: z.array(WorkflowEdge),
  groups: z.array(WorkflowGroup).default([]),
});
export type WorkflowGraph = z.infer<typeof WorkflowGraph>;

// --- Persistence DTOs ---

export const Workflow = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  nodeCount: z.number(),
});
export type Workflow = z.infer<typeof Workflow>;

export const WorkflowDetail = Workflow.omit({ nodeCount: true }).extend({
  graph: WorkflowGraph,
});
export type WorkflowDetail = z.infer<typeof WorkflowDetail>;

export const CreateWorkflowInput = z.object({
  projectId: z.string(),
  name: z.string().min(1),
  description: z.string().optional(),
});
export type CreateWorkflowInput = z.infer<typeof CreateWorkflowInput>;

export const SaveWorkflowInput = z.object({
  id: z.string(),
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  graph: WorkflowGraph,
});
export type SaveWorkflowInput = z.infer<typeof SaveWorkflowInput>;

// --- Portable export / import ---

export const WORKFLOW_EXPORT_FORMAT = 1;

/**
 * A single workflow inside an export bundle. The graph is carried verbatim, so
 * every node's full configuration travels with it — request nodes keep their
 * complete method/url/headers/query/body/auth/extract, not a reference. `id` is
 * the original workflow id, retained so sub-workflow references between bundled
 * workflows can be remapped to the fresh ids created on import.
 */
export const WorkflowExportItem = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().nullable(),
  graph: WorkflowGraph,
});
export type WorkflowExportItem = z.infer<typeof WorkflowExportItem>;

/**
 * A self-contained workflow export. `workflows` holds the exported workflow
 * (`rootId`) followed by every sub-workflow it references transitively, so an
 * import needs nothing else. Secrets held in the credential store are NOT
 * inlined; any `credentialId` reference is carried as-is (inline `auth` configs,
 * which already live in the graph, do travel with it).
 */
export const WorkflowExport = z.object({
  formatVersion: z.literal(WORKFLOW_EXPORT_FORMAT),
  exportedAt: z.number(),
  appVersion: z.string().optional(),
  rootId: z.string(),
  workflows: z.array(WorkflowExportItem).min(1),
});
export type WorkflowExport = z.infer<typeof WorkflowExport>;

/** Imports an exported bundle into a project as a new workflow (with fresh ids). */
export const ImportWorkflowInput = z.object({
  projectId: z.string(),
  data: WorkflowExport,
});
export type ImportWorkflowInput = z.infer<typeof ImportWorkflowInput>;

// --- Run DTOs ---

export const NodeRunStatus = z.enum(['success', 'failed', 'skipped']);
export type NodeRunStatus = z.infer<typeof NodeRunStatus>;

export const WorkflowRunStatus = z.enum(['success', 'failed', 'cancelled']);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatus>;

/** The outcome of executing a single node. */
export const NodeRunResult = z.object({
  nodeId: z.string(),
  kind: WorkflowNodeKind,
  name: z.string(),
  status: NodeRunStatus,
  startedAt: z.number(),
  durationMs: z.number(),
  /** Number of attempts made (>1 when retried). */
  attempts: z.number().optional(),
  /** Set on failure (or any informative outcome, e.g. the branch taken). */
  message: z.string().optional(),
  /** Variables this node contributed to the runtime context. */
  variablesSet: z.record(z.string()).optional(),
  /** The HTTP response for request nodes. */
  response: ExecutionResponse.optional(),
});
export type NodeRunResult = z.infer<typeof NodeRunResult>;

/** The full result of a workflow run. */
export const WorkflowRunResult = z.object({
  workflowId: z.string(),
  status: WorkflowRunStatus,
  startedAt: z.number(),
  durationMs: z.number(),
  nodeResults: z.array(NodeRunResult),
  finalVariables: z.record(z.string()),
});
export type WorkflowRunResult = z.infer<typeof WorkflowRunResult>;

export const WorkflowRunRequest = z.object({
  workflowId: z.string(),
  runtime: z.record(z.string()).optional(),
  /** Start paused before the first node; advance one node at a time via workflow.step. */
  stepMode: z.boolean().optional(),
});
export type WorkflowRunRequest = z.infer<typeof WorkflowRunRequest>;

// --- Live run progress ---

/**
 * Pushed as the engine walks the graph: a `running` event when a node starts and
 * a `done` event (carrying its {@link NodeRunResult}) when it finishes. The
 * renderer uses these to highlight the current stage on the canvas and stream
 * per-node results into the run panel before the whole run resolves. Events for
 * sub-workflow nodes carry that sub-workflow's id in `workflowId`.
 */
export const WorkflowProgressEvent = z.object({
  workflowId: z.string(),
  phase: z.enum(['running', 'done']),
  nodeId: z.string(),
  kind: WorkflowNodeKind,
  name: z.string(),
  /** Present only when `phase === 'done'`. */
  result: NodeRunResult.optional(),
});
export type WorkflowProgressEvent = z.infer<typeof WorkflowProgressEvent>;

// --- User-input pause/resume DTOs ---

/**
 * Pushed to the renderer when a run reaches a user-input node and suspends. The
 * run stays alive (blocked in the engine) until the renderer replies with a
 * {@link WorkflowInputResponse} on the `workflow.provideInput` channel. `fields`
 * carry their defaults already evaluated against the run context.
 */
export const WorkflowInputRequest = z.object({
  workflowId: z.string(),
  nodeId: z.string(),
  name: z.string(),
  message: z.string(),
  fields: z.array(UserInputField),
});
export type WorkflowInputRequest = z.infer<typeof WorkflowInputRequest>;

/** The renderer's reply that unblocks a suspended user-input node. */
export const WorkflowInputResponse = z.object({
  workflowId: z.string(),
  nodeId: z.string(),
  values: z.record(z.string()).default({}),
  cancelled: z.boolean().default(false),
});
export type WorkflowInputResponse = z.infer<typeof WorkflowInputResponse>;

/** The engine-facing outcome of a {@link WorkflowInputRequest}. */
export interface WorkflowInputResult {
  values: Record<string, string>;
  cancelled: boolean;
}
