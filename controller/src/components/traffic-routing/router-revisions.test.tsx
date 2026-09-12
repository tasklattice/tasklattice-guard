import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RouterRevisions } from './router-revisions';
import type { RouterRevision, TrafficRouter } from '@/lib/traffic-routing-api';
const { remove } = vi.hoisted(() => ({ remove: vi.fn() }));
vi.mock('@/lib/traffic-routing-api', async original => ({ ...await original<typeof import('@/lib/traffic-routing-api')>(), deleteRouterRevision: remove }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { exists: () => false } }) }));
const history = [2, 1].map(revision => ({ revision, createdAt: `2026-09-0${revision}T00:00:00.000Z`, snapshot: { routes: [] } })) as RouterRevision[];
const router = { id: 'router', activeRevision: 2, rolloutStatus: 'active' } as TrafficRouter;
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function setup(canEdit = true) {
 const restore = vi.fn();
 render(<QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}><RouterRevisions router={router} revisions={history} canEdit={canEdit} onRestore={restore} /></QueryClientProvider>);
 return restore;
}
function openMenu(index = 1) { fireEvent.pointerDown(screen.getAllByRole('button', { name: /Actions for revision/ })[index]!, { button: 0, ctrlKey: false, pointerType: 'mouse' }); }
it('shows colored status and protects the current revision', async () => {
 setup();
 expect(screen.getByText('Active').className).toContain('text-emerald');
 openMenu(0);
 expect((await screen.findByRole('menuitem', { name: 'Delete' })).getAttribute('aria-disabled')).toBe('true');
 expect(screen.getByRole('menuitem', { name: 'Rollback' }).getAttribute('aria-disabled')).toBe('true');
});
it('restores from the historical menu without deleting', async () => {
 const restore = setup(); openMenu();
 fireEvent.click(await screen.findByRole('menuitem', { name: 'Rollback' }));
 expect(restore).toHaveBeenCalledWith(history[1]); expect(remove).not.toHaveBeenCalled();
});
it('requires drawer confirmation and keeps rejection visible', async () => {
 remove.mockRejectedValue(new Error('This revision still has in-flight calls.'));
 setup(); openMenu(); fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
 expect(await screen.findByRole('dialog')).toBeTruthy();
 fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); expect(remove).not.toHaveBeenCalled();
 openMenu(); fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
 fireEvent.click(await screen.findByRole('button', { name: 'Delete revision' }));
 await waitFor(() => expect(remove).toHaveBeenCalledWith('router', 1));
 expect((await screen.findByRole('alert')).textContent).toContain('in-flight calls');
});
it('hides mutation menus from viewers', () => { setup(false); expect(screen.queryByRole('button', { name: /Actions for revision/ })).toBeNull(); });
