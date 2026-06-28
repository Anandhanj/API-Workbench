import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Pause, Play, Plus, Save, Square, ToggleLeft, ToggleRight, Trash2, Workflow as WorkflowIcon } from 'lucide-react';
import type { ExtractRule, NodePolicy, NodeRunStatus, WorkflowGraph, WorkflowNode } from '@shared/workflow';
import { invoke, isBridgeAvailable } from '../../lib/ipc';
import { usePersistentState } from '../../lib/use-persistent-state';
import { useConfirm } from '../../components/confirm/ConfirmProvider';
import { useActiveSelection, useWorkspaceDetail } from '../workspaces/use-workspaces';
import { useWorkflow, useWorkflowMutations, useWorkflows, useRunWorkflow, useRunControls } from './use-workflows';
import { useProjectRequests } from './use-project-requests';
import { requestDetailToNodeConfig } from './request-import';
import { WorkflowCanvas, type FlowNode } from './WorkflowCanvas';
import { NodePalette } from './NodePalette';
import { NodeInspector } from './NodeInspector';
import { RunPanel } from './RunPanel';

interface Mutators {
  rename: (id: string, name: string) => void;
  setConfig: (id: string, config: WorkflowNode['config']) => void;
  setPolicy: (id: string, policy: NodePolicy | undefined) => void;
  remove: (id: string) => void;
}

