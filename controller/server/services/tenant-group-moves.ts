import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ControllerDatabase } from "../db/client.js";
import { advisoryTransactionLock } from "../db/postgres-locks.js";
import { auditEvents, controllerState, outboxEvents, runnerControlSessions, runnerPoolLeaseEpochs, runnerPools, runnerServingGrants, tenantGroupMoveGroups,
  tenantGroupMovePools, tenantGroupMoves, tenantGroups, tenants } from "../db/schema.js";
import { ConflictError, NotFoundError, ValidationError } from "../domain/errors.js";
import { assertPlatformAuthority } from "./tenant-context.js";
import { retireEndpointTelemetryContexts } from "./endpoint-telemetry-contexts.js";

type Transaction = Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0];
const allocationLock = "traffic-router-bindings";
type MoveInput = { kind: "tenant" | "pool"; subjectId: string; sourceGroupId: string;
  destinationGroupId: string; actorId: string; idempotencyKey: string };
type WaitHandle = Readonly<{ moveId: string; barrierId: string; attemptId: string }>;
type WaitAttempt = { startedAt: number; horizonMs: number; observedAt?: number; observedElapsedMs?: number };
type Options = { enabled?: boolean; maxGrantDurationMs?: number; waitHorizonMs?: number;
  timingPolicyId?: string; monotonicNow?: () => number; externalFenceVerifier?: AuthoritativeExternalFenceVerifier };
type Move = typeof tenantGroupMoves.$inferSelect;
type CapturedPool = typeof tenantGroupMovePools.$inferSelect;

export type AllocationFenceRequest = Readonly<{
  moveId: string; barrierId: string; bindingDigest: string; kind: "tenant" | "pool"; subjectId: string;
  sourceGroupId: string; destinationGroupId: string; timingPolicyId: string; waitAttemptId: string;
  waitProcessId: string; waitElapsedMs: number; waitHorizonMs: number; maxGrantDurationMs: number;
  sourcePools: ReadonlyArray<Readonly<{ poolId: string; sourceEpoch: number; sourceBarrierRevision: number; grantDigest: string }>>;
}>;
export type PermanentAllocationFence = Readonly<{
  verified: true; capabilityKind: "permanent_external_fence"; verifierId: string; evidenceId: string;
  moveId: string; barrierId: string; bindingDigest: string; sourcePoolIds: readonly string[];
}>;
/** This is an authoritative infrastructure trust boundary, not caller input.
 * A positive capability guarantees all old source workloads and their retained
 * route/network/credential authority are permanently fenced for this barrier,
 * including throughout commit. A momentary stopped/offline observation, an
 * expiring permit, or Runner self-report MUST NOT produce a positive result.
 * Calls must be idempotent by bindingDigest. No production implementation or
 * insecure HTTP evidence adapter is supplied by this module. */
export interface AuthoritativeExternalFenceVerifier {
  verifyPermanentFence(request: AllocationFenceRequest): Promise<PermanentAllocationFence | null>;
}

/** Caller must hold the allocation advisory lock. Prepared moves are durable
 * claims, not permission for a direct assignment to bypass drain/epoch work. */
export async function assertNoPreparedAllocationTransition(tx: Transaction,
  input: { groupIds?: readonly string[]; poolIds?: readonly string[] }): Promise<void> {
  const groups = [...new Set(input.groupIds ?? [])], pools = [...new Set(input.poolIds ?? [])];
  const group = groups.length ? await tx.select({ id: tenantGroupMoveGroups.moveId }).from(tenantGroupMoveGroups)
    .where(inArray(tenantGroupMoveGroups.groupId, groups)).limit(1) : [];
  const pool = pools.length ? await tx.select({ id: tenantGroupMovePools.moveId }).from(tenantGroupMovePools)
    .where(and(inArray(tenantGroupMovePools.poolId, pools), isNull(tenantGroupMovePools.releasedAt))).limit(1) : [];
  if (group.length || pool.length) throw new ConflictError(
    "An allocation transition is already prepared for an affected group or pool.", "allocation_transition_in_progress");
}

/** Disabled-by-default allocation transitions. Finalization additionally needs
 * a live full-horizon observation and an authoritative permanent external fence.
 * There is no cancellation, insecure evidence adapter, or startup/API wiring. */
