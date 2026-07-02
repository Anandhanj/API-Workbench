import { useState } from 'react';
import {
  ChevronRight,
  Copy,
  Folder as FolderIcon,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Star,
  Trash2,
} from 'lucide-react';
import type { HttpMethod, TreeNode } from '@shared/collection';
import { cn } from '../../lib/cn';
import { ContextMenu, type MenuItem } from '../../components/menu/ContextMenu';
import { endpointLabel } from './request-label';

const DRAG_TYPE = 'application/x-awb-request';

/**
 * Filter a flat tree to the nodes matching `query`, keeping each match's ancestor
 * folders (so the folder structure is visible) and, for a matched folder, all of
 * its descendants (so you can see what it contains). Requests match on name or
 * URL, folders on name. Returns the input order-preserved; empty query returns all.
 */
export function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childrenOf = new Map<string | null, TreeNode[]>();
  for (const n of nodes) {
    const list = childrenOf.get(n.parentId) ?? [];
    list.push(n);
    childrenOf.set(n.parentId, list);
  }

  const keep = new Set<string>();
  const addAncestors = (node: TreeNode): void => {
    let pid = node.parentId;
    while (pid && !keep.has(pid)) {
      keep.add(pid);
      pid = byId.get(pid)?.parentId ?? null;
    }
  };
  const addDescendants = (id: string): void => {
    for (const child of childrenOf.get(id) ?? []) {
      if (keep.has(child.id)) continue;
      keep.add(child.id);
      if (child.type === 'folder') addDescendants(child.id);
    }
  };

  for (const node of nodes) {
    const hit =
      node.type === 'request'
        ? node.name.toLowerCase().includes(q) || node.url.toLowerCase().includes(q)
        : node.name.toLowerCase().includes(q);
    if (!hit) continue;
    keep.add(node.id);
    addAncestors(node);
    if (node.type === 'folder') addDescendants(node.id);
  }

  return nodes.filter((n) => keep.has(n.id));
}

/** The minimal request info passed up when a request is opened. */
export interface OpenedRequest {
  id: string;
  name: string;
  method: HttpMethod;
  url: string;
}

const METHOD_COLOR: Record<string, string> = {
  GET: 'text-success',
  POST: 'text-warning',
  PUT: 'text-accent',
  PATCH: 'text-violet-400',
  DELETE: 'text-danger',
  HEAD: 'text-muted',
  OPTIONS: 'text-muted',
};

export interface CollectionTreeViewProps {
  nodes: TreeNode[];
  expandedFolders: Set<string>;
  /** When true, every folder renders expanded regardless of `expandedFolders` (used while searching). */
  forceExpand?: boolean;
  selectedId?: string | null;
  /** The currently selected folder (its auth panel is open), highlighted in the tree. */
  selectedFolderId?: string | null;
  baseDepth?: number;
  onToggleFolder: (id: string) => void;
  /** Select a folder to open its authorization panel. Falls back to expand when absent. */
  onOpenFolder?: (id: string, name: string) => void;
  onOpenRequest: (request: OpenedRequest) => void;
  onToggleFavorite?: (id: string) => void;
  onDeleteFolder?: (id: string, name: string) => void;
  onDeleteRequest?: (id: string, name: string) => void;
  onRenameFolder?: (id: string, name: string) => void;
  onRenameRequest?: (id: string, name: string) => void;
  onDuplicateRequest?: (id: string) => void;
  /** Move a request into a folder (or to the collection root when null). */
  onMoveRequest?: (id: string, folderId: string | null) => void;
  /** Create a subfolder under `parentId` (a folder in this collection). */
  onAddFolder?: (parentId: string) => void;
}

const ICON = 13;

/**
 * Recursive, expand/collapse tree of a collection's folders and requests. Row
 * actions (rename, duplicate, delete, favorite) live in a "⋯" / right-click
 * context menu; requests are draggable into folders. Children render only when
 * their folder is expanded.
 */
