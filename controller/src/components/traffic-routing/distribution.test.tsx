import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DistributionReport, TrafficRouter } from '@/lib/traffic-routing-api';
import i18n from '@/i18n';
import { DistributionOverview } from './distribution';

const { queryReport } = vi.hoisted(() => ({ queryReport: vi.fn() }));
vi.mock('@/lib/traffic-routing-api', () => ({
  getRouterDistribution: queryReport,
  getRouterRevisions: async () => ({ items: [{ revision: 1, createdAt: '2026-09-29T08:00:00Z', snapshot: { routes: [] } }] }),
}));
vi.mock('@/lib/controller-api', async original => ({ ...(await original<typeof import('@/lib/controller-api')>()), listControllerGuardrails: async () => ({ items: [{ id: 'guard', name: 'Main Guardrail' }] }) }));
vi.mock('@tanstack/react-router', () => ({ Link: ({ children, to, search, ...props }: any) => <a {...props} href={`${to}?${new URLSearchParams(search ?? {})}`}>{children}</a> }));
const router = { id: 'router', endpointIds: ['gateway'], activeSnapshot: { routes: [{ id: 'support', name: 'Support', kind: 'normal', targets: [{ id: 'target', guardrailId: 'guard', guardrailVersion: 'v1', weightBps: 10000 }] }] } } as TrafficRouter;
const report: DistributionReport = {
  since: '2026-09-28T08:00:00Z', until: '2026-09-29T08:00:00Z', total: 100, assigned: 90, unassigned: 10,
  rows: [{ routeId: 'support', targetId: 'target', routerRevision: 1, guardrailId: 'guard', guardrailVersion: 'v1', assignmentStatus: 'assigned', count: 90, completed: 60, errors: 3, allowed: 57, blocked: 0, transformed: 0, intervened: 0, p95Ms: 40, inferredCompletions: 0 }],
  dataWatermark: '2026-09-29T08:00:00Z', unit: 'logical_call', multipleRevisions: false, telemetryFresh: true, completeness: 'current', revisions: [{ revision: 1, snapshot: router.activeSnapshot! }], trend: [],
};
function mount() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><DistributionOverview router={router} endpoints={[{ id: 'gateway', name: 'Corporate Gateway' }]} /></QueryClientProvider>);
}
beforeEach(async () => { await i18n.changeLanguage('en'); queryReport.mockReset().mockResolvedValue(report); });
afterEach(cleanup);
describe('Router Monitoring', () => {
  it('keeps assignment and completion denominators distinct and opens the detail drawer', async () => {
    mount();
    expect(await screen.findByText('5.00%')).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Route distribution' });
    expect(within(table).getByText('90.00%')).toBeTruthy();
    expect(within(table).getByText('100.00%')).toBeTruthy();
    fireEvent.click(within(table).getByRole('button', { name: 'Support', exact: true }));
    const drawer = screen.getByRole('dialog', { name: 'Support' });
    expect(within(drawer).getByText('60 / 90')).toBeTruthy();
    expect(within(drawer).getByRole('link', { name: 'View call logs' }).getAttribute('href')).toContain('routerRevision=1');
    fireEvent.click(within(drawer).getAllByRole('button', { name: 'Close', exact: true })[0]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('links the error metric to logs with the selected endpoint, revision, and report window', async () => {
    mount();
    await screen.findByRole('link', { name: 'View errors' });
    fireEvent.change(screen.getByLabelText('Endpoint'), { target: { value: 'gateway' } });
    fireEvent.change(screen.getByLabelText('Revision'), { target: { value: '1' } });
    const link = await screen.findByRole('link', { name: 'View errors' });
    const url = new URL(link.getAttribute('href')!, 'http://localhost');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ outcome:'error',routerId:'router',endpointId:'gateway',routerRevision:'1',since:report.since,until:report.until });
  });
  it('uses a single empty state instead of a table with fictional zero target rows', async () => {
    queryReport.mockResolvedValue({ ...report, total: 0, assigned: 0, unassigned: 0, rows: [] });
    mount();
    expect(await screen.findByText('No traffic yet')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
  it('warns about delayed telemetry rather than asserting there is no traffic', async () => {
    queryReport.mockResolvedValue({ ...report, total: 0, rows: [], telemetryFresh: false });
    mount();
    expect(await screen.findByText('Telemetry is delayed or unavailable; counts may be incomplete.')).toBeTruthy();
    expect(screen.queryByText('No traffic yet')).toBeNull();
  });
  it('retains the selected criteria when refreshing', async () => {
    mount();
    await screen.findByText('Telemetry current');
    fireEvent.change(screen.getByLabelText('Time window'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Endpoint'), { target: { value: 'gateway' } });
    await waitFor(() => expect(queryReport).toHaveBeenLastCalledWith('router', 1, undefined, 'gateway'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' }).hasAttribute('disabled')).toBe(false));
    const calls = queryReport.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(queryReport.mock.calls.length).toBeGreaterThan(calls));
    expect(queryReport).toHaveBeenLastCalledWith('router', 1, undefined, 'gateway');
  });
});
