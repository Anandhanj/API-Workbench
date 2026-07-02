import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, History, Loader2, Pencil, Plus, RefreshCw, Search } from 'lucide-react';
import { usePersistentState } from '../../lib/use-persistent-state';
import type { VersionDiff } from '@shared/version';
import { isBridgeAvailable } from '../../lib/ipc';
import { useActiveSelection, useWorkspaceDetail } from '../workspaces/use-workspaces';
import { CollectionNode } from './CollectionNode';
import { filterTree, type OpenedRequest } from './CollectionTreeView';
import { requestDisplayName } from './request-label';
import { cn } from '../../lib/cn';
import { RequestEditor } from '../runner/RequestEditor';
import { RequestVariablesUsedPanel } from './RequestVariablesUsedPanel';
import { detailToDraft, draftToDetails, type RequestDraft } from '../runner/build-request';
import { HTTP_REQUEST_TYPE } from '@shared/protocol';
import { Modal } from '../../components/menu/Modal';
import { ImportPanel } from './ImportPanel';
import { SyncPanel } from './SyncPanel';
import { VersionsPanel } from './VersionsPanel';
import { FolderAuthPanel } from './FolderAuthPanel';
import { useConfirm } from '../../components/confirm/ConfirmProvider';
import { useToast } from '../../components/toast/ToastProvider';
import { qualifiedContributionId } from '@shared/plugins';
import { usePluginContributions } from '../plugins/use-plugins';
import { useImport } from './use-import';
import { useSync } from './use-sync';
import { useVersions, useVersionMutations } from './use-versions';
import {
  useCollections,
  useCollectionMutations,
  useRequestDetail,
  useCollectionSource,
  useTrees,
} from './use-collections';