export function CollectionTreeView({
  nodes,
  expandedFolders,
  forceExpand = false,
  selectedId,
  selectedFolderId,
  baseDepth = 1,
  onToggleFolder,
  onOpenFolder,
  onOpenRequest,
  onToggleFavorite,
  onDeleteFolder,
  onDeleteRequest,
  onRenameFolder,
  onRenameRequest,
  onDuplicateRequest,
  onMoveRequest,
  onAddFolder,
}: CollectionTreeViewProps): JSX.Element {
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | 'root' | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  const readDragId = (e: React.DragEvent): string => e.dataTransfer.getData(DRAG_TYPE);
  const openAt = (x: number, y: number, items: MenuItem[]): void => {
    if (items.length > 0) setMenu({ x, y, items });
  };
  const openFromButton = (e: React.MouseEvent, items: MenuItem[]): void => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    openAt(r.left, r.bottom + 2, items);
  };

  const commit = (originalName: string, rename?: (id: string, name: string) => void): void => {
    if (editing && rename) {
      const next = editing.name.trim();
      if (next && next !== originalName) rename(editing.id, next);
    }
    setEditing(null);
  };

  const renameInput = (
    originalName: string,
    rename?: (id: string, name: string) => void,
  ): JSX.Element => (
    <input
      autoFocus
      value={editing?.name ?? ''}
      onChange={(e) => setEditing((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => commit(originalName, rename)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit(originalName, rename);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setEditing(null);
        }
      }}
      className="min-w-0 flex-1 rounded border border-accent bg-bg px-1 py-0.5 text-sm outline-none"
    />
  );

  const folderMenu = (node: Extract<TreeNode, { type: 'folder' }>): MenuItem[] => [
    ...(onAddFolder
      ? [
          {
            label: 'New subfolder',
            icon: <FolderPlus size={ICON} />,
            onSelect: () => onAddFolder(node.id),
          },
        ]
      : []),
    ...(onRenameFolder
      ? [
          {
            label: 'Rename',
            icon: <Pencil size={ICON} />,
            onSelect: () => setEditing({ id: node.id, name: node.name }),
          },
        ]
      : []),
    ...(onDeleteFolder
      ? [
          {
            label: 'Delete',
            icon: <Trash2 size={ICON} />,
            danger: true,
            onSelect: () => onDeleteFolder(node.id, node.name),
          },
        ]
      : []),
  ];

  const requestMenu = (node: Extract<TreeNode, { type: 'request' }>): MenuItem[] => [
    {
      label: 'Open',
      icon: <ChevronRight size={ICON} />,
      onSelect: () =>
        onOpenRequest({ id: node.id, name: node.name, method: node.method, url: node.url }),
    },
    ...(onRenameRequest
      ? [
          {
            label: 'Rename',
            icon: <Pencil size={ICON} />,
            onSelect: () => setEditing({ id: node.id, name: node.name }),
          },
        ]
      : []),
    ...(onDuplicateRequest
      ? [
          {
            label: 'Duplicate',
            icon: <Copy size={ICON} />,
            onSelect: () => onDuplicateRequest(node.id),
          },
        ]
      : []),
    ...(onToggleFavorite
      ? [
          {
            label: node.favorite ? 'Remove from favorites' : 'Add to favorites',
            icon: <Star size={ICON} />,
            onSelect: () => onToggleFavorite(node.id),
          },
        ]
      : []),
    ...(onDeleteRequest
      ? [
          {
            label: 'Delete',
            icon: <Trash2 size={ICON} />,
            danger: true,
            onSelect: () => onDeleteRequest(node.id, node.name),
          },
        ]
      : []),
  ];

  const childrenByParent = new Map<string | null, TreeNode[]>();
  for (const node of nodes) {
    const list = childrenByParent.get(node.parentId) ?? [];
    list.push(node);
    childrenByParent.set(node.parentId, list);
  }

  const renderRows = (parentId: string | null, depth: number): JSX.Element[] => {
    const children = childrenByParent.get(parentId) ?? [];
    return children.flatMap((node) => {
      const indent = 8 + depth * 14;
      const isEditing = editing?.id === node.id;

      if (node.type === 'folder') {
        const open = forceExpand || expandedFolders.has(node.id);
        const items = folderMenu(node);
        return [
          <div
            key={node.id}
            data-testid="tree-folder"
            style={{ paddingLeft: indent }}
            onContextMenu={(e) => {
              e.preventDefault();
              openAt(e.clientX, e.clientY, items);
            }}
            onDragOver={(e) => {
              if (!onMoveRequest) return;
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = 'move';
              setDropTarget(node.id);
            }}
            onDragLeave={() => setDropTarget((t) => (t === node.id ? null : t))}
            onDrop={(e) => {
              if (!onMoveRequest) return;
              e.preventDefault();
              e.stopPropagation();
              setDropTarget(null);
              const id = readDragId(e);
              if (id && id !== node.id) onMoveRequest(id, node.id);
            }}
            className={cn(
              'group flex items-center pr-1 text-sm text-fg hover:bg-surface-2',
              node.id === selectedFolderId && 'bg-surface-2',
              dropTarget === node.id && 'bg-accent/20 ring-1 ring-inset ring-accent',
            )}
          >
            <ChevronRight
              size={14}
              onClick={() => !isEditing && onToggleFolder(node.id)}
              className={cn(
                'shrink-0 cursor-pointer text-muted transition-transform',
                open && 'rotate-90',
              )}
            />
            <FolderIcon size={15} className="ml-1.5 shrink-0 text-accent" />
            {isEditing ? (
              <span className="ml-1.5 flex min-w-0 flex-1">
                {renameInput(node.name, onRenameFolder)}
              </span>
            ) : (
              <button
                type="button"
                onClick={() =>
                  onOpenFolder ? onOpenFolder(node.id, node.name) : onToggleFolder(node.id)
                }
                className="ml-1.5 min-w-0 flex-1 truncate py-1 text-left"
              >
                {node.name}
              </button>
            )}
            {!isEditing && items.length > 0 && (
              <button
                type="button"
                aria-label={`Folder actions for ${node.name}`}
                className="px-1 opacity-0 group-hover:opacity-100"
                onClick={(e) => openFromButton(e, items)}
              >
                <MoreHorizontal size={15} className="text-muted hover:text-fg" />
              </button>
            )}
          </div>,
          ...(open ? renderRows(node.id, depth + 1) : []),
        ];
      }

      const items = requestMenu(node);
      return [
        <div
          key={node.id}
          data-testid="tree-request"
          draggable={!!onMoveRequest && !isEditing}
          onDragStart={(e) => {
            e.dataTransfer.setData(DRAG_TYPE, node.id);
            e.dataTransfer.effectAllowed = 'move';
          }}
          {...(onMoveRequest
            ? {
                // Dropping onto a request targets its containing folder (or the
                // collection root), so the whole row area — not just the thin
                // folder header — is a valid drop zone for that folder.
                onDragOver: (e: React.DragEvent) => {
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = 'move';
                  setDropTarget(node.parentId ?? 'root');
                },
                onDragLeave: () =>
                  setDropTarget((t) => (t === (node.parentId ?? 'root') ? null : t)),
                onDrop: (e: React.DragEvent) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDropTarget(null);
                  const id = readDragId(e);
                  if (id && id !== node.id) onMoveRequest(id, node.parentId);
                },
              }
            : {})}
          onContextMenu={(e) => {
            e.preventDefault();
            openAt(e.clientX, e.clientY, items);
          }}
          className={cn(
            'group flex items-center pr-1 text-sm hover:bg-surface-2',
            !!onMoveRequest && !isEditing && 'cursor-grab',
            node.id === selectedId && 'bg-surface-2',
          )}
        >
          {isEditing ? (
            <span
              style={{ paddingLeft: indent + 18 }}
              className="flex min-w-0 flex-1 items-center gap-2 py-1"
            >
              <span
                className={cn(
                  'w-12 shrink-0 text-[10px] font-bold tracking-wide',
                  METHOD_COLOR[node.method] ?? 'text-muted',
                )}
              >
                {node.method}
              </span>
              {renameInput(node.name, onRenameRequest)}
            </span>
          ) : (
            <button
              type="button"
              onClick={() =>
                onOpenRequest({ id: node.id, name: node.name, method: node.method, url: node.url })
              }
              style={{ paddingLeft: indent + 18 }}
              className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
            >
              <span
                className={cn(
                  'w-12 shrink-0 text-[10px] font-bold tracking-wide',
                  METHOD_COLOR[node.method] ?? 'text-muted',
                )}
              >
                {node.method}
              </span>
              <span
                className={cn('min-w-0 flex-1 truncate', !node.name.trim() && 'text-muted')}
              >
                {node.name.trim() || endpointLabel(node.url)}
              </span>
            </button>
          )}
          {!isEditing && onToggleFavorite && (
            <button
              type="button"
              aria-label={node.favorite ? `Unfavorite ${node.name}` : `Favorite ${node.name}`}
              className="px-1"
              onClick={() => onToggleFavorite(node.id)}
            >
              <Star
                size={13}
                className={cn(
                  node.favorite
                    ? 'fill-warning text-warning'
                    : 'text-muted opacity-0 group-hover:opacity-100',
                )}
              />
            </button>
          )}
          {!isEditing && items.length > 0 && (
            <button
              type="button"
              aria-label={`Request actions for ${node.name}`}
              className="px-1 opacity-0 group-hover:opacity-100"
              onClick={(e) => openFromButton(e, items)}
            >
              <MoreHorizontal size={15} className="text-muted hover:text-fg" />
            </button>
          )}
        </div>,
      ];
    });
  };

  const rootDropProps = onMoveRequest
    ? {
        onDragOver: (e: React.DragEvent) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setDropTarget('root');
        },
        onDragLeave: () => setDropTarget((t) => (t === 'root' ? null : t)),
        onDrop: (e: React.DragEvent) => {
          e.preventDefault();
          setDropTarget(null);
          const id = readDragId(e);
          if (id) onMoveRequest(id, null);
        },
      }
    : {};

  const menuEl = menu ? (
    <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
  ) : null;

  if (nodes.length === 0) {
    return (
      <>
        <p
          {...rootDropProps}
          style={{ paddingLeft: 8 + baseDepth * 14 }}
          className={cn('py-1 text-xs text-muted', dropTarget === 'root' && 'rounded bg-accent/10')}
        >
          Empty
        </p>
        {menuEl}
      </>
    );
  }
  return (
    <div {...rootDropProps} className={cn(dropTarget === 'root' && 'rounded bg-accent/10')}>
      {renderRows(null, baseDepth)}
      {menuEl}
    </div>
  );
}
