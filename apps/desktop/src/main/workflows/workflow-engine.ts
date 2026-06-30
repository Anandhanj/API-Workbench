import type { ExecutionResponse } from '@shared/execution';
import type {
  LoopNodeConfig,
  NodeRunResult,
  RequestNodeConfig,
  WorkflowDetail,
  WorkflowInputRequest,
  WorkflowInputResult,
  WorkflowNode,
  WorkflowProgressEvent,
  WorkflowRunResult,
  WorkflowRunStatus,
} from '@shared/workflow';
import { applyTransform, extractAll } from '@shared/extract';
import { evaluateCondition } from '@shared/condition';
import { WorkflowError } from './errors';
import { resolveTarget, validateGraph } from './workflow-graph';

/**
 * Execution context threaded through a run. `runtime` is the mutable variable
 * map: every node reads it and set-variable/sub-workflow nodes write to it,
 * which is how values propagate from one step to the next.
 */
export interface RunContext {
  workflowId: string;
  runtime: Record<string, string>;
}

/** Cooperative cancellation + pause control the engine checks between nodes. */
export interface RunControl {
  signal: AbortSignal;
  waitIfPaused(): Promise<void>;
}

export interface WorkflowEnginePorts {
  executeRequest(
    config: RequestNodeConfig,
    ctx: RunContext,
    signal?: AbortSignal,
  ): Promise<ExecutionResponse>;
  evaluate(template: string, ctx: RunContext): string;
  loadWorkflow(workflowId: string): WorkflowDetail;
  /**
   * Suspends the run at a user-input node and resolves once the user supplies (or
   * cancels) the requested values. Omitted in headless runs, where the engine
   * falls back to each field's evaluated default.
   */
  requestInput?(request: WorkflowInputRequest, ctx: RunContext): Promise<WorkflowInputResult>;
  /** Called as each node starts (`running`) and finishes (`done`), for live UI. */
  onNodeProgress?(event: WorkflowProgressEvent): void;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface RunOptions {
  runtime?: Record<string, string>;
  signal?: AbortSignal;
  control?: RunControl;
}

const MAX_STEPS = 1_000_000;
const MAX_DEPTH = 25;

const NO_PAUSE: RunControl = {
  signal: new AbortController().signal,
  waitIfPaused: () => Promise.resolve(),
};

/** Internal: the result of running a node plus the branch handle it selected. */
interface NodeOutcome {
  result: NodeRunResult;
  handle: string | null;
}

/**
 * The deterministic, headless workflow runtime (Phases 12–14).
 *
 * It walks the graph from the start node, executing one node at a time and
 * choosing the next node from the branch the node selects (condition/switch/loop
 * route along labelled edges; linear nodes follow their single edge). Each node
 * runs under its reliability policy (retry, timeout, error handling), and the
 * run can be cancelled or paused between nodes. Given the same inputs and ports
 * the run is deterministic; termination is bounded by per-loop caps and a global
 * step limit.
 */
export class WorkflowEngine {
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly ports: WorkflowEnginePorts) {
    this.now = ports.now ?? (() => Date.now());
    this.sleep = ports.sleep ?? defaultSleep;
  }

  async run(workflow: WorkflowDetail, options: RunOptions = {}): Promise<WorkflowRunResult> {
    const startedAt = this.now();
    const control =
      options.control ??
      (options.signal
        ? { signal: options.signal, waitIfPaused: () => Promise.resolve() }
        : NO_PAUSE);
    const runtime: Record<string, string> = { ...(options.runtime ?? {}) };
    const nodeResults: NodeRunResult[] = [];
    const status = await this.runInto(workflow, runtime, nodeResults, control, new Set());
    return {
      workflowId: workflow.id,
      status,
      startedAt,
      durationMs: this.now() - startedAt,
      nodeResults,
      finalVariables: runtime,
    };
  }

