import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { ControllerDatabase } from "../db/client.js";
import { advisoryTransactionLock } from "../db/postgres-locks.js";
import { controllerState, runnerControlSessions, runnerInstances, runnerPoolLeaseEpochs, runnerPools, runnerServingGrants } from "../db/schema.js";
import { ConflictError, NotFoundError, ValidationError } from "../domain/errors.js";

// This is the same lock used by TenantGroupService for allocation changes.
// Existing move code does not yet consult this ledger, so this alone does not
// fence a live Runner or make group moves safe.
const allocationLock = "traffic-router-bindings";
const MAX_DURATION_MS = 60_000;
const MAX_UNCERTAINTY_MS = 60_000;
type Transaction = Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0];
type Grant = {
  poolId: string; runnerId: string; bootId: string; nonce: string;
  epoch: number; generation: number; durationMs: number; uncertaintyMs: number;
};
type SnapshotBoundGrant = Grant & { snapshotNonce: string; modelRevisionId: string; controlSessionId: string };

/** Controller-side ledger foundation; not connected to any serving protocol.
 *
 * Its caller must authenticate pool/Runner/boot, verify the exact dispatched
 * snapshot and establish an appropriate timing uncertainty before issuing a
 * grant. A future move protocol must stop grants under the same lock, enforce
 * all outstanding grants or external fencing, and persist the transition.
 */
export class RunnerLeaseLedger {
  constructor(private readonly db: ControllerDatabase) {}

  private async poolState(tx: Transaction, poolId: string) {
    const [pool] = await tx.select({ id: runnerPools.id }).from(runnerPools).where(eq(runnerPools.id, poolId));
    if (!pool) throw new NotFoundError("Runner Pool", poolId);
    await tx.insert(runnerPoolLeaseEpochs).values({ poolId }).onConflictDoNothing();
    const [state] = await tx.select().from(runnerPoolLeaseEpochs).where(eq(runnerPoolLeaseEpochs.poolId, poolId));
    if (!state) throw new Error("Runner pool lease state is unavailable.");
    return state;
  }

  /** Record a grant before any reply. Repeated nonces are never reissued. */
  async issue(input: Grant) {
    return this.issueGrant(input);
  }

  /** Experimental protocol path. Caller supplies evidence from its current
   * authenticated stream; database checks are additional, not a substitute
   * for stream identity or a fencing/epoch-transition protocol. */
  async issueSnapshotBound(input: SnapshotBoundGrant) {
    validateId(input.controlSessionId);
    validateId(input.snapshotNonce);
    if (typeof input.modelRevisionId !== "string" || input.modelRevisionId.length > 256 || input.modelRevisionId !== input.modelRevisionId.trim()) {
      throw new ValidationError("Runner lease model revision is invalid.");
    }
    return this.issueGrant(input, true);
  }

