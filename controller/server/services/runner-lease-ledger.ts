import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { ControllerDatabase } from "../db/client.js";
import { advisoryTransactionLock } from "../db/postgres-locks.js";
import { controllerState, runnerControlSessions, runnerInstances, runnerPoolLeaseEpochs, runnerPools, runnerServingGrants } from "../db/schema.js";
import { ConflictError, NotFoundError, ValidationError } from "../domain/errors.js";

// This is the same lock used by ProjectGroupService for allocation changes.
// The ledger persists grants; group reassignment still rejects grant history.
const allocationLock = "traffic-router-bindings";
const MAX_DURATION_MS = 60_000;
const MAX_UNCERTAINTY_MS = 60_000;
type Transaction = Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0];
type Grant = {
  poolId: string; runnerId: string; bootId: string; nonce: string;
  epoch: number; generation: number; durationMs: number; uncertaintyMs: number;
};
type SnapshotBoundGrant = Grant & { snapshotNonce: string; modelRevisionId: string; controlSessionId: string };

/** Persists grants for an authenticated stream with an accepted current snapshot. */
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

  async issueSnapshotBound(input: SnapshotBoundGrant) {
    validateId(input.controlSessionId);
    validateId(input.snapshotNonce);
    if (typeof input.modelRevisionId !== "string" || input.modelRevisionId.length > 256 || input.modelRevisionId !== input.modelRevisionId.trim()) {
      throw new ValidationError("Runner lease model revision is invalid.");
    }
    validate(input);
    return this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, allocationLock);
      const state = await this.poolState(tx, input.poolId);
      if (state.draining || state.epoch !== input.epoch) {
        throw new ConflictError("Runner pool is draining or has a different lease epoch.", "runner_lease_epoch_unavailable");
      }
      const [registration] = await tx.select({ runnerId: runnerInstances.runnerId }).from(runnerInstances)
        .innerJoin(runnerControlSessions, eq(runnerControlSessions.id, runnerInstances.controlSessionId))
        .innerJoin(runnerPools, eq(runnerPools.id, runnerInstances.poolId))
        .where(and(eq(runnerInstances.runnerId, input.runnerId), eq(runnerInstances.bootId, input.bootId),
          eq(runnerInstances.poolId, input.poolId), ne(runnerInstances.status, "offline"), isNull(runnerInstances.disconnectedAt),
          eq(runnerInstances.controlSessionId, input.controlSessionId),
          eq(runnerControlSessions.runnerId, input.runnerId), eq(runnerControlSessions.bootId, input.bootId),
          eq(runnerControlSessions.poolId, input.poolId), isNull(runnerControlSessions.disconnectedAt),
          eq(runnerControlSessions.snapshotNonce, input.snapshotNonce), eq(runnerControlSessions.snapshotGeneration, input.generation),
          eq(runnerControlSessions.snapshotModelRevisionId, input.modelRevisionId),
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
