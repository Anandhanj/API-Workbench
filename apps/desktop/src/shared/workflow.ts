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

export const DelayNodeConfig = z.object({
  ms: z.number().int().min(0).max(600_000),
});
export type DelayNodeConfig = z.infer<typeof DelayNodeConfig>;

export const SubWorkflowNodeConfig = z.object({
  workflowId: z.string(),
});
export type SubWorkflowNodeConfig = z.infer<typeof SubWorkflowNodeConfig>;

/**
 * Branches on a truthy expression. Outgoing edges are labelled `true`/`false`
 * (edge `sourceHandle`). The expression is a `{{ template }}`; the result is
 * truthy unless it is empty or one of false/0/no/null/undefined.
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
});
export type WorkflowRunRequest = z.infer<typeof WorkflowRunRequest>;