export class TenantGroupMoveService {
  private readonly enabled: boolean;
  private readonly maxGrantDurationMs: number;
  private readonly waitHorizonMs: number;
  private readonly timingPolicyId: string;
  private readonly now: () => number;
  private readonly externalFenceVerifier: AuthoritativeExternalFenceVerifier | undefined;
  private readonly processId = randomUUID();
  private readonly waits = new WeakMap<WaitHandle, WaitAttempt>();

  constructor(private readonly db: ControllerDatabase, options: Options = {}) {
    this.enabled = options.enabled ?? false;
    this.maxGrantDurationMs = options.maxGrantDurationMs ?? 60_000;
    this.waitHorizonMs = options.waitHorizonMs ?? 65_000;
    this.timingPolicyId = options.timingPolicyId ?? "unverified-experimental-timing-v1";
    this.now = options.monotonicNow ?? (() => performance.now());
    this.externalFenceVerifier = options.externalFenceVerifier;
    validId(this.timingPolicyId);
    if (!Number.isSafeInteger(this.maxGrantDurationMs) || this.maxGrantDurationMs < 1 || this.maxGrantDurationMs > 60_000 ||
        !Number.isSafeInteger(this.waitHorizonMs) || this.waitHorizonMs < this.maxGrantDurationMs || this.waitHorizonMs > 600_000) {
      throw new ValidationError("Prepared allocation timing bounds are invalid.");
    }
  }

