import { describe, expect, it } from 'vitest';
import type { TreeNode } from '@shared/collection';
import { filterTree } from './CollectionTreeView';

const folder = (id: string, parentId: string | null, name: string): TreeNode => ({
  type: 'folder',
  id,
  parentId,
  name,
  depth: 0,
});

const request = (
  id: string,
  parentId: string | null,
  name: string,
  url = 'https://api.test/x',
): TreeNode => ({
  type: 'request',
  id,
  parentId,
  name,
  url,
  method: 'GET',
  depth: 0,
  favorite: false,
});

// users (folder)
//   ├─ getUser (request)      ← matches "user"
//   └─ nested (folder)
//        └─ deleteUser (request)
// orders (folder)
//   └─ listOrders (request)
const nodes: TreeNode[] = [
  folder('f-users', null, 'users'),
  request('r-getUser', 'f-users', 'getUser'),
  folder('f-nested', 'f-users', 'nested'),
  request('r-deleteUser', 'f-nested', 'deleteUser'),
  folder('f-orders', null, 'orders'),
  request('r-listOrders', 'f-orders', 'listOrders'),
];

describe('filterTree', () => {
  it('returns all nodes for an empty query', () => {
    expect(filterTree(nodes, '')).toEqual(nodes);
    expect(filterTree(nodes, '   ')).toEqual(nodes);
  });

  it('keeps matching requests plus their ancestor folders', () => {
    const ids = filterTree(nodes, 'listOrders').map((n) => n.id);
    // The request and its parent folder, but nothing from the users subtree.
    expect(ids).toEqual(['f-orders', 'r-listOrders']);
  });

  it('keeps the full ancestor chain for a deeply nested match', () => {
    const ids = filterTree(nodes, 'deleteUser').map((n) => n.id);
    expect(ids).toEqual(['f-users', 'f-nested', 'r-deleteUser']);
  });

  it('includes all descendants when a folder name matches', () => {
    const ids = filterTree(nodes, 'users').map((n) => n.id);
    // The "users" folder matches by name → whole subtree is kept, orders excluded.
    expect(ids).toEqual(['f-users', 'r-getUser', 'f-nested', 'r-deleteUser']);
  });

  it('matches on request URL as well as name', () => {
    const withUrl = [request('r-a', null, 'alpha', 'https://api.test/payments')];
    expect(filterTree(withUrl, 'payments').map((n) => n.id)).toEqual(['r-a']);
  });

  it('is case-insensitive', () => {
    expect(filterTree(nodes, 'GETUSER').map((n) => n.id)).toEqual(['f-users', 'r-getUser']);
  });

  it('returns nothing when there is no match', () => {
    expect(filterTree(nodes, 'zzz')).toEqual([]);
  });
});
