import { expect, it } from 'vitest';
import { routerRolloutState } from './router-lifecycle.js';
const now = 100000;
const router = { activeRevision: 1, desiredGeneration: 3, rolloutError: null };
it('covers publication, convergence, stale heartbeats, rejection and recovery', () => {
 expect(routerRolloutState({ ...router, activeRevision: null }, [], now)).toBe('unpublished');
 expect(routerRolloutState(router, [], now)).toBe('distributing');
 const healthy = [{ appliedGeneration: 3, lastHeartbeatAt: new Date(now) }];
 expect(routerRolloutState(router, healthy, now)).toBe('active');
 expect(routerRolloutState(router, healthy, now + 60000)).toBe('distributing');
 expect(routerRolloutState({ ...router, rolloutError: 'rejected' }, [], now)).toBe('failed');
 expect(routerRolloutState({ ...router, rolloutError: 'rejected' }, healthy, now)).toBe('active');
 expect(routerRolloutState({ ...router, desiredGeneration: 4 }, healthy, now)).toBe('distributing');
});
