import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { ResourceList } from './resource-list';

afterEach(cleanup);
void i18n.changeLanguage('en');
const items = Array.from({ length: 30 }, (_, index) => ({ name: `Resource ${String(index + 1).padStart(2, '0')}`, state: index % 2 ? 'ready' : 'draft' }));
const props = {
  items, label: 'Resources', searchPlaceholder: 'Search resources', searchText: (item: typeof items[number]) => item.name,
  filter: { label: 'Status', options: [{ value: '', label: 'All statuses' }, { value: 'ready', label: 'Ready' }], matches: (item: typeof items[number], state: string) => item.state === state },
  emptyTitle: 'No resources yet', emptyDescription: 'Create a resource to get started.',
  children: (rows: typeof items) => <ul>{rows.map(item => <li key={item.name}>{item.name}</li>)}</ul>,
};

describe('ResourceList desktop interaction', () => {
  it('combines search and status filtering, resetting pagination and recovering from no results', () => {
    render(<ResourceList {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('Resource 30')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Resource 02' } });
    expect(screen.getByText('Resource 02')).toBeTruthy();
    expect(screen.queryByText('Resource 30')).toBeNull();
    fireEvent.click(screen.getByRole('combobox', { name: 'Status' }));
    fireEvent.click(screen.getByRole('option', { name: 'Ready' }));
    expect(screen.getByText('Resource 02')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Resource 01' } });
    expect(screen.getByText('No matching records')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]);
    expect(screen.getByText('Resource 01')).toBeTruthy();
    expect(screen.getByText('30 of 30 records')).toBeTruthy();
  });
  it('clamps the displayed page when records are removed', () => {
    const view = render(<ResourceList {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    view.rerender(<ResourceList {...props} items={items.slice(0, 2)} />);
    expect(screen.getByText('Resource 01')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Previous page' }).hasAttribute('disabled')).toBe(true);
  });
  it('retains criteria on refresh and delegates creation without mutating resources', () => {
    const refresh = vi.fn(); const create = vi.fn();
    render(<ResourceList {...props} onRefresh={refresh} action={<button onClick={create}>Create resource</button>} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Resource 03' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(refresh).toHaveBeenCalledOnce();
    expect(screen.getByText('Resource 03')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create resource' }));
    expect(create).toHaveBeenCalledOnce();
  });
  it('shows a recoverable error instead of an empty collection', () => {
    const retry = vi.fn();
    render(<ResourceList {...props} items={[]} error={new Error('Network unavailable')} onRefresh={retry} />);
    expect(screen.getByText('Network unavailable')).toBeTruthy();
    expect(screen.queryByText('No resources yet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
