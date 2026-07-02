import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { WireAuthConfig } from '@shared/auth';
import { AuthEditor } from '../runner/AuthEditor';
import type { EditorAuthConfig } from '../runner/build-request';
import { useVariableKeys } from '../variables/use-variable-keys';
import { useConfirm } from '../../components/confirm/ConfirmProvider';
import { useToast } from '../../components/toast/ToastProvider';
import { useFolderDetail, useFolderAuthMutations } from './use-collections';

export interface FolderAuthPanelProps {
  folderId: string;
  name: string;
  onClose: () => void;
}

const INHERIT: EditorAuthConfig = { type: 'inherit' };

/**
 * Right-pane editor for a folder's authorization. Requests and nested folders
 * that inherit resolve up to the nearest folder with a concrete config; the
 * "Apply to all children" action sets the whole subtree to inherit from here.
 */
export function FolderAuthPanel({ folderId, name, onClose }: FolderAuthPanelProps): JSX.Element {
  const folder = useFolderDetail(folderId);
  const { updateAuth, applyToChildren } = useFolderAuthMutations();
  const confirm = useConfirm();
  const toast = useToast();
  const suggestions = useVariableKeys(
    folder.data ? { collectionId: folder.data.collectionId } : {},
  );

  const [auth, setAuth] = useState<EditorAuthConfig>(INHERIT);

  // Seed the editor from the saved folder auth (null column = inherit).
  useEffect(() => {
    if (folder.data) setAuth((folder.data.auth as EditorAuthConfig | null) ?? INHERIT);
  }, [folder.data]);

  const save = (): void => {
    updateAuth
      .mutateAsync({ id: folderId, auth: auth as WireAuthConfig })
      .then(() => toast('Folder authorization saved'))
      .catch(() => toast('Failed to save authorization', { type: 'error' }));
  };

  const applyToAll = async (): Promise<void> => {
    if (
      !(await confirm({
        title: 'Apply to all children',
        message: `Set every folder and request inside "${name}" to inherit from parent? Their current authorization will be replaced.`,
        confirmLabel: 'Apply',
      }))
    ) {
      return;
    }
    applyToChildren
      .mutateAsync(folderId)
      .then((r) =>
        toast(`Set ${r.folders} folder(s) and ${r.requests} request(s) to inherit`),
      )
      .catch(() => toast('Failed to apply to children', { type: 'error' }));
  };

  return (
    <div className="min-w-0 flex-1">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-medium">{name}</h2>
          <p className="text-xs text-muted">Folder authorization</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 text-xs text-muted hover:text-fg"
        >
          Close
        </button>
      </div>

      {folder.data ? (
        <div className="space-y-4">
          <AuthEditor auth={auth} onChange={setAuth} suggestions={suggestions} allowInherit />

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={updateAuth.isPending}
              className="rounded-md bg-accent px-3 py-1.5 text-sm text-accent-fg disabled:opacity-60"
            >
              {updateAuth.isPending ? 'Saving…' : 'Save authorization'}
            </button>
            <button
              type="button"
              onClick={applyToAll}
              disabled={applyToChildren.isPending}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-2 disabled:opacity-60"
            >
              {applyToChildren.isPending
                ? 'Applying…'
                : 'Apply to all child folders and requests'}
            </button>
          </div>
          <p className="text-xs text-muted">
            Requests and folders set to “Inherit from parent” use the authorization defined here.
            Setting this folder itself to inherit defers to its parent folder, up to the top of the
            collection (where it resolves to no authorization).
          </p>
        </div>
      ) : (
        <p className="flex items-center gap-1.5 text-sm text-muted">
          <Loader2 size={14} className="animate-spin" /> Loading folder…
        </p>
      )}
    </div>
  );
}