  async prepare(input: MoveInput) {
    this.authorize();
    if (input.kind !== "tenant" && input.kind !== "pool") throw new ValidationError("Allocation transition kind is invalid.");
    for (const value of [input.subjectId, input.sourceGroupId, input.destinationGroupId, input.actorId, input.idempotencyKey]) validId(value);
    if (input.sourceGroupId === input.destinationGroupId) throw new ValidationError("A prepared transition requires different source and destination groups.");
    return this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, allocationLock);
      const [existing] = await tx.select().from(tenantGroupMoves).where(and(eq(tenantGroupMoves.actorId, input.actorId),
        eq(tenantGroupMoves.idempotencyKey, input.idempotencyKey)));
      if (existing) {
        if (existing.kind !== input.kind || existing.subjectId !== input.subjectId || existing.sourceGroupId !== input.sourceGroupId ||
            existing.destinationGroupId !== input.destinationGroupId) throw new ConflictError(
          "The allocation idempotency key already belongs to another request.", "allocation_transition_idempotency_conflict");
        return existing;
      }
      const groups = await tx.select().from(tenantGroups).where(inArray(tenantGroups.id,
        [input.sourceGroupId, input.destinationGroupId])).orderBy(asc(tenantGroups.id)).for("update");
      for (const id of [input.sourceGroupId, input.destinationGroupId]) if (!groups.some(group => group.id === id)) throw new NotFoundError("Tenant Group", id);
      const [subject] = input.kind === "tenant"
        ? await tx.select({ id: tenants.id, groupId: tenants.groupId }).from(tenants).where(eq(tenants.id, input.subjectId)).for("update")
        : await tx.select({ id: runnerPools.id, groupId: runnerPools.groupId }).from(runnerPools).where(eq(runnerPools.id, input.subjectId)).for("update");
      if (!subject) throw new NotFoundError(input.kind === "tenant" ? "Tenant" : "Runner Pool", input.subjectId);
      if (subject.groupId !== input.sourceGroupId) throw new ConflictError("The source group changed. Reload allocation before preparing a move.", "tenant_group_assignment_conflict");
      if (input.kind === "pool" && input.subjectId === "default") throw new ConflictError("The default Runner pool cannot be moved.", "default_runner_pool_protected");
      const pools = await tx.select().from(runnerPools).where(input.kind === "tenant"
        ? eq(runnerPools.groupId, input.sourceGroupId) : eq(runnerPools.id, input.subjectId)).orderBy(asc(runnerPools.id)).for("update");
      if (input.kind === "pool" && pools[0]?.isDefault) throw new ConflictError("The default Runner pool cannot be moved.", "default_runner_pool_protected");
      await assertNoPreparedAllocationTransition(tx, { groupIds: [input.sourceGroupId, input.destinationGroupId], poolIds: pools.map(pool => pool.id) });
      const [subjectMove] = await tx.select({ id: tenantGroupMoves.id }).from(tenantGroupMoves)
        .where(and(eq(tenantGroupMoves.kind, input.kind), eq(tenantGroupMoves.subjectId, input.subjectId), eq(tenantGroupMoves.state, "prepared"))).limit(1);
      if (subjectMove) throw new ConflictError("The resource already has a prepared allocation transition.", "allocation_transition_in_progress");
      const captured: Array<typeof tenantGroupMovePools.$inferInsert> = [];
      const moveId = randomUUID(), barrierId = randomUUID();
      for (const pool of pools) {
        await tx.insert(runnerPoolLeaseEpochs).values({ poolId: pool.id }).onConflictDoNothing();
        const [epoch] = await tx.select().from(runnerPoolLeaseEpochs).where(eq(runnerPoolLeaseEpochs.poolId, pool.id)).for("update");
        if (!epoch || !Number.isSafeInteger(epoch.epoch) || epoch.epoch < 0 || epoch.epoch === Number.MAX_SAFE_INTEGER || epoch.draining ||
            // Prepare and completion each advance the database revision. Do
            // not establish an uncancelable barrier with no completion slot.
            !Number.isSafeInteger(epoch.barrierRevision) || epoch.barrierRevision < 0 || epoch.barrierRevision >= Number.MAX_SAFE_INTEGER - 1) {
          throw new ConflictError("A source pool cannot establish a new allocation drain.", "allocation_transition_pool_unavailable");
        }
        const history = await this.grantHistory(tx, pool.id);
        if (history.invalid || !Number.isSafeInteger(history.count)) throw new ConflictError(
          "Historical grant bounds cannot establish the configured allocation wait.", "allocation_transition_unbounded_history");
        captured.push({ poolId: pool.id, moveId, sourceGroupId: pool.groupId, sourceEpoch: epoch.epoch,
          sourceBarrierRevision: epoch.barrierRevision + 1, grantCount: history.count, grantDigest: history.digest,
          longestGrantMs: history.maxDuration, requiresExternalFence: true });
      }
      const [move] = await tx.insert(tenantGroupMoves).values({ id: moveId, barrierId, ...input,
        timingPolicyId: this.timingPolicyId, maxGrantDurationMs: this.maxGrantDurationMs, waitHorizonMs: this.waitHorizonMs,
        requiresExternalFence: true }).returning();
      await tx.insert(tenantGroupMoveGroups).values([input.sourceGroupId, input.destinationGroupId].map(groupId => ({ groupId, moveId })));
      if (captured.length) {
        await tx.insert(tenantGroupMovePools).values(captured);
        await tx.update(runnerPoolLeaseEpochs).set({ draining: true, updatedAt: sql`clock_timestamp()` })
          .where(inArray(runnerPoolLeaseEpochs.poolId, pools.map(pool => pool.id)));
      }
      await tx.insert(auditEvents).values({ id: randomUUID(), kind: "tenant_group.move_prepared", actorId: input.actorId,
        resourceType: "allocation_move", resourceId: moveId, detail: { kind: input.kind, subjectId: input.subjectId,
          sourceGroupId: input.sourceGroupId, destinationGroupId: input.destinationGroupId, barrierId, poolIds: pools.map(pool => pool.id), requiresExternalFence: true } });
      return move!;
    });
  }

  async get(moveId: string) {
    this.authorize(); validId(moveId);
    const [move] = await this.db.select().from(tenantGroupMoves).where(eq(tenantGroupMoves.id, moveId));
    if (!move) throw new NotFoundError("Allocation transition", moveId);
    const pools = await this.db.select().from(tenantGroupMovePools).where(eq(tenantGroupMovePools.moveId, moveId)).orderBy(asc(tenantGroupMovePools.poolId));
    return { ...move, pools };
  }

  /** Each observation starts a fresh full horizon. Starting a replacement
   * observation invalidates the previous attempt, even on another Controller. */
  async beginWait(moveId: string): Promise<WaitHandle> {
    this.authorize(); validId(moveId);
    const handle = await this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, allocationLock);
      const move = await this.verifyBarrier(tx, moveId);
      if (move.timingPolicyId !== this.timingPolicyId || move.waitHorizonMs !== this.waitHorizonMs || move.maxGrantDurationMs !== this.maxGrantDurationMs) {
        throw new ConflictError("The timing policy changed; this barrier cannot reuse it.", "allocation_transition_timing_conflict");
      }
      const attemptId = randomUUID();
      await tx.update(tenantGroupMoves).set({ waitAttemptId: attemptId, waitProcessId: this.processId, waitStartedAt: sql`clock_timestamp()`,
        waitObservedAt: null, waitElapsedMs: null, updatedAt: sql`clock_timestamp()` }).where(eq(tenantGroupMoves.id, moveId));
      return Object.freeze({ moveId, barrierId: move.barrierId, attemptId });
    });
    const startedAt = this.monotonic();
    this.waits.set(handle, { startedAt, horizonMs: this.waitHorizonMs });
    return handle;
  }

  /** Record elapsed observation only. Retain the live opaque handle for a later
   * finalization; persisted elapsed metadata alone never authorizes completion. */
  async observeElapsed(handle: WaitHandle) {
    this.authorize();
    const attempt = this.waits.get(handle);
    if (!attempt) throw new ConflictError("A fresh local monotonic observation is required.", "allocation_transition_wait_unavailable");
    if (attempt.observedAt !== undefined) throw new ConflictError("This allocation wait was already observed.", "allocation_transition_wait_unavailable");
    let current: number;
    try { current = this.monotonic(); }
    catch (error) { this.waits.delete(handle); throw error; }
    const elapsed = current - attempt.startedAt;
    if (!Number.isSafeInteger(Math.floor(elapsed)) || elapsed < 0) {
      this.waits.delete(handle);
      throw new ConflictError("The monotonic observation is uncertain; restart the full wait.", "allocation_transition_wait_unavailable");
    }
    if (elapsed < attempt.horizonMs) throw new ConflictError("The full allocation wait has not elapsed.", "allocation_transition_wait_incomplete");
    let observed: typeof tenantGroupMoves.$inferSelect;
    try { observed = await this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, allocationLock);
      const move = await this.verifyBarrier(tx, handle.moveId);
      if (move.barrierId !== handle.barrierId || move.waitAttemptId !== handle.attemptId || move.waitProcessId !== this.processId ||
          move.waitObservedAt !== null || move.timingPolicyId !== this.timingPolicyId || move.waitHorizonMs !== attempt.horizonMs ||
          move.maxGrantDurationMs !== this.maxGrantDurationMs) {
        throw new ConflictError("The allocation wait attempt was replaced or already observed.", "allocation_transition_wait_unavailable");
      }
      const [row] = await tx.update(tenantGroupMoves).set({ waitObservedAt: sql`clock_timestamp()`, waitElapsedMs: Math.floor(elapsed),
        updatedAt: sql`clock_timestamp()` }).where(eq(tenantGroupMoves.id, move.id)).returning();
      return row!;
    }); } catch (error) {
      // Database uncertainty or a broken barrier invalidates this local proof;
      // repairing topology must not let the old elapsed timer be reused.
      this.waits.delete(handle);
      throw error;
    }
    attempt.observedAt = current;
    attempt.observedElapsedMs = Math.floor(elapsed);
    return observed;
  }

  /** Complete only after a live local full-horizon observation and authoritative
   * permanent fencing. Completed retries are read-only, including after restart.
   * The verifier runs outside all database locks; after it returns the exact
   * request and local observation are revalidated under the allocation lock. */
  async finalize(moveId: string, handle: WaitHandle | undefined, actorId: string) {
    this.authorize(); validId(moveId); validId(actorId);
    try {
      const snapshot = await this.db.transaction(async tx => {
        await advisoryTransactionLock(tx, allocationLock);
        const [existing] = await tx.select().from(tenantGroupMoves).where(eq(tenantGroupMoves.id, moveId)).for("update");
        if (!existing) throw new NotFoundError("Allocation transition", moveId);
        if (existing.state === "completed") return { completed: existing };
        if (!this.externalFenceVerifier) throw new ConflictError(
          "An authoritative permanent external-fence verifier is required.", "allocation_transition_fencer_unavailable");
        const move = await this.verifyBarrier(tx, moveId);
        this.requireLiveObservation(handle, move);
        const pools = await tx.select().from(tenantGroupMovePools).where(eq(tenantGroupMovePools.moveId, moveId)).orderBy(asc(tenantGroupMovePools.poolId));
        return { request: fenceRequest(move, pools) };
      });
      if (snapshot.completed) return snapshot.completed;
      const request = snapshot.request!;
      const fence = requirePermanentFence(request, await this.externalFenceVerifier!.verifyPermanentFence(request));
      const completed = await this.db.transaction(async tx => {
        await advisoryTransactionLock(tx, allocationLock);
        const [existing] = await tx.select().from(tenantGroupMoves).where(eq(tenantGroupMoves.id, moveId)).for("update");
        if (!existing) throw new NotFoundError("Allocation transition", moveId);
        if (existing.state === "completed") return existing;
        const move = await this.verifyBarrier(tx, moveId);
        this.requireLiveObservation(handle, move);
        const pools = await tx.select().from(tenantGroupMovePools).where(eq(tenantGroupMovePools.moveId, moveId)).orderBy(asc(tenantGroupMovePools.poolId));
        if (fenceRequest(move, pools).bindingDigest !== request.bindingDigest) throw new ConflictError(
          "The allocation barrier or wait changed during external verification.", "allocation_transition_fence_stale");
        const [subject] = move.kind === "tenant"
          ? await tx.update(tenants).set({ groupId: move.destinationGroupId })
            .where(and(eq(tenants.id, move.subjectId), eq(tenants.groupId, move.sourceGroupId))).returning({ id: tenants.id })
          : await tx.update(runnerPools).set({ groupId: move.destinationGroupId, updatedAt: sql`clock_timestamp()` })
            .where(and(eq(runnerPools.id, move.subjectId), eq(runnerPools.groupId, move.sourceGroupId))).returning({ id: runnerPools.id });
        if (!subject) throw new ConflictError("Allocation ownership changed before commit.", "allocation_transition_barrier_changed");
        for (const pool of pools) {
          const [advanced] = await tx.update(runnerPoolLeaseEpochs).set({ epoch: pool.sourceEpoch + 1, draining: false, updatedAt: sql`clock_timestamp()` })
            .where(and(eq(runnerPoolLeaseEpochs.poolId, pool.poolId), eq(runnerPoolLeaseEpochs.epoch, pool.sourceEpoch),
              eq(runnerPoolLeaseEpochs.barrierRevision, pool.sourceBarrierRevision), eq(runnerPoolLeaseEpochs.draining, true))).returning({ id: runnerPoolLeaseEpochs.poolId });
          if (!advanced) throw new ConflictError("A source barrier changed before commit.", "allocation_transition_barrier_changed");
        }
        if (pools.length) await tx.update(runnerControlSessions).set({ snapshotAccepted: false, snapshotAcknowledgedAt: null })
          .where(inArray(runnerControlSessions.poolId, pools.map(pool => pool.poolId)));
        await retireEndpointTelemetryContexts(tx, pools.map(pool => pool.poolId));
        const [state] = await tx.select().from(controllerState).where(eq(controllerState.id, "singleton")).for("update");
        if (!state || !Number.isSafeInteger(state.desiredGeneration) || state.desiredGeneration < 0 || state.desiredGeneration === Number.MAX_SAFE_INTEGER) {
          throw new ConflictError("Controller generation cannot advance safely.", "allocation_transition_generation_unavailable");
        }
        const generation = state.desiredGeneration + 1;
        await tx.update(controllerState).set({ desiredGeneration: generation, updatedAt: sql`clock_timestamp()` }).where(eq(controllerState.id, "singleton"));
        const [result] = await tx.update(tenantGroupMoves).set({ state: "completed", completedAt: sql`clock_timestamp()`,
          completedGeneration: generation, completedActorId: actorId, fenceVerifierId: fence.verifierId,
          fenceEvidenceId: fence.evidenceId, fenceBindingDigest: request.bindingDigest, updatedAt: sql`clock_timestamp()` })
          .where(eq(tenantGroupMoves.id, moveId)).returning();
        await tx.delete(tenantGroupMoveGroups).where(eq(tenantGroupMoveGroups.moveId, moveId));
        await tx.update(tenantGroupMovePools).set({ releasedAt: sql`clock_timestamp()` }).where(eq(tenantGroupMovePools.moveId, moveId));
        const detail = { moveId, kind: move.kind, subjectId: move.subjectId, previousGroupId: move.sourceGroupId,
          groupId: move.destinationGroupId, sourcePoolIds: pools.map(pool => pool.poolId), generation,
          fenceVerifierId: fence.verifierId, fenceEvidenceId: fence.evidenceId, fenceBindingDigest: request.bindingDigest };
        await tx.insert(outboxEvents).values({ id: randomUUID(), kind: "runner.desired_state_changed", aggregateId: moveId,
          payload: { resourceType: "allocation_move", resourceId: moveId, ...detail } });
        await tx.insert(auditEvents).values({ id: randomUUID(), kind: "tenant_group.move_completed", actorId,
          resourceType: "allocation_move", resourceId: moveId, detail });
        return result!;
      });
      if (handle) this.waits.delete(handle);
      return completed;
    } catch (error) {
      // An uncertain fence/commit cannot preserve a reusable local completion
      // capability. A retry must observe another complete horizon unless the
      // transaction already committed, in which case status is read-only.
      if (handle) this.waits.delete(handle);
      throw error;
    }
  }

  private requireLiveObservation(handle: WaitHandle | undefined, move: Move) {
    const attempt = handle && this.waits.get(handle);
    if (!handle || !attempt || handle.moveId !== move.id || handle.barrierId !== move.barrierId || attempt.observedAt === undefined ||
        attempt.observedElapsedMs === undefined || move.waitObservedAt === null || move.waitElapsedMs !== attempt.observedElapsedMs ||
        move.waitAttemptId !== handle.attemptId || move.waitProcessId !== this.processId || move.timingPolicyId !== this.timingPolicyId ||
        move.maxGrantDurationMs !== this.maxGrantDurationMs || move.waitHorizonMs !== this.waitHorizonMs ||
        move.waitHorizonMs !== attempt.horizonMs || attempt.observedElapsedMs < attempt.horizonMs) {
      throw new ConflictError("A live local full-horizon observation is required for completion.", "allocation_transition_wait_unavailable");
    }
    const current = this.monotonic();
    if (current < attempt.observedAt || current - attempt.startedAt < attempt.horizonMs) throw new ConflictError(
      "The live allocation observation became uncertain.", "allocation_transition_wait_unavailable");
  }

  private async verifyBarrier(tx: Transaction, moveId: string) {
    const [move] = await tx.select().from(tenantGroupMoves).where(eq(tenantGroupMoves.id, moveId)).for("update");
    if (!move) throw new NotFoundError("Allocation transition", moveId);
    const groups = await tx.select().from(tenantGroupMoveGroups).where(eq(tenantGroupMoveGroups.moveId, moveId));
    const captures = await tx.select().from(tenantGroupMovePools).where(eq(tenantGroupMovePools.moveId, moveId));
    const [subject] = move.kind === "tenant"
      ? await tx.select({ groupId: tenants.groupId }).from(tenants).where(eq(tenants.id, move.subjectId))
      : await tx.select({ groupId: runnerPools.groupId }).from(runnerPools).where(eq(runnerPools.id, move.subjectId));
    const pools = await tx.select({ poolId: runnerPools.id, groupId: runnerPools.groupId, epoch: runnerPoolLeaseEpochs.epoch,
      draining: runnerPoolLeaseEpochs.draining, barrierRevision: runnerPoolLeaseEpochs.barrierRevision })
      .from(runnerPools).leftJoin(runnerPoolLeaseEpochs, eq(runnerPoolLeaseEpochs.poolId, runnerPools.id))
      .where(move.kind === "tenant" ? eq(runnerPools.groupId, move.sourceGroupId) : eq(runnerPools.id, move.subjectId));
    if (move.state !== "prepared" || !move.requiresExternalFence || subject?.groupId !== move.sourceGroupId || groups.length !== 2 || captures.some(pool => pool.releasedAt !== null) ||
        ![move.sourceGroupId, move.destinationGroupId].every(id => groups.some(group => group.groupId === id)) || pools.length !== captures.length ||
        pools.some(pool => !pool.draining || !captures.some(capture => capture.poolId === pool.poolId && capture.sourceGroupId === pool.groupId &&
          capture.sourceEpoch === pool.epoch && capture.sourceBarrierRevision === pool.barrierRevision))) {
      throw new ConflictError("The prepared allocation barrier is no longer intact.", "allocation_transition_barrier_changed");
    }
    for (const capture of captures) {
      const history = await this.grantHistory(tx, capture.poolId);
      if (history.invalid || history.count !== capture.grantCount || history.maxDuration !== capture.longestGrantMs || history.digest !== capture.grantDigest) {
        throw new ConflictError("Grant history changed after the prepared barrier.", "allocation_transition_barrier_changed");
      }
    }
    return move;
  }

  private async grantHistory(tx: Transaction, poolId: string) {
    // Explicit PostgreSQL JSON serialization preserves complete numeric values
    // and sub-millisecond timestamps. Epoch seconds avoid session time-zone
    // differences; every currently authorized grant field is bound in order.
    const rows = await tx.select({ duration: runnerServingGrants.durationMs, uncertainty: runnerServingGrants.uncertaintyMs,
      serialized: sql<string>`jsonb_build_array(${runnerServingGrants.poolId}, ${runnerServingGrants.runnerId},
        ${runnerServingGrants.bootId}, ${runnerServingGrants.nonce}, ${runnerServingGrants.epoch}, ${runnerServingGrants.generation},
        ${runnerServingGrants.durationMs}, ${runnerServingGrants.uncertaintyMs}, ${runnerServingGrants.snapshotNonce},
        ${runnerServingGrants.modelRevisionId}, ${runnerServingGrants.controlSessionId},
        extract(epoch from ${runnerServingGrants.issuedAt}), extract(epoch from ${runnerServingGrants.conservativeExpiresAt}))::text` })
      .from(runnerServingGrants).where(eq(runnerServingGrants.poolId, poolId))
      .orderBy(asc(runnerServingGrants.runnerId), asc(runnerServingGrants.bootId), asc(runnerServingGrants.nonce));
    const digest = createHash("sha256");
    let maxDuration = 0, invalid = false;
    for (const row of rows) {
      digest.update(row.serialized).update("\n");
      maxDuration = Math.max(maxDuration, row.duration);
      invalid ||= row.duration < 1 || row.duration > this.maxGrantDurationMs || row.uncertainty < 0 || row.uncertainty > 60_000;
    }
    return { count: rows.length, maxDuration, invalid, digest: digest.digest("hex") };
  }

  private authorize() {
    assertPlatformAuthority();
    if (!this.enabled) throw new ConflictError("Allocation transition preparation is disabled.", "allocation_transition_preparation_disabled");
  }
  private monotonic(): number {
    const value = this.now();
    if (!Number.isFinite(value) || value < 0) throw new ConflictError("A valid monotonic observation is required.", "allocation_transition_wait_unavailable");
    return value;
  }
}

