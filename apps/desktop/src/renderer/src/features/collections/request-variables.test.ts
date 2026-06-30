import { describe, expect, it } from 'vitest';
import type { VariableContext, VariableScope } from '@shared/variable';
import { defaultDraft, type RequestDraft } from '../runner/build-request';
import {
  canChangeScope,
  extractTokens,
  groupVariablesByScope,
  requestVariableNames,
  scopeIdFor,
  scopeMoveTargets,
  templateSource,
} from './request-variables';

let rowId = 0;
const row = (key: string, value: string) => ({ id: `kv-${rowId++}`, key, value, enabled: true });

function draft(over: Partial<RequestDraft> = {}): RequestDraft {
  return { ...defaultDraft('GET', ''), params: [], headers: [], formFields: [], ...over };
}

describe('extractTokens', () => {
  it('returns unique names, alphabetically sorted', () => {
    expect(extractTokens('{{b}} {{a}} {{b}}')).toEqual(['a', 'b']);
  });

  it('tolerates whitespace inside the braces', () => {
    expect(extractTokens('{{  token  }}')).toEqual(['token']);
  });

  it('supports dotted and dashed names', () => {
    expect(extractTokens('{{a.b}}/{{x-y}}')).toEqual(['a.b', 'x-y']);
  });

  it('ignores malformed or empty tokens', () => {
    expect(extractTokens('{{}} {{ }} {{a b}} plain text')).toEqual([]);
  });

  it('returns nothing when there are no tokens', () => {
    expect(extractTokens('https://example.com/path')).toEqual([]);
  });
});

describe('templateSource / requestVariableNames', () => {
  it('collects tokens from url, params, headers, body and auth', () => {
    const d = draft({
      url: '{{baseUrl}}/users',
      params: [row('page', '{{page}}')],
      headers: [row('{{hdrKey}}', '{{token}}')],
      rawBody: '{ "id": "{{userId}}" }',
      auth: { type: 'bearer', token: '{{token}}' },
    });
    expect(requestVariableNames(d)).toEqual(['baseUrl', 'hdrKey', 'page', 'token', 'userId']);
  });

  it('excludes pre/post-request scripts', () => {
    const src = templateSource(
      draft({
        url: '{{used}}',
        preRequestScript: '// {{scriptOnly}}',
        postResponseScript: '{{alsoScript}}',
      }),
    );
    expect(src).toContain('{{used}}');
    expect(src).not.toContain('scriptOnly');
    expect(src).not.toContain('alsoScript');
  });

  it('returns [] for a null draft', () => {
    expect(requestVariableNames(null)).toEqual([]);
  });
});

describe('scopeIdFor', () => {
  const ctx: VariableContext = {
    workspaceId: 'ws1',
    collectionId: 'col1',
    folderId: 'f1',
    requestId: 'r1',
  };

  it('maps each scope to its owning id', () => {
    expect(scopeIdFor('workspace', ctx)).toBe('ws1');
    expect(scopeIdFor('collection', ctx)).toBe('col1');
    expect(scopeIdFor('folder', ctx)).toBe('f1');
    expect(scopeIdFor('request', ctx)).toBe('r1');
  });

  it('has no id for global or runtime', () => {
    expect(scopeIdFor('global', ctx)).toBeUndefined();
    expect(scopeIdFor('runtime', ctx)).toBeUndefined();
  });

  it('returns undefined when the id is absent from the context', () => {
    expect(scopeIdFor('collection', { workspaceId: 'ws1' })).toBeUndefined();
  });
});

describe('groupVariablesByScope', () => {
  it('groups by scope in display order with unresolved last', () => {
    const scopeOf = (n: string): VariableScope | undefined =>
      ({ a: 'global', b: 'workspace', c: 'collection' })[n] as VariableScope | undefined;
    const { groups, unresolved } = groupVariablesByScope(['a', 'b', 'c', 'missing'], scopeOf);

    // workspace precedes global per SCOPE_ORDER.
    expect(groups.map((g) => g.scope)).toEqual(['workspace', 'global', 'collection']);
    expect(groups.find((g) => g.scope === 'workspace')?.names).toEqual(['b']);
    expect(unresolved).toEqual(['missing']);
  });

  it('keeps input order within a scope', () => {
    const { groups } = groupVariablesByScope(['x', 'y', 'z'], () => 'global');
    expect(groups).toEqual([{ scope: 'global', names: ['x', 'y', 'z'] }]);
  });

  it('returns empty groups for no names', () => {
    expect(groupVariablesByScope([], () => undefined)).toEqual({ groups: [], unresolved: [] });
  });
});

describe('canChangeScope', () => {
  it('allows promoting only request-local and collection variables', () => {
    expect(canChangeScope('request')).toBe(true);
    expect(canChangeScope('collection')).toBe(true);
  });

  it('does not allow changing broad or absent scopes', () => {
    expect(canChangeScope('workspace')).toBe(false);
    expect(canChangeScope('global')).toBe(false);
    expect(canChangeScope('folder')).toBe(false);
    expect(canChangeScope('runtime')).toBe(false);
    expect(canChangeScope(undefined)).toBe(false);
  });
});

describe('scopeMoveTargets', () => {
  it('offers keep-current plus Environment and Global when a workspace is active', () => {
    expect(scopeMoveTargets('request', { workspaceId: 'ws1', requestId: 'r1' })).toEqual([
      'request',
      'workspace',
      'global',
    ]);
    expect(scopeMoveTargets('collection', { workspaceId: 'ws1', collectionId: 'c1' })).toEqual([
      'collection',
      'workspace',
      'global',
    ]);
  });

  it('omits Environment when no workspace is active', () => {
    expect(scopeMoveTargets('collection', { collectionId: 'c1' })).toEqual([
      'collection',
      'global',
    ]);
  });

  it('does not duplicate the current scope', () => {
    // (workspace can't be a "from" scope here, but the guard must still hold)
    expect(scopeMoveTargets('global', { workspaceId: 'ws1' })).toEqual(['global', 'workspace']);
  });
});