export function CollectionsPage(): JSX.Element {
  const bridge = isBridgeAvailable();
  const active = useActiveSelection();
  const projectId = active.data?.projectId ?? null;
  const workspaceDetail = useWorkspaceDetail(active.data?.workspaceId ?? null);
  const workspaceName = workspaceDetail.data?.workspace.name ?? null;
  const projectName = workspaceDetail.data?.projects.find((p) => p.id === projectId)?.name ?? null;
  const collections = useCollections(projectId);
  const mutations = useCollectionMutations(projectId);
  const importer = useImport(projectId);
  const syncer = useSync(projectId);
  // Plugin importers for the import dialog's format select (empty → hidden).
  const pluginImporters = usePluginContributions().importers.map((imp) => ({
    id: qualifiedContributionId(imp.pluginId, imp.id),
    label: imp.label,
  }));
  const confirm = useConfirm();
  const toast = useToast();

  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [newCollection, setNewCollection] = useState('');
  const [search, setSearch] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [showSync, setShowSync] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [selectedRequest, setSelectedRequest] = useState<
    (OpenedRequest & { collectionId: string }) | null
  >(null);
  // A selected folder opens its authorization panel (mutually exclusive with a request).
  const [selectedFolder, setSelectedFolder] = useState<{ id: string; name: string } | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [diff, setDiff] = useState<{ versionId: string; data: VersionDiff } | null>(null);

  // Resizable left panel (persisted across restarts).
  const [leftWidth, setLeftWidth] = usePersistentState('awb.collections.leftWidth', 288);
  const [varsPanelCollapsed, setVarsPanelCollapsed] = usePersistentState(
    'awb.collections.varsPanelCollapsed',
    false,
  );
  const [liveDraft, setLiveDraft] = useState<RequestDraft | null>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault();
    const containerLeft = splitRef.current?.getBoundingClientRect().left ?? 0;
    const move = (ev: MouseEvent): void => {
      setLeftWidth(Math.min(640, Math.max(200, ev.clientX - containerLeft)));
    };
    const up = (): void => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  // Close the import dialog and clear the mutation result/error so a stale
  // "imported …" banner doesn't linger the next time it's opened.
  const closeImport = (): void => {
    setShowImport(false);
    importer.reset();
  };

  const commitName = (): void => {
    const next = nameDraft.trim();
    if (next && selectedRequest && next !== selectedRequest.name) {
      mutations.renameRequest.mutate({ id: selectedRequest.id, name: next });
      setSelectedRequest((prev) => (prev ? { ...prev, name: next } : prev));
    }
    setEditingName(false);
  };

  // Search across collection names, folder names, and request names/URLs. While a
  // query is active, every collection's tree is loaded so matches (and their
  // ancestor folders) can be shown; otherwise trees stay lazily loaded on expand.
  const q = search.trim().toLowerCase();
  const searching = q.length > 0;
  const allCollections = useMemo(() => collections.data ?? [], [collections.data]);
  const trees = useTrees(
    allCollections.map((c) => c.id),
    searching,
  );
  // `trees` is a new array each render; derive a stable signature from when each
  // tree's data last changed so the memo below only recomputes on real updates.
  const treesSignature = trees.map((t) => t.dataUpdatedAt).join(',');
  const searchResults = useMemo(() => {
    if (!searching) return null;
    return allCollections
      .map((c, i) => {
        const nodes = trees[i]?.data ?? [];
        const nameMatch = c.name.toLowerCase().includes(q);
        // A name match shows the whole tree; otherwise only the matching subtree.
        const shownNodes = nameMatch ? nodes : filterTree(nodes, q);
        return { collection: c, nodes: shownNodes, show: nameMatch || shownNodes.length > 0 };
      })
      .filter((r) => r.show);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searching, q, allCollections, treesSignature]);

  const versions = useVersions(collectionId);
  const versionMutations = useVersionMutations(collectionId);
  const requestDetail = useRequestDetail(selectedRequest?.id);
  const collectionSource = useCollectionSource(collectionId);

  // Reset the observed draft when switching requests (re-seeded from the saved
  // request until the editor reports its first live change).
  useEffect(() => {
    setLiveDraft(null);
  }, [selectedRequest?.id]);

  useEffect(() => {
    if (collections.data && collections.data.length > 0) {
      if (!collectionId || !collections.data.some((c) => c.id === collectionId)) {
        setCollectionId(collections.data[0].id);
      }
    } else if (collections.data && collections.data.length === 0) {
      setCollectionId(null);
    }
  }, [collections.data, collectionId]);

  if (!bridge) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <h1 className="text-2xl font-semibold">Collections</h1>
        <p className="mt-2 text-muted">
          Collection management requires the desktop database, available when running inside the
          application.
        </p>
      </div>
    );
  }

  if (!projectId) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <h1 className="text-2xl font-semibold">Collections</h1>
        <p className="mt-2 text-muted">
          Open a project in the Workspaces tab to manage collections.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col p-6">
      {(workspaceName || projectName) && (
        <nav aria-label="Breadcrumb" className="mb-1 flex items-center gap-1.5 text-xs text-muted">
          {workspaceName && (
            <span>
              {workspaceName} <span className="text-muted/70">(Workspace)</span>
            </span>
          )}
          {workspaceName && projectName && <span>›</span>}
          {projectName && (
            <span className="text-fg">
              {projectName} <span className="text-muted/70">(Project)</span>
            </span>
          )}
          <span>›</span>
          <span>Collections</span>
        </nav>
      )}
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Collections</h1>
        <button
          type="button"
          onClick={() => (showImport ? closeImport() : setShowImport(true))}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-2"
        >
          <Download size={15} /> Import OpenAPI
        </button>
      </div>

      {showImport && (
        <Modal title="Import OpenAPI" onClose={closeImport}>
          <ImportPanel
            bare
            busy={importer.isPending}
            result={importer.data ?? null}
            error={importer.error instanceof Error ? importer.error.message : null}
            importers={pluginImporters}
            onImport={(payload) => importer.mutate({ projectId, ...payload })}
          />
        </Modal>
      )}

      <div ref={splitRef} className="flex min-h-0 flex-1 items-stretch">
        <section
          aria-label="Collection list"
          style={{ width: leftWidth }}
          className="flex shrink-0 flex-col overflow-hidden pr-3"
        >
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!newCollection.trim()) return;
              mutations.createCollection.mutate({ projectId, name: newCollection.trim() });
              setNewCollection('');
            }}
          >
            <input
              value={newCollection}
              onChange={(e) => setNewCollection(e.target.value)}
              placeholder="New collection"
              aria-label="New collection name"
              className="min-w-0 flex-1 rounded-md border border-border bg-surface px-3 py-1.5 text-sm"
            />
            <button
              type="submit"
              aria-label="Create collection"
              className="rounded-md bg-accent px-3 py-1.5 text-sm text-accent-fg"
            >
              <Plus size={15} />
            </button>
          </form>

          <div className="relative mt-2">
            <Search
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search collections, folders, requests"
              aria-label="Search collections, folders, and requests"
              className="w-full rounded-md border border-border bg-surface py-1.5 pl-8 pr-3 text-sm"
            />
          </div>

          <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-md border border-border">
            {(searching
              ? (searchResults ?? []).map((r) => ({ collection: r.collection, searchNodes: r.nodes }))
              : allCollections.map((c) => ({ collection: c, searchNodes: undefined }))
            ).map(({ collection: c, searchNodes }) => (
              <CollectionNode
                key={c.id}
                collection={c}
                searchNodes={searchNodes}
                selectedRequestId={selectedRequest?.id ?? null}
                selectedFolderId={selectedFolder?.id ?? null}
                onOpenRequest={(req, colId) => {
                  setCollectionId(colId);
                  setSelectedFolder(null);
                  setSelectedRequest({ ...req, collectionId: colId });
                  setEditingName(false);
                  mutations.openRequest.mutate(req.id);
                }}
                onOpenFolder={(id, name) => {
                  setCollectionId(c.id);
                  setSelectedRequest(null);
                  setSelectedFolder({ id, name });
                }}
                onToggleFavorite={(id) => mutations.toggleFavorite.mutate(id)}
                onAddRequest={(colId) =>
                  mutations.createRequest.mutate({ collectionId: colId, name: 'New request' })
                }
                onAddFolder={(colId, parentId) =>
                  mutations.createFolder.mutate({
                    collectionId: colId,
                    parentId,
                    name: 'New folder',
                  })
                }
                onRenameCollection={(id, name) => mutations.renameCollection.mutate({ id, name })}
                onDelete={async (id) => {
                  if (
                    await confirm({
                      title: 'Delete collection',
                      message: `Delete collection "${c.name}" and everything in it? This cannot be undone.`,
                      confirmLabel: 'Delete',
                      danger: true,
                    })
                  ) {
                    mutations.deleteCollection.mutate(id);
                  }
                }}
                onDeleteFolder={async (id, name) => {
                  if (
                    await confirm({
                      title: 'Delete folder',
                      message: `Delete folder "${name}" and all of its requests? This cannot be undone.`,
                      confirmLabel: 'Delete',
                      danger: true,
                    })
                  ) {
                    mutations.deleteFolder.mutate(id);
                    if (selectedFolder?.id === id) setSelectedFolder(null);
                  }
                }}
                onDeleteRequest={async (id, name) => {
                  if (
                    await confirm({
                      title: 'Delete request',
                      message: `Delete request "${name}"? This cannot be undone.`,
                      confirmLabel: 'Delete',
                      danger: true,
                    })
                  ) {
                    mutations.deleteRequest.mutate(id);
                    if (selectedRequest?.id === id) setSelectedRequest(null);
                  }
                }}
                onRenameFolder={(id, name) => mutations.renameFolder.mutate({ id, name })}
                onRenameRequest={(id, name) => {
                  mutations.renameRequest.mutate({ id, name });
                  setSelectedRequest((prev) => (prev?.id === id ? { ...prev, name } : prev));
                }}
                onDuplicateRequest={(id) => mutations.duplicateRequest.mutate(id)}
                onMoveRequest={(id, folderId) => mutations.moveRequest.mutate({ id, folderId })}
              />
            ))}
            {collections.data?.length === 0 && (
              <p className="px-3 py-2 text-sm text-muted">No collections yet.</p>
            )}
            {searching && searchResults?.length === 0 && (
              <p className="px-3 py-2 text-sm text-muted">Nothing matches “{search.trim()}”.</p>
            )}
          </div>
        </section>

        <div
          role="separator"
          aria-label="Resize collection panel"
          aria-orientation="vertical"
          onMouseDown={startResize}
          className="group relative w-1 shrink-0 cursor-col-resize"
        >
          <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border group-hover:bg-accent" />
        </div>

        <section aria-label="Explorer" className="min-w-0 flex-1 overflow-y-auto pl-3">
          {selectedRequest ? (
            <div className="flex min-h-0 gap-3">
              <div className="min-w-0 flex-1">
                <div className="mb-3 flex items-center justify-between gap-2">
                  {editingName ? (
                    <input
                      autoFocus
                      value={nameDraft}
                      onChange={(e) => setNameDraft(e.target.value)}
                      onBlur={commitName}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          commitName();
                        } else if (e.key === 'Escape') {
                          setEditingName(false);
                        }
                      }}
                      placeholder="Request name"
                      aria-label="Request name"
                      className="min-w-0 flex-1 rounded border border-accent bg-bg px-2 py-1 text-sm outline-none"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setNameDraft(selectedRequest.name);
                        setEditingName(true);
                      }}
                      title="Rename request"
                      className="group flex min-w-0 items-center gap-1.5 text-left text-sm font-medium"
                    >
                      <span
                        className={cn('truncate', !selectedRequest.name.trim() && 'italic text-muted')}
                      >
                        {requestDisplayName(selectedRequest.name, selectedRequest.url)}
                      </span>
                      <Pencil size={12} className="shrink-0 text-muted group-hover:text-accent" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setSelectedRequest(null)}
                    className="shrink-0 text-xs text-muted hover:text-fg"
                  >
                    Close
                  </button>
                </div>
                {requestDetail.data ? (
                  <RequestEditor
                    key={selectedRequest.id}
                    initial={detailToDraft(requestDetail.data)}
                    scriptContext={{
                      collectionId: selectedRequest.collectionId,
                      requestId: selectedRequest.id,
                    }}
                    saving={mutations.saveRequest.isPending}
                    saved={mutations.saveRequest.isSuccess}
                    onDraftChange={setLiveDraft}
                    onSave={(draft) =>
                      mutations.saveRequest
                        .mutateAsync({
                          id: selectedRequest.id,
                          name: selectedRequest.name,
                          type: draft.requestType ?? HTTP_REQUEST_TYPE,
                          method: draft.method,
                          url: draft.url,
                          details: draftToDetails(draft),
                        })
                        .then(() => toast('Request saved'))
                        .catch(() => toast('Failed to save request', { type: 'error' }))
                    }
                  />
                ) : (
                  <p className="flex items-center gap-1.5 text-sm text-muted">
                    <Loader2 size={14} className="animate-spin" /> Loading request…
                  </p>
                )}
              </div>
              <RequestVariablesUsedPanel
                draft={liveDraft ?? (requestDetail.data ? detailToDraft(requestDetail.data) : null)}
                variableContext={{
                  ...(active.data?.workspaceId ? { workspaceId: active.data.workspaceId } : {}),
                  collectionId: selectedRequest.collectionId,
                  requestId: selectedRequest.id,
                }}
                collapsed={varsPanelCollapsed}
                onToggle={() => setVarsPanelCollapsed((v) => !v)}
              />
            </div>
          ) : selectedFolder ? (
            <FolderAuthPanel
              key={selectedFolder.id}
              folderId={selectedFolder.id}
              name={selectedFolder.name}
              onClose={() => setSelectedFolder(null)}
            />
          ) : collectionId ? (
            <>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowSync((v) => !v)}
                  aria-label="Sync collection"
                  className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-2"
                >
                  <RefreshCw size={15} /> Sync
                </button>
                <button
                  type="button"
                  onClick={() => setShowVersions((v) => !v)}
                  aria-label="Collection versions"
                  className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-2"
                >
                  <History size={15} /> Versions
                </button>
              </div>

              {showSync && (
                <Modal title="Synchronize collection" onClose={() => setShowSync(false)}>
                  <SyncPanel
                    key={`${collectionId}:${collectionSource.data?.sourceUrl ?? ''}`}
                    bare
                    busy={syncer.isPending}
                    result={syncer.data ?? null}
                    error={syncer.error instanceof Error ? syncer.error.message : null}
                    defaultUrl={collectionSource.data?.sourceUrl ?? null}
                    onSync={(payload) => syncer.mutate({ collectionId, ...payload })}
                  />
                </Modal>
              )}

              {showVersions && (
                <div className="mt-3">
                  <VersionsPanel
                    versions={versions.data ?? []}
                    busy={versionMutations.snapshot.isPending || versionMutations.restore.isPending}
                    error={
                      versionMutations.snapshot.error instanceof Error
                        ? versionMutations.snapshot.error.message
                        : versionMutations.restore.error instanceof Error
                          ? versionMutations.restore.error.message
                          : null
                    }
                    diff={diff}
                    onSnapshot={(label) =>
                      versionMutations.snapshot.mutate({
                        collectionId,
                        ...(label ? { label } : {}),
                      })
                    }
                    onRestore={(versionId) => versionMutations.restore.mutate(versionId)}
                    onDiff={(versionId) =>
                      versionMutations.diff.mutate(versionId, {
                        onSuccess: (data) => setDiff({ versionId, data }),
                      })
                    }
                  />
                </div>
              )}

              {!showSync && !showVersions && (
                <p className="mt-4 text-sm text-muted">
                  Select a request from the collection on the left to open it here.
                </p>
              )}
            </>
          ) : (
            <p className="text-muted">Create, select, or import a collection.</p>
          )}
        </section>
      </div>
    </div>
  );
}
