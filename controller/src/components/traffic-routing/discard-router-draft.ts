import { saveTrafficRouter, type RouterDraft, type TrafficRouter } from '@/lib/traffic-routing-api';

/** Undo local edits without writing; undo a Review save using its revision. */
export async function discardRouterDraft(base: TrafficRouter, target: RouterDraft): Promise<TrafficRouter> {
  if (JSON.stringify(base.draft) === JSON.stringify(target)) return base;
  return saveTrafficRouter(base.id, base.draftRevision, target);
}
