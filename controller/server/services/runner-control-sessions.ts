import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { ControllerDatabase } from "../db/client.js";
import { advisoryTransactionLock } from "../db/postgres-locks.js";
import { controllerState, runnerControlSessions, runnerInstances, runnerPoolLeaseEpochs, runnerPools } from "../db/schema.js";

const allocationLock = "traffic-router-bindings";
export type ControlSessionIdentity = { sessionId: string; runnerId: string; bootId: string; poolId: string };
export type ControlSnapshotIdentity = ControlSessionIdentity & { nonce: string; generation: number; modelRevisionId: string };

/** Durable current-stream ownership and latest snapshot evidence.
 * This does not grant serving authority or fence an already-running workload.
 */
export class RunnerControlSessionStore {
  constructor(private readonly db: ControllerDatabase) {}

  async isCurrent(identity: ControlSessionIdentity): Promise<boolean> {
    const [row] = await this.db.select({ id: runnerInstances.runnerId }).from(runnerInstances)
      .innerJoin(runnerControlSessions, eq(runnerControlSessions.id, runnerInstances.controlSessionId))
      .where(and(eq(runnerInstances.runnerId, identity.runnerId), eq(runnerInstances.bootId, identity.bootId),
        eq(runnerInstances.poolId, identity.poolId), eq(runnerInstances.controlSessionId, identity.sessionId),
        eq(runnerControlSessions.runnerId, identity.runnerId), eq(runnerControlSessions.bootId, identity.bootId),
        eq(runnerControlSessions.poolId, identity.poolId),
        isNull(runnerInstances.disconnectedAt), isNull(runnerControlSessions.disconnectedAt), ne(runnerInstances.status, "offline"))).limit(1);
    return Boolean(row);
  }

  async dispatched(input: ControlSnapshotIdentity): Promise<boolean> {
    return Boolean(await this.dispatchedAllocation(input));
  }

  /** Return the exact allocation persisted with this challenged snapshot. */
  async dispatchedAllocation(input: ControlSnapshotIdentity): Promise<{ epoch: number; groupId: string } | null> {
    return this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, allocationLock);
      const [current] = await tx.select({ groupId: runnerPools.groupId }).from(runnerInstances)
        .innerJoin(runnerPools, eq(runnerPools.id, runnerInstances.poolId))
        .where(and(eq(runnerInstances.runnerId, input.runnerId), eq(runnerInstances.bootId, input.bootId),
          eq(runnerInstances.poolId, input.poolId), eq(runnerInstances.controlSessionId, input.sessionId),
          isNull(runnerInstances.disconnectedAt), ne(runnerInstances.status, "offline"))).limit(1);
      const [controller] = await tx.select({ generation: controllerState.desiredGeneration }).from(controllerState)
        .where(eq(controllerState.id, "singleton"));
      if (!current || controller?.generation !== input.generation) return null;
      await tx.insert(runnerPoolLeaseEpochs).values({ poolId: input.poolId }).onConflictDoNothing();
      const [epoch] = await tx.select({ epoch: runnerPoolLeaseEpochs.epoch }).from(runnerPoolLeaseEpochs)
        .where(eq(runnerPoolLeaseEpochs.poolId, input.poolId));
      const updated = await tx.update(runnerControlSessions).set({ snapshotNonce: input.nonce,
        snapshotGeneration: input.generation, snapshotModelRevisionId: input.modelRevisionId,
        snapshotEpoch: epoch!.epoch, snapshotGroupId: current.groupId, snapshotDispatchedAt: sql`clock_timestamp()`,
        snapshotAcknowledgedAt: null, snapshotAccepted: false })
        .where(and(eq(runnerControlSessions.id, input.sessionId), eq(runnerControlSessions.runnerId, input.runnerId),
          eq(runnerControlSessions.bootId, input.bootId), eq(runnerControlSessions.poolId, input.poolId), isNull(runnerControlSessions.disconnectedAt)))
        .returning({ id: runnerControlSessions.id });
      return updated.length === 1 ? { epoch: epoch!.epoch, groupId: current.groupId } : null;
    });
  }

  async acknowledged(input: ControlSnapshotIdentity & { accepted: boolean }): Promise<boolean> {
    return this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, allocationLock);
      const [current] = await tx.select({ groupId: runnerPools.groupId, epoch: runnerPoolLeaseEpochs.epoch,
        generation: controllerState.desiredGeneration }).from(runnerInstances)
        .innerJoin(runnerPools, eq(runnerPools.id, runnerInstances.poolId))
        .innerJoin(runnerPoolLeaseEpochs, eq(runnerPoolLeaseEpochs.poolId, runnerPools.id))
        .innerJoin(controllerState, eq(controllerState.id, "singleton"))
        .where(and(eq(runnerInstances.runnerId, input.runnerId), eq(runnerInstances.bootId, input.bootId),
          eq(runnerInstances.poolId, input.poolId), eq(runnerInstances.controlSessionId, input.sessionId),
          isNull(runnerInstances.disconnectedAt), ne(runnerInstances.status, "offline"))).limit(1);
      if (!current || current.generation !== input.generation) return false;
      const updated = await tx.update(runnerControlSessions).set({ snapshotAcknowledgedAt: sql`clock_timestamp()`, snapshotAccepted: input.accepted })
        .where(and(eq(runnerControlSessions.id, input.sessionId), isNull(runnerControlSessions.disconnectedAt),
          eq(runnerControlSessions.runnerId, input.runnerId), eq(runnerControlSessions.bootId, input.bootId), eq(runnerControlSessions.poolId, input.poolId),
          eq(runnerControlSessions.snapshotNonce, input.nonce), eq(runnerControlSessions.snapshotGeneration, input.generation),
          eq(runnerControlSessions.snapshotModelRevisionId, input.modelRevisionId),
          eq(runnerControlSessions.snapshotEpoch, current.epoch), eq(runnerControlSessions.snapshotGroupId, current.groupId),
          isNull(runnerControlSessions.snapshotAcknowledgedAt)))
        .returning({ id: runnerControlSessions.id });
      return updated.length === 1;
    });
  }
}
