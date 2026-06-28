import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  Panel,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { Box, Boxes, Redo2, Undo2 } from 'lucide-react';
import type { NodePolicy, NodeRunStatus, Workflow, WorkflowDetail, WorkflowGraph, WorkflowNode } from '@shared/workflow';
import { nodeTypes } from './WorkflowNodeView';
import { DND_MIME } from './NodePalette';
import { NODE_META } from './node-meta';
import { isElementNode, toFlow, toGraph, type FlowNode } from './graph-mapping';
import { cloneSelection } from './selection-clone';
import { groupSelection, ungroup } from './grouping';
import {
  type History,
  canRedo,
  canUndo,
  commit as commitHistory,
  initHistory,
  redo as redoHistory,
  replace as replaceHistory,
  undo as undoHistory,
} from './history';

interface WorkflowCanvasProps {
  workflow: WorkflowDetail;
  workflows: Workflow[];
  statuses: Record<string, NodeRunStatus>;
  /** Reports the latest graph and selected node up to the page. */
  onGraphChange: (graph: WorkflowGraph) => void;
  onSelect: (node: FlowNode | null) => void;
  /** Bridge so the page's inspector can mutate the selected node. */
  registerMutators: (m: {
    rename: (id: string, name: string) => void;
    setConfig: (id: string, config: WorkflowNode['config']) => void;
    setPolicy: (id: string, policy: NodePolicy | undefined) => void;
    remove: (id: string) => void;
  }) => void;
}

interface GraphState {
  nodes: Node[];
  edges: Edge[];
}

function uuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `n-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const isTyping = (el: EventTarget | null): boolean =>
  el instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);

/**
 * The React Flow editing surface. Per ADR-0005 it carries no execution
 * semantics: it edits the domain graph and reports changes upward; the
 * main-process engine runs the result. It adds an undo/redo history, a
 * clipboard, and node grouping over the canvas.
 */
function Canvas({
  workflow,
  statuses,
  onGraphChange,
  onSelect,
  registerMutators,
}: WorkflowCanvasProps): JSX.Element {
  const initial = useMemo<GraphState>(() => {
    const f = toFlow(workflow.graph);
    return {
      nodes: f.nodes.map((n) => (n.type === 'group' ? n : { ...n, deletable: n.data.kind !== 'start' })),
      edges: f.edges,
    };
  }, [workflow.id]);

  const [history, setHistory] = useState<History<GraphState>>(() => initHistory(initial));
  const { nodes, edges } = history.present;
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const { screenToFlowPosition } = useReactFlow();

  // Latest values for the keyboard handler (avoids stale closures / rebinding).
  const presentRef = useRef<GraphState>(history.present);
  const selectedRef = useRef<Set<string>>(selectedIds);
  const clipboardRef = useRef<GraphState | null>(null);
  presentRef.current = history.present;
  selectedRef.current = selectedIds;

  // Reseed when the user opens a different workflow.
  useEffect(() => {
    setHistory(initHistory(initial));
    setSelectedIds(new Set());
    onSelect(null);
  }, [initial]);

  // Overlay run statuses onto node cards whenever a run completes.
  useEffect(() => {
    setHistory((h) =>
      replaceHistory(h, {
        ...h.present,
        nodes: h.present.nodes.map((n) =>
          isElementNode(n) && statuses[n.id] !== n.data.status
            ? { ...n, data: { ...n.data, status: statuses[n.id] } }
            : n,
        ),
      }),
    );
  }, [statuses]);

  // Debounced report of the current graph upward (keeps drag frames cheap).
  useEffect(() => {
    const id = setTimeout(() => onGraphChange(toGraph(nodes, edges)), 120);
    return () => clearTimeout(id);
  }, [nodes, edges, onGraphChange]);

  const apply = useCallback((producer: (s: GraphState) => GraphState, doCommit: boolean) => {
    setHistory((h) => {
      const next = producer(h.present);
      return doCommit ? commitHistory(h, next) : replaceHistory(h, next);
    });
  }, []);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const worthy = changes.some(
        (c) => c.type === 'remove' || (c.type === 'position' && c.dragging === false),
      );
      apply((s) => ({ ...s, nodes: applyNodeChanges(changes, s.nodes) }), worthy);
    },
    [apply],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const worthy = changes.some((c) => c.type === 'remove');
      apply((s) => ({ ...s, edges: applyEdgeChanges(changes, s.edges) }), worthy);
    },
    [apply],
  );

  const onConnect = useCallback(
    (c: Connection) => apply((s) => ({ ...s, edges: addEdge(c, s.edges) }), true),
    [apply],
  );

  // Snapshot before a drag so undo returns to the pre-drag layout.
  const onNodeDragStart = useCallback(() => {
    setHistory((h) => ({ past: [...h.past, h.present], present: h.present, future: [] }));
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const kind = event.dataTransfer.getData(DND_MIME) as WorkflowNode['kind'];
      if (!kind || !NODE_META[kind]) return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const meta = NODE_META[kind];
      const node: FlowNode = {
        id: uuid(),
        type: 'workbench',
        position,
        deletable: kind !== 'start',
        selected: true,
        data: { kind, name: meta.label, config: meta.defaultConfig() },
      };
      // Add the node selected (and deselect the rest) so its inspector opens immediately.
      apply((s) => ({ ...s, nodes: s.nodes.map((n): Node => ({ ...n, selected: false })).concat(node) }), true);
      setSelectedIds(new Set([node.id]));
    },
    [screenToFlowPosition, apply],
  );

  // Keep the page's inspector in sync with the selected node's *current* data,
  // not just on selection change — so importing a request or editing config is
  // reflected immediately in the details panel.
  useEffect(() => {
    if (selectedIds.size !== 1) {
      onSelect(null);
      return;
    }
    const id = [...selectedIds][0];
    const node = nodes.find((n) => n.id === id);
    onSelect(node && isElementNode(node) ? node : null);
  }, [nodes, selectedIds, onSelect]);

  // --- Clipboard ---

  const copy = useCallback(() => {
    const ids = selectedRef.current;
    const els = presentRef.current.nodes.filter(
      (n): n is FlowNode => isElementNode(n) && ids.has(n.id) && n.data.kind !== 'start',
    );
    if (els.length === 0) return;
    const elIds = new Set(els.map((n) => n.id));
    const internal = presentRef.current.edges.filter((e) => elIds.has(e.source) && elIds.has(e.target));
    clipboardRef.current = { nodes: els, edges: internal };
  }, []);

  const pasteClipboard = useCallback(() => {
    const clip = clipboardRef.current;
    if (!clip) return;
    const ids = new Set(clip.nodes.map((n) => n.id));
    const cloned = cloneSelection(clip.nodes as FlowNode[], clip.edges, ids, uuid, { x: 32, y: 32 });
    apply(
      (s) => ({
        nodes: s.nodes.map((n): Node => ({ ...n, selected: false })).concat(cloned.nodes),
        edges: s.edges.map((e): Edge => ({ ...e, selected: false })).concat(cloned.edges),
      }),
      true,
    );
  }, [apply]);

  const cut = useCallback(() => {
    copy();
    const ids = selectedRef.current;
    apply(
      (s) => ({
        nodes: s.nodes.filter(
          (n) => !(ids.has(n.id) && isElementNode(n) && n.data.kind !== 'start'),
        ),
        edges: s.edges.filter((e) => !ids.has(e.source) && !ids.has(e.target)),
      }),
      true,
    );
  }, [copy, apply]);

  const duplicate = useCallback(() => {
    copy();
    pasteClipboard();
  }, [copy, pasteClipboard]);

  // --- Grouping ---

  const doGroup = useCallback(() => {
    apply((s) => ({ ...s, nodes: groupSelection(s.nodes, selectedRef.current, uuid(), 'Group') }), true);
  }, [apply]);

  const doUngroup = useCallback(() => {
    const ids = selectedRef.current;
    const groupId =
      presentRef.current.nodes.find((n) => n.type === 'group' && ids.has(n.id))?.id ??
      presentRef.current.nodes.find((n) => isElementNode(n) && ids.has(n.id) && n.parentNode)?.parentNode;
    if (groupId) apply((s) => ({ ...s, nodes: ungroup(s.nodes, groupId) }), true);
  }, [apply]);

  const doUndo = useCallback(() => setHistory((h) => undoHistory(h)), []);
  const doRedo = useCallback(() => setHistory((h) => redoHistory(h)), []);

  // --- Inspector bridge ---

  useEffect(() => {
    registerMutators({
      rename: (id, name) =>
        apply(
          (s) => ({
            ...s,
            nodes: s.nodes.map((n) =>
              n.id === id && isElementNode(n) ? { ...n, data: { ...n.data, name } } : n,
            ),
          }),
          true,
        ),
      setConfig: (id, config) =>
        apply(
          (s) => ({
            ...s,
            nodes: s.nodes.map((n) =>
              n.id === id && isElementNode(n) ? { ...n, data: { ...n.data, config } } : n,
            ),
          }),
          true,
        ),
      setPolicy: (id, policy) =>
        apply(
          (s) => ({
            ...s,
            nodes: s.nodes.map((n) =>
              n.id === id && isElementNode(n) ? { ...n, data: { ...n.data, policy } } : n,
            ),
          }),
          true,
        ),
      remove: (id) =>
        apply(
          (s) => ({
            nodes: s.nodes.filter((n) => n.id !== id),
            edges: s.edges.filter((e) => e.source !== id && e.target !== id),
          }),
          true,
        ),
    });
  }, [registerMutators, apply]);

  // --- Keyboard shortcuts ---

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isTyping(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        doUndo();
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault();
        doRedo();
      } else if (key === 'c') {
        copy();
      } else if (key === 'x') {
        cut();
      } else if (key === 'v') {
        pasteClipboard();
      } else if (key === 'd') {
        e.preventDefault();
        duplicate();
      } else if (key === 'g') {
        e.preventDefault();
        if (e.shiftKey) doUngroup();
        else doGroup();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doUndo, doRedo, copy, cut, pasteClipboard, duplicate, doGroup, doUngroup]);

  const groupableCount = useMemo(
    () =>
      nodes.filter((n) => isElementNode(n) && selectedIds.has(n.id) && !n.parentNode).length,
    [nodes, selectedIds],
  );

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStart={onNodeDragStart}
        onSelectionChange={({ nodes: sel }: { nodes: Node[]; edges: Edge[] }) => {
          setSelectedIds(new Set(sel.map((n: Node) => n.id)));
        }}
        onDrop={onDrop}
        onDragOver={(e: React.DragEvent) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }}
        deleteKeyCode={['Backspace', 'Delete']}
        onlyRenderVisibleElements
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Panel position="top-left" className="flex gap-1">
          <ToolbarButton label="Undo (Ctrl+Z)" onClick={doUndo} disabled={!canUndo(history)}>
            <Undo2 size={15} />
          </ToolbarButton>
          <ToolbarButton label="Redo (Ctrl+Shift+Z)" onClick={doRedo} disabled={!canRedo(history)}>
            <Redo2 size={15} />
          </ToolbarButton>
          <ToolbarButton label="Group (Ctrl+G)" onClick={doGroup} disabled={groupableCount < 2}>
            <Boxes size={15} />
          </ToolbarButton>
          <ToolbarButton label="Ungroup (Ctrl+Shift+G)" onClick={doUngroup} disabled={selectedIds.size === 0}>
            <Box size={15} />
          </ToolbarButton>
        </Panel>
        <Background gap={16} />
        <Controls />
        <MiniMap pannable zoomable className="!bg-surface" />
      </ReactFlow>
    </div>
  );
}

function ToolbarButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface text-fg hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/** React Flow requires a provider in scope for coordinate projection. */
export function WorkflowCanvas(props: WorkflowCanvasProps): JSX.Element {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

export type { FlowNode };
