import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { ControllerDatabase } from "../db/client.js";
import { advisoryTransactionLock } from "../db/postgres-locks.js";
import { runnerControlSessions, runnerInstances, runnerTelemetryCapabilities, runnerTelemetryWals } from "../db/schema.js";
import { ConflictError, ControllerError } from "../domain/errors.js";
import type { ControlSessionIdentity } from "./runner-control-sessions.js";

export type TelemetryTransaction = Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0];
const cursor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const telemetryProgressInput = z.object({ walId: z.string().uuid(), batchId: z.string().uuid(),
  firstCursor: cursor, lastCursor: cursor, producedCursor: cursor }).strict();
export type TelemetryProgressInput = z.infer<typeof telemetryProgressInput>;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Current authenticated control-stream dispatch, not workload attestation.
 * No diagnostics here are consumed as deletion/rollout freshness evidence.
 */
export class RunnerTelemetryProgress {
  constructor(private readonly db: ControllerDatabase) {}

  async issue(identity: ControlSessionIdentity, walId: string) {
    if (!z.string().uuid().safeParse(walId).success) throw new ConflictError("Telemetry WAL identity is invalid.", "telemetry_wal_conflict");
    return this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, "traffic-router-bindings");
      if (!await current(tx, identity, true)) throw unavailable();
      await tx.insert(runnerTelemetryWals).values({ runnerId: identity.runnerId, poolId: identity.poolId, walId }).onConflictDoNothing();
      let [wal] = await tx.select().from(runnerTelemetryWals).where(eq(runnerTelemetryWals.runnerId, identity.runnerId)).for("update");
      if (!wal || wal.poolId !== identity.poolId) throw new ConflictError(
        "Telemetry WAL does not belong to this Runner pool.", "telemetry_wal_conflict");
      if (wal.walId !== walId) {
        // Telemetry is best effort: a missing local WAL starts fresh on
        // registration. Revoke capabilities tied to the previous WAL.
        await tx.delete(runnerTelemetryCapabilities).where(eq(runnerTelemetryCapabilities.walId, wal.walId));
        [wal] = await tx.update(runnerTelemetryWals).set({ walId, acknowledgedCursor: 0, producedCursor: 0,
          lastBatchId: null, lastBatchDigest: null, lastBatchFirst: null, lastBatchLast: null,
          receivedAt: null, caughtUpAt: null }).where(eq(runnerTelemetryWals.runnerId, identity.runnerId)).returning();
        if (!wal) throw unavailable();
      }
      const token = randomBytes(32).toString("hex");
      const [issued] = await tx.insert(runnerTelemetryCapabilities).values({ controlSessionId: identity.sessionId,
        walId, capabilityHash: digest(token) }).onConflictDoNothing().returning({ id: runnerTelemetryCapabilities.controlSessionId });
      if (!issued) throw new ConflictError("Telemetry capability was already dispatched for this session.", "telemetry_capability_conflict");
      await tx.update(runnerTelemetryWals).set({ caughtUpAt: null }).where(eq(runnerTelemetryWals.runnerId, identity.runnerId));
      return { capability: token, walId, acknowledgedCursor: wal.acknowledgedCursor, producedCursor: wal.producedCursor,
        lastBatchId: wal.lastBatchId ?? "", lastBatchDigest: wal.lastBatchDigest ?? "" };
    });
  }

  async ingest(poolId: string, token: string | undefined, supplied: TelemetryProgressInput, bodyDigest: string,
    events: readonly { runnerId: string }[], persist: (tx: TelemetryTransaction) => Promise<void>) {
    const progress = telemetryProgressInput.parse(supplied);
    if (!token || !/^[0-9a-f]{64}$/.test(token)) throw unavailable();
    return this.db.transaction(async tx => {
      const [capability] = await tx.select({ sessionId: runnerControlSessions.id, runnerId: runnerControlSessions.runnerId,
        bootId: runnerControlSessions.bootId, poolId: runnerControlSessions.poolId, walId: runnerTelemetryCapabilities.walId })
        .from(runnerTelemetryCapabilities).innerJoin(runnerControlSessions, eq(runnerControlSessions.id, runnerTelemetryCapabilities.controlSessionId))
        .where(and(eq(runnerTelemetryCapabilities.capabilityHash, digest(token)), eq(runnerControlSessions.poolId, poolId))).limit(1);
      if (!capability || capability.walId !== progress.walId || !await current(tx, capability, true) ||
          events.some(event => event.runnerId !== capability.runnerId)) throw unavailable();
      const [wal] = await tx.select().from(runnerTelemetryWals).where(and(eq(runnerTelemetryWals.runnerId, capability.runnerId),
        eq(runnerTelemetryWals.walId, progress.walId), eq(runnerTelemetryWals.poolId, poolId))).for("update");
      if (!wal) throw unavailable();
      const reply = (acknowledgedCursor: number, producedCursor: number, lastBatchId = wal.lastBatchId ?? "", lastBatchDigest = wal.lastBatchDigest ?? "") =>
        ({ walId: wal.walId, acknowledgedCursor, producedCursor, lastBatchId, lastBatchDigest });
      if (events.length && wal.lastBatchId === progress.batchId) {
        if (wal.lastBatchDigest !== bodyDigest || wal.lastBatchFirst !== progress.firstCursor || wal.lastBatchLast !== progress.lastCursor) throw discontinuity();
        return reply(wal.acknowledgedCursor, wal.producedCursor);
      }
      if (progress.producedCursor < wal.producedCursor || progress.producedCursor < progress.lastCursor) throw discontinuity();
      if (!events.length) {
        if (progress.firstCursor !== wal.acknowledgedCursor || progress.lastCursor !== wal.acknowledgedCursor ||
            progress.producedCursor !== wal.acknowledgedCursor) throw discontinuity();
        await tx.update(runnerTelemetryWals).set({ producedCursor: progress.producedCursor, receivedAt: sql`clock_timestamp()`,
          caughtUpAt: sql`clock_timestamp()` }).where(eq(runnerTelemetryWals.runnerId, wal.runnerId));
        return reply(wal.acknowledgedCursor, progress.producedCursor);
      }
      if (progress.firstCursor !== wal.acknowledgedCursor + 1 || progress.lastCursor !== progress.firstCursor + events.length - 1) throw discontinuity();
      // One transaction owns every event disposition and the contiguous ACK.
      await persist(tx);
      await tx.update(runnerTelemetryWals).set({ acknowledgedCursor: progress.lastCursor, producedCursor: progress.producedCursor,
        lastBatchId: progress.batchId, lastBatchDigest: bodyDigest, lastBatchFirst: progress.firstCursor,
        lastBatchLast: progress.lastCursor, receivedAt: sql`clock_timestamp()`, caughtUpAt: null })
        .where(eq(runnerTelemetryWals.runnerId, wal.runnerId));
      return reply(progress.lastCursor, progress.producedCursor, progress.batchId, bodyDigest);
    });
  }
}

