import type { VariableContext, VariableScope } from '@shared/variable';
import type { RequestDraft } from '../runner/build-request';

/**
 * Pure helpers behind the "Variables used" panel: find the `{{variables}}` a
 * request references, resolve the owning id for an editable scope, and group the
 * referenced names by the scope each resolves from. Kept framework-free so the
 * logic is unit-testable independently of the panel's rendering.
 */

/** Scope display order (highest-interest first). */
export const SCOPE_ORDER: VariableScope[] = [
  'workspace',
  'global',
  'collection',
  'folder',
  'request',
  'workflow',
  'runtime',
];

const TOKEN = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** Unique `{{name}}` variable names found in `text`, sorted alphabetically. */
export function extractTokens(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(TOKEN)) seen.add(m[1]);
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** The request strings that may contain `{{variables}}` (scripts excluded). */
export function templateSource(draft: RequestDraft): string {
  const parts: string[] = [draft.url, draft.rawBody, JSON.stringify(draft.auth ?? {})];
  for (const row of [...draft.params, ...draft.headers, ...draft.formFields]) {
    parts.push(row.key, row.value);
  }
  return parts.join('\n');
}

/** Variable names referenced anywhere in the request (empty when no draft). */
export function requestVariableNames(draft: RequestDraft | null): string[] {
  return draft ? extractTokens(templateSource(draft)) : [];
}

/** The owning id a scope writes to in the given context (undefined for global). */
export function scopeIdFor(scope: VariableScope, ctx: VariableContext): string | undefined {
  if (scope === 'workspace') return ctx.workspaceId;
  if (scope === 'collection') return ctx.collectionId;
  if (scope === 'folder') return ctx.folderId;
  if (scope === 'request') return ctx.requestId;
  return undefined;
}

export interface VariableGrouping {
  /** Resolved names grouped by scope, in {@link SCOPE_ORDER}. */
  groups: { scope: VariableScope; names: string[] }[];
  /** Names that don't resolve to any scope. */
  unresolved: string[];
}

/**
 * Buckets `names` by the scope each resolves from (`scopeOf` returns the scope or
 * `undefined`). Groups follow {@link SCOPE_ORDER}; unresolved names are collected
 * separately. Input order within a scope is preserved.
 */
export function groupVariablesByScope(
  names: string[],
  scopeOf: (name: string) => VariableScope | undefined,
): VariableGrouping {
  const grouped = new Map<VariableScope, string[]>();
  const unresolved: string[] = [];
  for (const name of names) {
    const scope = scopeOf(name);
    if (!scope) {
      unresolved.push(name);
      continue;
    }
    const list = grouped.get(scope);
    if (list) list.push(name);
    else grouped.set(scope, [name]);
  }
  const groups = SCOPE_ORDER.filter((s) => grouped.has(s)).map((scope) => ({
    scope,
    names: grouped.get(scope) ?? [],
  }));
  return { groups, unresolved };
}

/**
 * Whether a variable's scope may be changed from the request panel. Only
 * "narrow" variables — request-local or collection — can be promoted; variables
 * already in Environment/Global (or runtime) are edited in place.
 */
export function canChangeScope(scope: VariableScope | undefined): boolean {
  return scope === 'request' || scope === 'collection';
}

/**
 * Scopes a request/collection variable can be written to: keep its current
 * scope, or promote to Environment (when a workspace is active) or Global.
 */
export function scopeMoveTargets(current: VariableScope, ctx: VariableContext): VariableScope[] {
  const targets: VariableScope[] = [current];
  if (ctx.workspaceId && current !== 'workspace') targets.push('workspace');
  if (current !== 'global') targets.push('global');
  return targets;
}
