import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TreeNode } from '@shared/collection';
import { CollectionTreeView } from './CollectionTreeView';

const nodes: TreeNode[] = [
  { type: 'folder', id: 'f1', parentId: null, name: 'Auth', depth: 1 },
  { type: 'request', id: 'r1', parentId: 'f1', name: 'Login', depth: 2, method: 'POST', url: '/login', favorite: false },
  { type: 'request', id: 'r2', parentId: null, name: 'Ping', depth: 1, method: 'GET', url: '/ping', favorite: false },
];

/** A minimal DataTransfer stand-in (jsdom doesn't implement drag data). */
function makeDataTransfer(): DataTransfer {
  const store: Record<string, string> = {};
  return {
    setData: (type: string, value: string) => {
      store[type] = value;
    },
    getData: (type: string) => store[type] ?? '',
    effectAllowed: 'all',
    dropEffect: 'none',
  } as unknown as DataTransfer;
}

const row = (name: string): HTMLElement =>
  screen.getByText(name).closest('[data-testid^="tree-"]') as HTMLElement;

describe('<CollectionTreeView />', () => {
  it('hides a folder’s children until it is expanded', () => {
    render(
      <CollectionTreeView nodes={nodes} expandedFolders={new Set()} onToggleFolder={vi.fn()} onOpenRequest={vi.fn()} />,
    );
    expect(screen.getByText('Auth')).toBeInTheDocument();
    expect(screen.getByText('Ping')).toBeInTheDocument();
    expect(screen.queryByText('Login')).not.toBeInTheDocument();
  });

  it('shows children and colored method badges when expanded', () => {
    render(
      <CollectionTreeView nodes={nodes} expandedFolders={new Set(['f1'])} onToggleFolder={vi.fn()} onOpenRequest={vi.fn()} />,
    );
    expect(screen.getByText('Login')).toBeInTheDocument();
    expect(screen.getByText('POST')).toBeInTheDocument();
    expect(screen.getByText('GET')).toBeInTheDocument();
  });

  it('toggles a folder and opens a request', async () => {
    const onToggleFolder = vi.fn();
    const onOpenRequest = vi.fn();
    const user = userEvent.setup();
    render(
      <CollectionTreeView nodes={nodes} expandedFolders={new Set(['f1'])} onToggleFolder={onToggleFolder} onOpenRequest={onOpenRequest} />,
    );
    await user.click(screen.getByText('Auth'));
    expect(onToggleFolder).toHaveBeenCalledWith('f1');
    await user.click(screen.getByText('Login'));
    expect(onOpenRequest).toHaveBeenCalledWith({ id: 'r1', name: 'Login', method: 'POST', url: '/login' });
  });

  it('exposes delete actions via the context menu', async () => {
    const onDeleteFolder = vi.fn();
    const onDeleteRequest = vi.fn();
    const user = userEvent.setup();
    render(
      <CollectionTreeView
        nodes={nodes}
        expandedFolders={new Set(['f1'])}
        onToggleFolder={vi.fn()}
        onOpenRequest={vi.fn()}
        onDeleteFolder={onDeleteFolder}
        onDeleteRequest={onDeleteRequest}
      />,
    );
    await user.click(screen.getByLabelText('Folder actions for Auth'));
    await user.click(screen.getByText('Delete'));
    expect(onDeleteFolder).toHaveBeenCalledWith('f1', 'Auth');

    await user.click(screen.getByLabelText('Request actions for Login'));
    await user.click(screen.getByText('Delete'));
    expect(onDeleteRequest).toHaveBeenCalledWith('r1', 'Login');
  });

  it('renames a folder via the menu → inline input', async () => {
    const onRenameFolder = vi.fn();
    const user = userEvent.setup();
    render(
      <CollectionTreeView
        nodes={nodes}
        expandedFolders={new Set()}
        onToggleFolder={vi.fn()}
        onOpenRequest={vi.fn()}
        onRenameFolder={onRenameFolder}
      />,
    );
    await user.click(screen.getByLabelText('Folder actions for Auth'));
    await user.click(screen.getByText('Rename'));
    const input = screen.getByDisplayValue('Auth');
    await user.clear(input);
    await user.type(input, 'Security{Enter}');
    expect(onRenameFolder).toHaveBeenCalledWith('f1', 'Security');
  });

  it('moves a request into a folder when dropped on the folder row', () => {
    const onMoveRequest = vi.fn();
    render(
      <CollectionTreeView
        nodes={nodes}
        expandedFolders={new Set(['f1'])}
        onToggleFolder={vi.fn()}
        onOpenRequest={vi.fn()}
        onMoveRequest={onMoveRequest}
      />,
    );
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(row('Ping'), { dataTransfer }); // r2, at root
    fireEvent.drop(row('Auth'), { dataTransfer }); // folder f1
    expect(onMoveRequest).toHaveBeenCalledWith('r2', 'f1');
  });

  it('moves a request into another request’s folder when dropped on that request', () => {
    const onMoveRequest = vi.fn();
    render(
      <CollectionTreeView
        nodes={nodes}
        expandedFolders={new Set(['f1'])}
        onToggleFolder={vi.fn()}
        onOpenRequest={vi.fn()}
        onMoveRequest={onMoveRequest}
      />,
    );
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(row('Ping'), { dataTransfer }); // r2, at root
    fireEvent.drop(row('Login'), { dataTransfer }); // r1, inside folder f1
    expect(onMoveRequest).toHaveBeenCalledWith('r2', 'f1');
  });

  it('moves a request to the collection root when dropped on the root area', () => {
    const onMoveRequest = vi.fn();
    const { container } = render(
      <CollectionTreeView
        nodes={nodes}
        expandedFolders={new Set(['f1'])}
        onToggleFolder={vi.fn()}
        onOpenRequest={vi.fn()}
        onMoveRequest={onMoveRequest}
      />,
    );
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(row('Login'), { dataTransfer }); // r1, inside folder f1
    fireEvent.drop(container.firstChild as HTMLElement, { dataTransfer }); // root drop zone
    expect(onMoveRequest).toHaveBeenCalledWith('r1', null);
  });

  it('is not draggable when no move handler is provided', () => {
    render(
      <CollectionTreeView nodes={nodes} expandedFolders={new Set(['f1'])} onToggleFolder={vi.fn()} onOpenRequest={vi.fn()} />,
    );
    expect(row('Ping')).not.toHaveAttribute('draggable', 'true');
  });

  it('duplicates a request via the menu', async () => {
    const onDuplicateRequest = vi.fn();
    const user = userEvent.setup();
    render(
      <CollectionTreeView
        nodes={nodes}
        expandedFolders={new Set(['f1'])}
        onToggleFolder={vi.fn()}
        onOpenRequest={vi.fn()}
        onDuplicateRequest={onDuplicateRequest}
      />,
    );
    await user.click(screen.getByLabelText('Request actions for Login'));
    await user.click(screen.getByText('Duplicate'));
    expect(onDuplicateRequest).toHaveBeenCalledWith('r1');
  });
});