async function current(tx: TelemetryTransaction, identity: ControlSessionIdentity, lockRunner = false) {
  const query = tx.select({ id: runnerInstances.runnerId }).from(runnerInstances)
    .innerJoin(runnerControlSessions, eq(runnerControlSessions.id, runnerInstances.controlSessionId))
    .where(and(eq(runnerInstances.runnerId, identity.runnerId), eq(runnerInstances.bootId, identity.bootId),
      eq(runnerInstances.poolId, identity.poolId), eq(runnerInstances.controlSessionId, identity.sessionId),
      eq(runnerControlSessions.runnerId, identity.runnerId), eq(runnerControlSessions.bootId, identity.bootId),
      eq(runnerControlSessions.poolId, identity.poolId), isNull(runnerControlSessions.disconnectedAt),
      isNull(runnerInstances.disconnectedAt), ne(runnerInstances.status, "offline"))).limit(1);
  // Registration/disconnection/stale-offline changes atomically update this
  // Runner row. Lock only it: registrars write session then Runner, whereas
  // disconnectors write Runner then session; locking both could invert order.
  const [row] = await (lockRunner ? query.for("share", { of: runnerInstances }) : query);
  return Boolean(row);
}

function unavailable() { return new ControllerError("Runner telemetry session authentication failed.", 401, "telemetry_session_unauthenticated"); }
function discontinuity() { return new ConflictError("Telemetry cursor or batch identity is not contiguous; retained state requires reconciliation.", "telemetry_progress_conflict"); }
