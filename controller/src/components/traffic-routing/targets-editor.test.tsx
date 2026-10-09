import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { TargetsEditor } from './targets-editor';

const { guardrail } = vi.hoisted(() => ({ guardrail: vi.fn() }));
vi.mock('@/lib/controller-api', async original => ({
  ...(await original<typeof import('@/lib/controller-api')>()),
  listControllerGuardrails: async () => ({ items: [{ id: 'bank', name: 'Bank assistant' }] }),
  getControllerGuardrail: guardrail,
}));
const version = (name: string, status: 'pending' | 'ready') => ({ version: name, status, artifactId: `artifact-${name}`, origin: 'imported' });
const target = { id: 'target', guardrailId: 'bank', guardrailVersion: '', weightBps: 10000 };
function mount() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TargetsEditor value={[target]} onChange={() => {}} fallback /></QueryClientProvider>);
}
beforeEach(async () => { await i18n.changeLanguage('en'); });
afterEach(cleanup);

describe('Router target versions', () => {
  it('lists pending versions but only lets a released one be pinned', async () => {
    guardrail.mockResolvedValue({ id: 'bank', versions: [version('v1', 'ready'), version('v2', 'pending')] });
    mount();
    await vi.waitFor(() => expect(guardrail).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 0));
    fireEvent.click(await screen.findByRole('combobox', { name: 'Guardrail 1 version' }));
    expect((await screen.findByRole('option', { name: 'v1' })).getAttribute('aria-disabled')).not.toBe('true');
    expect(screen.getByRole('option', { name: 'v2 · pending: test and release it first' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('says how to get a version routable when every version is still pending', async () => {
    guardrail.mockResolvedValue({ id: 'bank', versions: [version('v1', 'pending')] });
    mount();
    expect(await screen.findByText(/No version of this Guardrail is released here yet/)).toBeTruthy();
  });
});
