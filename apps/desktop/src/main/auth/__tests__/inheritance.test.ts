// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { WireAuthConfig } from '@shared/auth';
import { resolveInheritedAuth, type InheritanceLookups } from '../inheritance';

/**
 * Builds lookups over a fixed folder table. `folders` maps id → { parentId, auth };
 * `requests` maps request id → its folder id.
 */
function lookups(
  folders: Record<string, { parentId: string | null; auth: WireAuthConfig | null }>,
  requests: Record<string, string | null> = {},
): InheritanceLookups {
  return {
    folder: (id) => folders[id],
    requestFolderId: (id) => (id in requests ? requests[id] : undefined),
  };
}

const bearer: WireAuthConfig = { type: 'bearer', token: 't' };
const inherit: WireAuthConfig = { type: 'inherit' };

describe('resolveInheritedAuth', () => {
  it('resolves a request to its immediate folder auth', () => {
    const repos = lookups(
      { f1: { parentId: null, auth: bearer } },
      { r1: 'f1' },
    );
    expect(resolveInheritedAuth({ requestId: 'r1' }, repos)).toEqual(bearer);
  });

  it('walks up through inheriting folders to the first concrete auth', () => {
    const repos = lookups(
      {
        top: { parentId: null, auth: bearer },
        mid: { parentId: 'top', auth: inherit },
        leaf: { parentId: 'mid', auth: null }, // null == inherit
      },
      { r1: 'leaf' },
    );
    expect(resolveInheritedAuth({ requestId: 'r1' }, repos)).toEqual(bearer);
  });

  it('returns none when the whole chain inherits (top of collection)', () => {
    const repos = lookups(
      {
        top: { parentId: null, auth: inherit },
        leaf: { parentId: 'top', auth: null },
      },
      { r1: 'leaf' },
    );
    expect(resolveInheritedAuth({ requestId: 'r1' }, repos)).toEqual({ type: 'none' });
  });

  it('stops the walk at an explicit none (deliberately unauthenticated subtree)', () => {
    const repos = lookups(
      {
        top: { parentId: null, auth: bearer },
        mid: { parentId: 'top', auth: { type: 'none' } },
        leaf: { parentId: 'mid', auth: inherit },
      },
      { r1: 'leaf' },
    );
    expect(resolveInheritedAuth({ requestId: 'r1' }, repos)).toEqual({ type: 'none' });
  });

  it('returns none for a request at the collection root (no folder)', () => {
    const repos = lookups({}, { r1: null });
    expect(resolveInheritedAuth({ requestId: 'r1' }, repos)).toEqual({ type: 'none' });
  });

  it('accepts a starting folderId directly', () => {
    const repos = lookups({ f1: { parentId: null, auth: bearer } });
    expect(resolveInheritedAuth({ folderId: 'f1' }, repos)).toEqual(bearer);
  });

  it('does not loop forever on a corrupt parent cycle', () => {
    const repos = lookups({
      a: { parentId: 'b', auth: inherit },
      b: { parentId: 'a', auth: inherit },
    });
    expect(resolveInheritedAuth({ folderId: 'a' }, repos)).toEqual({ type: 'none' });
  });
});
