import { beforeEach, expect, it, vi } from 'vitest';
import { discardRouterDraft } from './discard-router-draft';
import { saveTrafficRouter, type RouterDraft, type TrafficRouter } from '@/lib/traffic-routing-api';
vi.mock('@/lib/traffic-routing-api', () => ({ saveTrafficRouter: vi.fn() }));
const original: RouterDraft = { routes: [] };
const changed: RouterDraft = { routes: [{ id: 'added' } as RouterDraft['routes'][number]] };
const router = (draft: RouterDraft, activeSnapshot: RouterDraft | null = null) => ({ id: 'router', draftRevision: 4, draft, activeSnapshot, endpointIds: ['endpoint'] }) as TrafficRouter;
beforeEach(() => vi.clearAllMocks());
it('discards local edits on an unpublished Router without a server write', async () => {
  const base = router(original);
  expect(await discardRouterDraft(base, structuredClone(original))).toBe(base);
  expect(saveTrafficRouter).not.toHaveBeenCalled();
});
it('restores the pre-edit unpublished configuration after Review persisted changes', async () => {
  const restored = router(original);
  vi.mocked(saveTrafficRouter).mockResolvedValue(restored);
  expect(await discardRouterDraft(router(changed), original)).toBe(restored);
  expect(saveTrafficRouter).toHaveBeenCalledWith('router', 4, original);
  expect(restored.endpointIds).toEqual(['endpoint']);
});
it('restores the published snapshot for an already published Router', async () => {
  await discardRouterDraft(router(changed, original), original);
  expect(saveTrafficRouter).toHaveBeenCalledWith('router', 4, original);
});
it('preserves conflict errors instead of silently overwriting concurrent edits', async () => {
  vi.mocked(saveTrafficRouter).mockRejectedValue(new Error('Router draft changed'));
  await expect(discardRouterDraft(router(changed), original)).rejects.toThrow('Router draft changed');
  expect(saveTrafficRouter).toHaveBeenCalledTimes(1);
});