  private async runInto(
    workflow: WorkflowDetail,
    runtime: Record<string, string>,
    results: NodeRunResult[],
    control: RunControl,
    stack: Set<string>,
  ): Promise<WorkflowRunStatus> {
    if (stack.has(workflow.id))
      throw new WorkflowError(`Sub-workflow cycle detected at "${workflow.id}"`);
    if (stack.size >= MAX_DEPTH)
      throw new WorkflowError(`Sub-workflow nesting exceeded ${MAX_DEPTH}`);
    const index = validateGraph(workflow.graph);
    const nestedStack = new Set(stack).add(workflow.id);
    const ctx: RunContext = { workflowId: workflow.id, runtime };
    const loopCounters = new Map<string, number>();

    let current: WorkflowNode | undefined = workflow.graph.nodes.find((n) => n.kind === 'start');
    let steps = 0;
    while (current) {
      await control.waitIfPaused();
      if (control.signal.aborted) return 'cancelled';
      if (steps++ > MAX_STEPS) throw new WorkflowError('Workflow exceeded the maximum step count');

      if (current.kind === 'end') {
        this.progress(workflow.id, current);
        const endResult = this.instant(current, 'success');
        results.push(endResult);
        this.progress(workflow.id, current, endResult);
        return 'success';
      }

      this.progress(workflow.id, current);
      const { result, handle } = await this.executeWithPolicy(
        current,
        ctx,
        control,
        nestedStack,
        results,
        loopCounters,
      );
      results.push(result);
      this.progress(workflow.id, current, result);
      if (result.variablesSet) Object.assign(runtime, result.variablesSet);

      // A node may suspend (e.g. user-input) and be cancelled while suspended;
      // surface that as a cancelled run rather than a node failure.
      if (control.signal.aborted) return 'cancelled';

      let chosen = handle;
      if (result.status === 'failed') {
        const onError = current.policy?.onError ?? 'fail';
        if (onError === 'fail') return 'failed';
        if (onError === 'route') chosen = 'error';
        // 'continue' keeps the node's normal handle and proceeds.
      }

      const nextId = resolveTarget(index, current.id, chosen);
      if (nextId === undefined) {
        // A routed error with no error edge wired is still a failure.
        if (result.status === 'failed' && current.policy?.onError === 'route') return 'failed';
        break;
      }
      current = index.byId.get(nextId);
    }
    return 'success';
  }

  /** Runs a node under its retry/timeout policy, returning the final outcome. */
  private async executeWithPolicy(
    node: WorkflowNode,
    ctx: RunContext,
    control: RunControl,
    stack: Set<string>,
    results: NodeRunResult[],
    loopCounters: Map<string, number>,
  ): Promise<NodeOutcome> {
    const policy = node.policy ?? {};
    const attempts = (policy.retries ?? 0) + 1;
    let outcome: NodeOutcome = {
      result: this.instant(node, 'failed', 'Not executed'),
      handle: null,
    };

    for (let attempt = 1; attempt <= attempts; attempt++) {
      outcome = await this.runOnce(
        node,
        ctx,
        control,
        stack,
        results,
        loopCounters,
        policy.timeoutMs,
      );
      outcome.result.attempts = attempt;
      if (outcome.result.status !== 'failed') return outcome;
      if (attempt < attempts && !control.signal.aborted) {
        await this.sleep(policy.retryBackoffMs ?? 0, control.signal);
      }
    }
    return outcome;
  }

  /** A single execution attempt, racing against the node timeout when set. */
  private async runOnce(
    node: WorkflowNode,
    ctx: RunContext,
    control: RunControl,
    stack: Set<string>,
    results: NodeRunResult[],
    loopCounters: Map<string, number>,
    timeoutMs?: number,
  ): Promise<NodeOutcome> {
    const startedAt = this.now();
    const work = this.executeNode(node, ctx, control, stack, results, loopCounters, startedAt);
    if (!timeoutMs || timeoutMs <= 0) return work;

    const timeout = this.sleep(timeoutMs, control.signal).then<NodeOutcome>(() => ({
      result: {
        nodeId: node.id,
        kind: node.kind,
        name: node.name,
        status: 'failed',
        startedAt,
        durationMs: this.now() - startedAt,
        message: `Timed out after ${timeoutMs} ms`,
      },
      handle: null,
    }));
    return Promise.race([work, timeout]);
  }