// Preserve the preparation-only import name used by the preceding 0058 slice.
export { TenantGroupMoveService as TenantGroupMovePreparationService };

function fenceRequest(move: Move, pools: readonly CapturedPool[]): AllocationFenceRequest {
  const payload = { moveId: move.id, barrierId: move.barrierId, kind: move.kind, subjectId: move.subjectId,
    sourceGroupId: move.sourceGroupId, destinationGroupId: move.destinationGroupId, timingPolicyId: move.timingPolicyId,
    waitAttemptId: move.waitAttemptId!, waitProcessId: move.waitProcessId!, waitElapsedMs: move.waitElapsedMs!,
    waitHorizonMs: move.waitHorizonMs, maxGrantDurationMs: move.maxGrantDurationMs,
    sourcePools: Object.freeze(pools.map(pool => Object.freeze({ poolId: pool.poolId, sourceEpoch: pool.sourceEpoch,
      sourceBarrierRevision: pool.sourceBarrierRevision, grantDigest: pool.grantDigest }))) };
  return Object.freeze({ ...payload, bindingDigest: createHash("sha256").update(JSON.stringify(payload)).digest("hex") });
}

function requirePermanentFence(request: AllocationFenceRequest, evidence: PermanentAllocationFence | null) {
  if (!evidence || evidence.verified !== true || evidence.capabilityKind !== "permanent_external_fence" ||
      evidence.moveId !== request.moveId || evidence.barrierId !== request.barrierId || evidence.bindingDigest !== request.bindingDigest ||
      !isValidId(evidence.verifierId) || !isValidId(evidence.evidenceId) || !Array.isArray(evidence.sourcePoolIds) ||
      evidence.sourcePoolIds.some(id => !isValidId(id)) || JSON.stringify([...evidence.sourcePoolIds].sort()) !== JSON.stringify(request.sourcePools.map(pool => pool.poolId).sort())) {
    throw new ConflictError("A permanent external fence bound to the exact allocation barrier is required.", "allocation_transition_fence_unverified");
  }
  // Only non-secret infrastructure evidence identifiers are persisted.
  return { verifierId: evidence.verifierId, evidenceId: evidence.evidenceId };
}

function isValidId(value: unknown): value is string {
  return typeof value === "string" && Boolean(value) && value.length <= 256 && value === value.trim();
}

function validId(value: string) {
  if (!isValidId(value)) throw new ValidationError("Allocation transition identities must be nonempty strings of at most 256 characters.");
}
