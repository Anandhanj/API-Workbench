import { useMemo, useState } from 'react';
import { Boxes, ChevronRight, FolderPlus, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import type { Collection, TreeNode } from '@shared/collection';
import { cn } from '../../lib/cn';
import { usePersistentState } from '../../lib/use-persistent-state';
import { ContextMenu, type MenuItem } from '../../components/menu/ContextMenu';
import { useTree } from './use-collections';
import { CollectionTreeView, type OpenedRequest } from './CollectionTreeView';

export interface CollectionNodeProps {
  collection: Collection;
  selectedRequestId: string | null;
  /** The folder whose authorization panel is open (highlighted in the tree). */
  selectedFolderId?: string | null;
  /**
   * Search mode: when set, the collection renders expanded with these
   * pre-filtered nodes and all folders forced open (bypassing its own lazy tree
   * load and persisted expand state).
   */
  searchNodes?: TreeNode[];
  onOpenRequest: (request: OpenedRequest, collectionId: string) => void;
  onToggleFavorite: (id: string) => void;
  onAddRequest: (collectionId: string) => void;
  /** Create a folder in this collection; `parentId` is null for a root folder. */
  onAddFolder: (collectionId: string, parentId: string | null) => void;
  onRenameCollection: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onDeleteFolder: (id: string, name: string) => void;
  onDeleteRequest: (id: string, name: string) => void;
  onRenameFolder: (id: string, name: string) => void;
  onRenameRequest: (id: string, name: string) => void;
  onDuplicateRequest: (id: string) => void;
  onMoveRequest: (id: string, folderId: string | null) => void;
  /** Select a folder to open its authorization panel. */
  onOpenFolder?: (id: string, name: string) => void;
}

/**
 * One collection in the explorer: an expandable root row that, when open,
 * lazily loads its tree and renders the nested folders/requests.
 */
export function CollectionNode({
  collection,
  selectedRequestId,
  selectedFolderId,
  searchNodes,
  onOpenRequest,
  onOpenFolder,
  onToggleFavorite,
  onAddRequest,
  onAddFolder,
  onRenameCollection,
  onDelete,
  onDeleteFolder,
  onDeleteRequest,
  onRenameFolder,
  onRenameRequest,
  onDuplicateRequest,
  onMoveRequest,
}: CollectionNodeProps): JSX.Element {
  const searching = searchNodes !== undefined;
  // Expand state is persisted per collection so it survives an app restart.
  const [open, setOpen] = usePersistentState(`awb.expand.col.${collection.id}`, false);
  const [expandedList, setExpandedList] = usePersistentState<string[]>(
    `awb.expand.folders.${collection.id}`,
    [],
  );
  const expandedFolders = useMemo(() => new Set(expandedList), [expandedList]);
  // In search mode the parent supplies the (filtered) nodes; otherwise load lazily on expand.
  const tree = useTree(!searching && open ? collection.id : null);
  const treeNodes = searchNodes ?? tree.data ?? [];
  const showTree = searching || open;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // Inline rename: holds the draft name while editing, or null when not editing.
  const [renameDraft, setRenameDraft] = useState<string | null>(null);

  const commitRename = (): void => {
    if (renameDraft !== null) {
      const next = renameDraft.trim();
      if (next && next !== collection.name) onRenameCollection(collection.id, next);
    }
    setRenameDraft(null);
  };

  const toggleFolder = (id: string): void =>
    setExpandedList((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const expandFolder = (id: string): void =>
    setExpandedList((prev) => (prev.includes(id) ? prev : [...prev, id]));

  const menuItems: MenuItem[] = [
    { label: 'Add request', icon: <Plus size={13} />, onSelect: () => onAddRequest(collection.id) },
    {
      label: 'Add folder',
      icon: <FolderPlus size={13} />,
      onSelect: () => {
        onAddFolder(collection.id, null);
        if (!open) setOpen(true);
      },
    },
    {
      label: 'Rename',
      icon: <Pencil size={13} />,
      onSelect: () => setRenameDraft(collection.name),
    },
    { label: 'Delete', icon: <Trash2 size={13} />, danger: true, onSelect: () => onDelete(collection.id) },
  ];

  return (
    <div>
      <div
        className="group flex items-center pr-2 hover:bg-surface-2"
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {renameDraft !== null ? (
          <span className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-2 text-sm font-medium">
            <ChevronRight
              size={14}
              className={cn('shrink-0 text-muted transition-transform', showTree && 'rotate-90')}
            />
            <Boxes size={15} className="shrink-0 text-accent" />
            <input
              autoFocus
              value={renameDraft}
              aria-label={`Rename ${collection.name}`}
              onChange={(e) => setRenameDraft(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitRename();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setRenameDraft(null);
                }
              }}
              className="min-w-0 flex-1 rounded border border-accent bg-bg px-1 py-0.5 text-sm outline-none"
            />
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            onDoubleClick={() => setRenameDraft(collection.name)}
            disabled={searching}
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-2 text-left text-sm font-medium disabled:cursor-default"
          >
            <ChevronRight
              size={14}
              className={cn('shrink-0 text-muted transition-transform', showTree && 'rotate-90')}
            />
            <Boxes size={15} className="shrink-0 text-accent" />
            <span className="truncate">{collection.name}</span>
          </button>
        )}
        <button
          type="button"
          aria-label={`Add folder to ${collection.name}`}
          className="px-1 opacity-0 group-hover:opacity-100"
          onClick={() => {
            onAddFolder(collection.id, null);
            if (!open) setOpen(true);
          }}
        >
          <FolderPlus size={14} className="text-muted hover:text-fg" />
        </button>
        <button
          type="button"
          aria-label={`Add request to ${collection.name}`}
          className="px-1 opacity-0 group-hover:opacity-100"
          onClick={() => onAddRequest(collection.id)}
        >
          <Plus size={14} className="text-muted hover:text-fg" />
        </button>
        <button
          type="button"
          aria-label={`Collection actions for ${collection.name}`}
          className="px-1 opacity-0 group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.left, y: r.bottom + 2 });
          }}
        >
          <MoreHorizontal size={15} className="text-muted hover:text-fg" />
        </button>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}

      {showTree && (
        <CollectionTreeView
          nodes={treeNodes}
          expandedFolders={expandedFolders}
          forceExpand={searching}
          selectedId={selectedRequestId}
          selectedFolderId={selectedFolderId}
          onToggleFolder={toggleFolder}
          onOpenFolder={onOpenFolder}
          onOpenRequest={(req) => onOpenRequest(req, collection.id)}
          onToggleFavorite={onToggleFavorite}
          onAddFolder={(parentId) => {
            onAddFolder(collection.id, parentId);
            if (parentId) expandFolder(parentId);
          }}
          onDeleteFolder={onDeleteFolder}
          onDeleteRequest={onDeleteRequest}
          onRenameFolder={onRenameFolder}
          onRenameRequest={onRenameRequest}
          onDuplicateRequest={onDuplicateRequest}
          onMoveRequest={onMoveRequest}
        />
      )}
    </div>
  );
}