  private async issueGrant(input: Grant | SnapshotBoundGrant, requireRegistration = false) {
    validate(input);
    return this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, allocationLock);
      const state = await this.poolState(tx, input.poolId);
      if (state.draining || state.epoch !== input.epoch) {
        throw new ConflictError("Runner pool is draining or has a different lease epoch.", "runner_lease_epoch_unavailable");
      }
      if (requireRegistration) {
        const bound = input as SnapshotBoundGrant;
        const [registration] = await tx.select({ runnerId: runnerInstances.runnerId }).from(runnerInstances)
          .innerJoin(runnerControlSessions, eq(runnerControlSessions.id, runnerInstances.controlSessionId))
          .innerJoin(runnerPools, eq(runnerPools.id, runnerInstances.poolId))
          .where(and(eq(runnerInstances.runnerId, input.runnerId), eq(runnerInstances.bootId, input.bootId),
            eq(runnerInstances.poolId, input.poolId), ne(runnerInstances.status, "offline"), isNull(runnerInstances.disconnectedAt),
            eq(runnerInstances.controlSessionId, bound.controlSessionId),
            eq(runnerControlSessions.runnerId, input.runnerId), eq(runnerControlSessions.bootId, input.bootId),
            eq(runnerControlSessions.poolId, input.poolId), isNull(runnerControlSessions.disconnectedAt),
            eq(runnerControlSessions.snapshotNonce, bound.snapshotNonce), eq(runnerControlSessions.snapshotGeneration, input.generation),
            eq(runnerControlSessions.snapshotModelRevisionId, bound.modelRevisionId),
            eq(runnerControlSessions.snapshotEpoch, input.epoch), eq(runnerControlSessions.snapshotGroupId, runnerPools.groupId),
            eq(runnerControlSessions.snapshotAccepted, true), sql`${runnerControlSessions.snapshotAcknowledgedAt} IS NOT NULL`)).limit(1);
        const [controller] = await tx.select({ generation: controllerState.desiredGeneration }).from(controllerState)
          // Generation writers do not all take the allocation advisory lock.
          // Hold the state row until this grant commits so an accepted check
          // cannot become stale while the insert is still being persisted.
          .where(eq(controllerState.id, "singleton")).limit(1).for("share");
        if (!registration || !controller || controller.generation !== input.generation) {
          throw new ConflictError("Runner registration or snapshot generation is no longer current.", "runner_lease_snapshot_unavailable");
        }
      }
      const [issued] = await tx.insert(runnerServingGrants).values({ ...input,
        issuedAt: sql`clock_timestamp()`,
        conservativeExpiresAt: sql`clock_timestamp() + (${input.durationMs + input.uncertaintyMs} * interval '1 millisecond')`,
      }).onConflictDoNothing().returning();
      if (issued) return issued;
      // Returning a cached grant after a second request could let a Runner
      // incorrectly measure its local deadline from that later request.
      throw new ConflictError("Runner lease challenge was already used.", "runner_lease_challenge_conflict");
    });
  }

  /** Stop new grants. Disconnection or replacement boot never erases grants. */
  async beginDrain(poolId: string, expectedEpoch: number) {
    validateId(poolId);
    validateCounter(expectedEpoch);
    return this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, allocationLock);
      const state = await this.poolState(tx, poolId);
      if (state.epoch !== expectedEpoch) throw new ConflictError("Runner pool lease epoch changed.", "runner_lease_epoch_conflict");
      const [updated] = await tx.update(runnerPoolLeaseEpochs).set({ draining: true, updatedAt: sql`clock_timestamp()` })
        .where(eq(runnerPoolLeaseEpochs.poolId, poolId)).returning();
      return updated!;
    });
  }

  /** Snapshot only. Database clock jumps or failover skew can report zero too
   * early; no live move may rely on this without a verified time bound or
   * independently attested workload/network fencing. */
  async outstanding(poolId: string, epoch: number) {
    validateId(poolId);
    validateCounter(epoch);
    return this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, allocationLock);
      await this.poolState(tx, poolId);
      const [result] = await tx.select({
        count: sql<number>`count(*)::int`,
        until: sql<Date | null>`max(${runnerServingGrants.conservativeExpiresAt})`,
      }).from(runnerServingGrants).where(and(eq(runnerServingGrants.poolId, poolId),
        eq(runnerServingGrants.epoch, epoch), sql`${runnerServingGrants.conservativeExpiresAt} > clock_timestamp()`));
      return result!;
    });
  }
}

function validateId(value: string) {
  if (typeof value !== "string" || !value || value.length > 256 || value !== value.trim()) {
    throw new ValidationError("Runner lease identities must be nonempty strings of at most 256 characters.");
  }
}

function validateCounter(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new ValidationError("Runner lease epoch and generation must be nonnegative safe integers.");
}

function validate(input: Grant) {
  for (const value of [input.poolId, input.runnerId, input.bootId, input.nonce]) validateId(value);
  validateCounter(input.epoch);
  validateCounter(input.generation);
  if (!Number.isInteger(input.durationMs) || input.durationMs < 1 || input.durationMs > MAX_DURATION_MS ||
      !Number.isInteger(input.uncertaintyMs) || input.uncertaintyMs < 0 || input.uncertaintyMs > MAX_UNCERTAINTY_MS) {
    throw new ValidationError("Runner lease duration and uncertainty must be bounded integer milliseconds.");
  }
}