  /** Executes one node by kind, returning its result and selected branch. */
  private async executeNode(
    node: WorkflowNode,
    ctx: RunContext,
    control: RunControl,
    stack: Set<string>,
    results: NodeRunResult[],
    loopCounters: Map<string, number>,
    startedAt: number,
  ): Promise<NodeOutcome> {
    const base = { nodeId: node.id, kind: node.kind, name: node.name, startedAt };
    const done = (): number => this.now() - startedAt;
    try {
      switch (node.kind) {
        case 'start':
          return { result: { ...base, status: 'success', durationMs: done() }, handle: null };

        case 'set-variable': {
          const value = this.ports.evaluate(node.config.value, ctx);
          return {
            result: {
              ...base,
              status: 'success',
              durationMs: done(),
              variablesSet: { [node.config.key]: value },
              message: `${node.config.key} = ${value}`,
            },
            handle: null,
          };
        }

        case 'delay': {
          await this.sleep(node.config.ms, control.signal);
          return {
            result: {
              ...base,
              status: 'success',
              durationMs: done(),
              message: `Waited ${node.config.ms} ms`,
            },
            handle: null,
          };
        }

        case 'request': {
          const response = await this.ports.executeRequest(node.config, ctx, control.signal);
          const failed = Boolean(response.error);
          const extracted = failed ? {} : extractAll(response, node.config.extract ?? []);
          return {
            result: {
              ...base,
              status: failed ? 'failed' : 'success',
              durationMs: done(),
              response,
              ...(Object.keys(extracted).length ? { variablesSet: extracted } : {}),
              message: failed ? response.error : `${response.status} ${response.statusText}`,
            },
            handle: null,
          };
        }

        case 'transform': {
          const value = applyTransform(node.config, (t) => this.ports.evaluate(t, ctx));
          return {
            result: {
              ...base,
              status: 'success',
              durationMs: done(),
              variablesSet: { [node.config.variable]: value },
              message: `${node.config.variable} = ${value}`,
            },
            handle: null,
          };
        }

        case 'user-input': {
          // Resolve each field's default template so the prompt is pre-filled.
          const fields = node.config.fields.map((f) => ({
            label: f.label,
            variable: f.variable,
            default: this.ports.evaluate(f.default, ctx),
            secret: f.secret,
          }));
          // Headless fallback: no input port → accept the evaluated defaults.
          if (!this.ports.requestInput) {
            const values = Object.fromEntries(fields.map((f) => [f.variable, f.default]));
            return {
              result: {
                ...base,
                status: 'success',
                durationMs: done(),
                ...(Object.keys(values).length ? { variablesSet: values } : {}),
                message: 'Auto-filled defaults (no input port)',
              },
              handle: null,
            };
          }
          const { values, cancelled } = await this.ports.requestInput(
            {
              workflowId: ctx.workflowId,
              nodeId: node.id,
              name: node.name,
              message: node.config.message,
              fields,
            },
            ctx,
          );
          if (cancelled) {
            return {
              result: { ...base, status: 'failed', durationMs: done(), message: 'Input cancelled' },
              handle: null,
            };
          }
          return {
            result: {
              ...base,
              status: 'success',
              durationMs: done(),
              ...(Object.keys(values).length ? { variablesSet: values } : {}),
              message: Object.keys(values).length
                ? `Collected ${Object.keys(values).length} value(s)`
                : 'Continued',
            },
            handle: null,
          };
        }

        case 'sub-workflow': {
          const child = this.ports.loadWorkflow(node.config.workflowId);
          const childStatus = await this.runInto(child, ctx.runtime, results, control, stack);
          return {
            result: {
              ...base,
              status: childStatus === 'success' ? 'success' : 'failed',
              durationMs: done(),
              message: `Sub-workflow "${child.name}" ${childStatus}`,
            },
            handle: null,
          };
        }

        case 'condition': {
          const handle = this.truthy(node.config.expression, ctx) ? 'true' : 'false';
          return {
            result: { ...base, status: 'success', durationMs: done(), message: `→ ${handle}` },
            handle,
          };
        }

        case 'switch': {
          const value = this.ports.evaluate(node.config.value, ctx).trim();
          const handle = node.config.cases.includes(value) ? value : 'default';
          return {
            result: {
              ...base,
              status: 'success',
              durationMs: done(),
              message: `${value} → ${handle}`,
            },
            handle,
          };
        }

        case 'loop': {
          const count = loopCounters.get(node.id) ?? 0;
          const cont = this.shouldLoop(node.config, count, ctx);
          if (cont) {
            loopCounters.set(node.id, count + 1);
            return {
              result: {
                ...base,
                status: 'success',
                durationMs: done(),
                message: `iteration ${count + 1}`,
              },
              handle: 'body',
            };
          }
          return {
            result: {
              ...base,
              status: 'success',
              durationMs: done(),
              message: `done after ${count}`,
            },
            handle: 'done',
          };
        }

        case 'end':
          return { result: { ...base, status: 'success', durationMs: done() }, handle: null };

        default: {
          const _never: never = node;
          throw new WorkflowError(`Unsupported node kind: ${JSON.stringify(_never)}`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { result: { ...base, status: 'failed', durationMs: done(), message }, handle: null };
    }
  }

  /** Emits a `running` event (no result) or a `done` event (with result). */
  private progress(workflowId: string, node: WorkflowNode, result?: NodeRunResult): void {
    if (!this.ports.onNodeProgress) return;
    this.ports.onNodeProgress({
      workflowId,
      phase: result ? 'done' : 'running',
      nodeId: node.id,
      kind: node.kind,
      name: node.name,
      ...(result ? { result } : {}),
    });
  }

  private truthy(expression: string, ctx: RunContext): boolean {
    return evaluateCondition(expression, (template) => this.ports.evaluate(template, ctx));
  }

  private shouldLoop(config: LoopNodeConfig, count: number, ctx: RunContext): boolean {
    if (config.mode === 'times') return count < config.times;
    return count < config.maxIterations && this.truthy(config.condition, ctx);
  }

  /** A zero-work node result (start/end and failure sentinels). */
  private instant(
    node: WorkflowNode,
    status: NodeRunResult['status'],
    message?: string,
  ): NodeRunResult {
    const at = this.now();
    return {
      nodeId: node.id,
      kind: node.kind,
      name: node.name,
      status,
      startedAt: at,
      durationMs: 0,
      ...(message ? { message } : {}),
    };
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new WorkflowError('Cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new WorkflowError('Cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
