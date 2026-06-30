import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Variable } from '@shared/variable';
import { VariablesPanel } from './VariablesPanel';

function makeVar(over: Partial<Variable> = {}): Variable {
  return {
    id: 'v-1',
    scope: 'global',
    scopeId: '',
    key: 'host',
    value: 'api.example.com',
    secret: false,
    encrypted: false,
    hasValue: true,
    updatedAt: 1_700_000_000_000,
    ...over,
  };
}

describe('<VariablesPanel />', () => {
  it('adds a non-secret variable', async () => {
    const onAdd = vi.fn();
    const user = userEvent.setup();
    render(<VariablesPanel variables={[]} onAdd={onAdd} onDelete={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Variable key'), { target: { value: 'token' } });
    fireEvent.change(screen.getByLabelText('Variable value'), { target: { value: 'abc' } });
    await user.click(screen.getByRole('button', { name: 'Add variable' }));
    expect(onAdd).toHaveBeenCalledWith({ key: 'token', value: 'abc', secret: false });
  });

  it('adds a secret variable when the secret box is checked', async () => {
    const onAdd = vi.fn();
    const user = userEvent.setup();
    render(<VariablesPanel variables={[]} onAdd={onAdd} onDelete={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Variable key'), { target: { value: 'apiKey' } });
    fireEvent.change(screen.getByLabelText('Variable value'), { target: { value: 'sk-123' } });
    await user.click(screen.getByLabelText('Secret'));
    await user.click(screen.getByRole('button', { name: 'Add variable' }));
    expect(onAdd).toHaveBeenCalledWith({ key: 'apiKey', value: 'sk-123', secret: true });
  });

  it('shows a non-secret value but masks a secret one', () => {
    render(
      <VariablesPanel
        variables={[
          makeVar(),
          makeVar({ id: 'v-2', key: 'apiKey', secret: true, value: undefined, hasValue: true }),
        ]}
        onAdd={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText('api.example.com')).toBeInTheDocument();
    expect(screen.getByText('••••••••')).toBeInTheDocument();
  });

  it('deletes a variable', async () => {
    const onDelete = vi.fn();
    const user = userEvent.setup();
    render(<VariablesPanel variables={[makeVar()]} onAdd={vi.fn()} onDelete={onDelete} />);
    await user.click(screen.getByRole('button', { name: 'Delete host' }));
    expect(onDelete).toHaveBeenCalledWith('host');
  });

  it('edits a value in place and upserts via onAdd', async () => {
    const onAdd = vi.fn();
    const user = userEvent.setup();
    render(<VariablesPanel variables={[makeVar()]} onAdd={onAdd} onDelete={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Edit host' }));
    const input = screen.getByLabelText('Edit value for host');
    fireEvent.change(input, { target: { value: 'https://new.example.com' } });
    await user.click(screen.getByRole('button', { name: 'Save host' }));
    expect(onAdd).toHaveBeenCalledWith({
      key: 'host',
      value: 'https://new.example.com',
      secret: false,
    });
  });

  it('cancels an edit without calling onAdd', async () => {
    const onAdd = vi.fn();
    const user = userEvent.setup();
    render(<VariablesPanel variables={[makeVar()]} onAdd={onAdd} onDelete={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Edit host' }));
    await user.click(screen.getByRole('button', { name: 'Cancel editing host' }));
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByText('api.example.com')).toBeInTheDocument();
  });

  it('shows an empty state', () => {
    render(<VariablesPanel variables={[]} onAdd={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText(/No variables in this scope yet/)).toBeInTheDocument();
  });
});
