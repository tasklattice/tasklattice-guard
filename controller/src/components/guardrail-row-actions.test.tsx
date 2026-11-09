import "@/i18n";
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GuardrailRowActions } from './guardrail-row-actions';
import type { Guardrail } from '@/lib/api';


vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { role: 'user' } }) }));
vi.mock('./guardrail-duplicate', () => ({ DuplicateGuardrailSheet: () => <div role="dialog" aria-label="Duplicate Guardrail" /> }));
vi.mock('./guardrail-delete-sheet', () => ({ DeleteGuardrailSheet: () => <div role="dialog" aria-label="Delete Guardrail" /> }));
vi.mock('@/lib/api', () => ({ getGuardrailDeletionImpact: vi.fn().mockResolvedValue({}), deleteGuardrail: vi.fn() }));

describe('Guardrail row actions', () => {
  afterEach(cleanup);
  it("offers Default the same export, duplicate and delete actions", async () => {
    render(<QueryClientProvider client={new QueryClient()}>
      <GuardrailRowActions guardrail={{ id: 'guardrail-default', name: 'Default' } as Guardrail} />
    </QueryClientProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Actions: Default' }));
    expect(await screen.findByRole('menuitem', { name: 'Duplicate' })).toBeTruthy();
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it.each(['Duplicate', 'Delete'])('opens the %s confirmation without navigating the row', async action => {
    const onOpen = vi.fn();
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <div onClick={onOpen}><div onClick={event => event.stopPropagation()}>
        <GuardrailRowActions guardrail={{ id: 'guard', name: 'Example' } as Guardrail} />
      </div></div>
    </QueryClientProvider>);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Actions: Example' }));
    expect(await screen.findByRole('menuitem', { name: 'Duplicate' })).toBeTruthy();
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
    fireEvent.click(screen.getByRole('menuitem', { name: action }));
    expect(await screen.findByRole('dialog', { name: `${action} Guardrail` })).toBeTruthy();
    expect(onOpen).not.toHaveBeenCalled();
  });
});