export function WorkflowsPage(): JSX.Element {
  const bridge = isBridgeAvailable();
  const active = useActiveSelection();
  const projectId = active.data?.projectId ?? null;
  const workspaceDetail = useWorkspaceDetail(active.data?.workspaceId ?? null);
  const projectName = workspaceDetail.data?.projects.find((p) => p.id === projectId)?.name ?? null;

  const workflows = useWorkflows(projectId);
  const mutations = useWorkflowMutations(projectId);
  const run = useRunWorkflow();
  const controls = useRunControls();
  const projectRequests = useProjectRequests(projectId);
  const [paused, setPaused] = useState(false);
  const confirm = useConfirm();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [selectedNode, setSelectedNode] = useState<FlowNode | null>(null);

  const detail = useWorkflow(selectedId);
  const graphRef = useRef<WorkflowGraph | null>(null);
  const mutatorsRef = useRef<Mutators | null>(null);

  // Per-workflow auto-save preference (persisted across restarts).
  const [autoSaveMap, setAutoSaveMap] = usePersistentState<Record<string, boolean>>('awb.workflow.autosave', {});
  const autoSaveOn = selectedId ? Boolean(autoSaveMap[selectedId]) : false;
  const [dirtyAt, setDirtyAt] = useState(0);

  // Auto-select the first workflow as the list resolves.
  useEffect(() => {
    if (workflows.data && workflows.data.length > 0) {
      if (!selectedId || !workflows.data.some((w) => w.id === selectedId)) {
        setSelectedId(workflows.data[0].id);
      }
    } else if (workflows.data && workflows.data.length === 0) {
      setSelectedId(null);
    }
  }, [workflows.data, selectedId]);

  // Run statuses overlaid on the canvas, only for the active workflow.
  const statuses = useMemo<Record<string, NodeRunStatus>>(() => {
    if (!run.data || run.data.workflowId !== selectedId) return {};
    const map: Record<string, NodeRunStatus> = {};
    for (const n of run.data.nodeResults) map[n.nodeId] = n.status;
    return map;
  }, [run.data, selectedId]);

  const handleSave = (): void => {
    if (selectedId && graphRef.current) {
      mutations.save.mutate({ id: selectedId, graph: graphRef.current });
    }
  };

  const handleRun = (): void => {
    if (!selectedId || !graphRef.current) return;
    setPaused(false);
    mutations.save.mutate(
      { id: selectedId, graph: graphRef.current },
      { onSuccess: () => run.mutate({ workflowId: selectedId }) },
    );
  };

  const handlePauseResume = (): void => {
    if (!selectedId) return;
    if (paused) {
      controls.resume.mutate(selectedId);
      setPaused(false);
    } else {
      controls.pause.mutate(selectedId);
      setPaused(true);
    }
  };

  const handleCancel = (): void => {
    if (selectedId) controls.cancel.mutate(selectedId);
  };

  const handleImportRequest = async (requestId: string): Promise<void> => {
    if (!selectedNode || selectedNode.data.kind !== 'request') return;
    const detail = await invoke('request.get', { id: requestId });
    const current = selectedNode.data.config as { extract?: ExtractRule[] };
    mutatorsRef.current?.setConfig(selectedNode.id, requestDetailToNodeConfig(detail, current.extract ?? []));
  };

  const handleGraphChange = useCallback((g: WorkflowGraph): void => {
    graphRef.current = g;
    setDirtyAt(Date.now());
  }, []);

  const toggleAutoSave = (): void => {
    if (!selectedId) return;
    setAutoSaveMap((m) => ({ ...m, [selectedId]: !autoSaveOn }));
  };

  // Debounced per-workflow auto-save: when enabled, persist ~800ms after the
  // last graph change. `save` (react-query mutate) is referentially stable.
  const save = mutations.save.mutate;
  useEffect(() => {
    if (!autoSaveOn || !selectedId || !graphRef.current || dirtyAt === 0) return;
    const id = selectedId;
    const graph = graphRef.current;
    const timer = setTimeout(() => save({ id, graph }), 800);
    return () => clearTimeout(timer);
  }, [dirtyAt, autoSaveOn, selectedId, save]);

  if (!bridge) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <h1 className="text-2xl font-semibold">Workflows</h1>
        <p className="mt-2 text-muted">
          The workflow engine requires the desktop database, available when running inside the
          application.
        </p>
      </div>
    );
  }

  if (!projectId) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <h1 className="text-2xl font-semibold">Workflows</h1>
        <p className="mt-2 text-muted">Open a project in the Workspaces tab to build workflows.</p>
      </div>
    );
  }

  const runError = run.error instanceof Error ? run.error.message : null;

  return (
    <div className="flex h-full w-full flex-col p-6">
      <nav aria-label="Breadcrumb" className="mb-1 flex items-center gap-1.5 text-xs text-muted">
        {projectName && (
          <span className="text-fg">
            {projectName} <span className="text-muted/70">(Project)</span>
          </span>
        )}
        <span>›</span>
        <span>Workflows</span>
      </nav>
      <h1 className="mb-4 text-xl font-semibold">Workflows</h1>

      <div className="flex min-h-0 flex-1 gap-3">
        {/* Left: workflow list + palette */}
        <aside className="flex w-60 shrink-0 flex-col gap-3 overflow-y-auto">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const name = newName.trim();
              if (!name) return;
              mutations.create.mutate(
                { projectId, name },
                { onSuccess: (wf) => setSelectedId(wf.id) },
              );
              setNewName('');
            }}
          >
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New workflow"
              aria-label="New workflow name"
              className="min-w-0 flex-1 rounded-md border border-border bg-surface px-3 py-1.5 text-sm"
            />
            <button type="submit" aria-label="Create workflow" className="rounded-md bg-accent px-3 py-1.5 text-accent-fg">
              <Plus size={15} />
            </button>
          </form>

          <div className="rounded-md border border-border">
            {workflows.data?.map((w) => (
              <div
                key={w.id}
                className={`group flex items-center gap-2 border-b border-border px-2.5 py-1.5 last:border-0 ${
                  w.id === selectedId ? 'bg-surface-2' : 'hover:bg-surface-2'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setSelectedId(w.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm"
                >
                  <WorkflowIcon size={14} className="shrink-0 text-muted" />
                  <span className="truncate">{w.name}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-muted">{w.nodeCount}</span>
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${w.name}`}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: 'Delete workflow',
                        message: `Delete workflow "${w.name}"? This cannot be undone.`,
                        confirmLabel: 'Delete',
                        danger: true,
                      })
                    ) {
                      mutations.remove.mutate(w.id);
                      if (selectedId === w.id) setSelectedId(null);
                    }
                  }}
                  className="shrink-0 text-muted opacity-0 hover:text-rose-400 group-hover:opacity-100"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            {workflows.data?.length === 0 && (
              <p className="px-3 py-2 text-sm text-muted">No workflows yet.</p>
            )}
          </div>

          <NodePalette />
        </aside>

        {/* Center: canvas + toolbar */}
        <section className="flex min-w-0 flex-1 flex-col rounded-md border border-border">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <span className="truncate text-sm font-medium">{detail.data?.name ?? 'Select a workflow'}</span>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={toggleAutoSave}
                disabled={!selectedId}
                title={autoSaveOn ? 'Auto-save is on for this workflow' : 'Auto-save is off for this workflow'}
                aria-pressed={autoSaveOn}
                className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm disabled:opacity-40 ${
                  autoSaveOn ? 'border-accent text-accent' : 'border-border text-muted hover:bg-surface-2'
                }`}
              >
                {autoSaveOn ? <ToggleRight size={15} /> : <ToggleLeft size={15} />}
                Auto-save
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={!selectedId || mutations.save.isPending}
                className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-2 disabled:opacity-40"
              >
                {mutations.save.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                Save
              </button>
              {run.isPending ? (
                <>
                  <button
                    type="button"
                    onClick={handlePauseResume}
                    className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-2"
                  >
                    {paused ? <Play size={14} /> : <Pause size={14} />}
                    {paused ? 'Resume' : 'Pause'}
                  </button>
                  <button
                    type="button"
                    onClick={handleCancel}
                    className="flex items-center gap-1.5 rounded-md border border-rose-500/40 px-3 py-1.5 text-sm text-rose-400 hover:bg-rose-500/10"
                  >
                    <Square size={14} /> Cancel
                  </button>
                  <span className="flex items-center gap-1.5 text-sm text-muted">
                    <Loader2 size={14} className="animate-spin" /> Running
                  </span>
                </>
              ) : (
                <button
                  type="button"
                  onClick={handleRun}
                  disabled={!selectedId}
                  className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm text-accent-fg disabled:opacity-40"
                >
                  <Play size={14} /> Run
                </button>
              )}
            </div>
          </div>
          <div className="min-h-0 flex-1">
            {detail.data ? (
              <WorkflowCanvas
                key={detail.data.id}
                workflow={detail.data}
                workflows={(workflows.data ?? []).filter((w) => w.id !== detail.data?.id)}
                statuses={statuses}
                onGraphChange={handleGraphChange}
                onSelect={setSelectedNode}
                registerMutators={(m) => {
                  mutatorsRef.current = m;
                }}
              />
            ) : (
              <p className="p-6 text-sm text-muted">
                Create or select a workflow to open the designer.
              </p>
            )}
          </div>
        </section>

        {/* Right: inspector + run results */}
        <aside className="flex w-80 shrink-0 flex-col divide-y divide-border overflow-hidden rounded-md border border-border">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <NodeInspector
              node={selectedNode}
              workflows={(workflows.data ?? []).filter((w) => w.id !== selectedId)}
              projectRequests={projectRequests.data ?? []}
              onImportRequest={(id) => void handleImportRequest(id)}
              lastResponse={run.data?.nodeResults.find((n) => n.nodeId === selectedNode?.id)?.response}
              onRename={(name) => selectedNode && mutatorsRef.current?.rename(selectedNode.id, name)}
              onConfig={(config) => selectedNode && mutatorsRef.current?.setConfig(selectedNode.id, config)}
              onPolicy={(policy) => selectedNode && mutatorsRef.current?.setPolicy(selectedNode.id, policy)}
              onDelete={() => selectedNode && mutatorsRef.current?.remove(selectedNode.id)}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <RunPanel result={run.data ?? null} running={run.isPending} error={runError} />
          </div>
        </aside>
      </div>
    </div>
  );
}
