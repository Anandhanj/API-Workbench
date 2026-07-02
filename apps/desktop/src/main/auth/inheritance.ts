import type { WireAuthConfig } from '@shared/auth';

/**
 * Folder-auth inheritance resolution (ADR-0009).
 *
 * A request (or folder) whose auth is `{ type: 'inherit' }` takes its effective
 * auth from the nearest ancestor folder that carries a concrete config. This
 * resolver walks the folder parent chain and returns the first non-`inherit`
 * config it finds. Collections carry no auth, so a walk that reaches the
 * outermost folder (a null parent) without a concrete config resolves to
 * `{ type: 'none' }` — "no authorization".
 *
 * `none` is distinct from `inherit`: an explicit `none` on a folder stops the
 * walk (that subtree is deliberately unauthenticated). A null/absent folder auth
 * is treated as `inherit` (the default for every folder).
 *
 * Kept free of persistence/Electron imports so it is unit-testable; the caller
 * supplies the two lookups it needs.
 */
export interface InheritanceLookups {
  /** A folder's parent id and its own auth, or undefined if it doesn't exist. */
  folder(id: string): { parentId: string | null; auth: WireAuthConfig | null } | undefined;
  /** A request's containing folder id (null = collection root), or undefined. */
  requestFolderId(id: string): string | null | undefined;
}

const NONE: WireAuthConfig = { type: 'none' };

/** Whether a config participates in inheritance (absent/null or explicit inherit). */
function isInherit(auth: WireAuthConfig | null | undefined): boolean {
  return !auth || auth.type === 'inherit';
}

/**
 * Resolves the effective auth for an `inherit` origin by walking its folder
 * chain. Pass either the origin request's id (its folder is looked up) or a
 * starting `folderId` directly. Returns `{ type: 'none' }` when nothing concrete
 * is found.
 */
export function resolveInheritedAuth(
  origin: { requestId?: string; folderId?: string | null },
  lookups: InheritanceLookups,
): WireAuthConfig {
  let folderId: string | null | undefined =
    origin.folderId !== undefined
      ? origin.folderId
      : origin.requestId
        ? lookups.requestFolderId(origin.requestId)
        : null;

  const seen = new Set<string>();
  while (folderId) {
    if (seen.has(folderId)) break; // defensive: never loop on a corrupt cycle
    seen.add(folderId);
    const folder = lookups.folder(folderId);
    if (!folder) break;
    if (!isInherit(folder.auth)) return folder.auth as WireAuthConfig;
    folderId = folder.parentId;
  }
  return NONE;
}
