import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GuardrailRowActions } from './guardrail-row-actions';
import type { Guardrail } from '@/lib/api';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }));
vi.mock('./guardrail-duplicate', () => ({ DuplicateGuardrailSheet: () => <div role="dialog" aria-label="Duplicate Guardrail" /> }));
vi.mock('./guardrail-delete-sheet', () => ({ DeleteGuardrailSheet: () => <div role="dialog" aria-label="Delete Guardrail" /> }));
vi.mock('@/lib/api', () => ({ getGuardrailDeletionImpact: vi.fn().mockResolvedValue({}), deleteGuardrail: vi.fn() }));

describe('Guardrail row actions', () => {
  afterEach(cleanup);
  it.each(['Duplicate', 'Delete'])('opens the %s confirmation without navigating the row', async action => {
    const onOpen = vi.fn();
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <div onClick={onOpen}><div onClick={event => event.stopPropagation()}>
        <GuardrailRowActions guardrail={{ id: 'guard', name: 'Example' } as Guardrail} />
      </div></div>
    </QueryClientProvider>);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Actions: Example' }), { key: 'ArrowDown' });
    expect(await screen.findByRole('menuitem', { name: 'Duplicate' })).toBeTruthy();
    expect(screen.getAllByRole('menuitem')).toHaveLength(2);
    fireEvent.click(screen.getByRole('menuitem', { name: action }));
    expect(await screen.findByRole('dialog', { name: `${action} Guardrail` })).toBeTruthy();
    expect(onOpen).not.toHaveBeenCalled();
  });
});
