import { useMemo, useState } from 'react';
import { Boxes, ChevronRight, MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import type { Collection, TreeNode } from '@shared/collection';
import { cn } from '../../lib/cn';
import { usePersistentState } from '../../lib/use-persistent-state';
import { ContextMenu, type MenuItem } from '../../components/menu/ContextMenu';
import { useTree } from './use-collections';
import { CollectionTreeView, type OpenedRequest } from './CollectionTreeView';

export interface CollectionNodeProps {
  collection: Collection;
  selectedRequestId: string | null;
  /**
   * Search mode: when set, the collection renders expanded with these
   * pre-filtered nodes and all folders forced open (bypassing its own lazy tree
   * load and persisted expand state).
   */
  searchNodes?: TreeNode[];
  onOpenRequest: (request: OpenedRequest, collectionId: string) => void;
  onToggleFavorite: (id: string) => void;
  onAddRequest: (collectionId: string) => void;
  onDelete: (id: string) => void;
  onDeleteFolder: (id: string, name: string) => void;
  onDeleteRequest: (id: string, name: string) => void;
  onRenameFolder: (id: string, name: string) => void;
  onRenameRequest: (id: string, name: string) => void;
  onDuplicateRequest: (id: string) => void;
  onMoveRequest: (id: string, folderId: string | null) => void;
}

/**
 * One collection in the explorer: an expandable root row that, when open,
 * lazily loads its tree and renders the nested folders/requests.
 */
export function CollectionNode({
  collection,
  selectedRequestId,
  searchNodes,
  onOpenRequest,
  onToggleFavorite,
  onAddRequest,
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

  const toggleFolder = (id: string): void =>
    setExpandedList((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const menuItems: MenuItem[] = [
    { label: 'Add request', icon: <Plus size={13} />, onSelect: () => onAddRequest(collection.id) },
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
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
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
          onToggleFolder={toggleFolder}
          onOpenRequest={(req) => onOpenRequest(req, collection.id)}
          onToggleFavorite={onToggleFavorite}
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
