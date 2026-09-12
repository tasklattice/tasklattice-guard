/** Controller deployment state, not part of the immutable Runner protobuf snapshot.
 * create -> unpublished; publish/rollback -> distributing; all fresh Runner ACKs
 * -> active; rejection without convergence -> failed. Re-publish clears failure.
 * Lost/stale Runner ACKs move active back to distributing; fresh convergence wins
 * over an earlier rejection. These are derived states, not mutable revision data.
 */
export type RouterRolloutState = 'unpublished' | 'distributing' | 'active' | 'failed';
export function routerRolloutState(input: { activeRevision: number | null; desiredGeneration: number; rolloutError: string | null }, runners: Array<{ appliedGeneration: number; lastHeartbeatAt: Date | null }>, now = Date.now()): RouterRolloutState {
  if (!input.activeRevision) return 'unpublished';
  if (runners.length && runners.every(r => r.appliedGeneration >= input.desiredGeneration && r.lastHeartbeatAt && now - r.lastHeartbeatAt.getTime() < 60000)) return 'active';
  return input.rolloutError ? 'failed' : 'distributing';
}
