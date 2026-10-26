import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull, lte, ne } from "drizzle-orm";
import type { ControllerDatabase } from "../db/client.js";
import { artifacts, auditEvents, controllerState, guardrails, guardrailVersions, outboxEvents, runnerInstances, runnerPools, user } from "../db/schema.js";
import { increment } from "../db/postgres-expressions.js";
import { ConflictError, NotFoundError } from "../domain/errors.js";
import { PROTECTION_MODE_CAPABILITY, type ProtectionMode, type ProtectionModeSettings } from "../../shared/protection-mode.js";

type Guardrail = typeof guardrails.$inferSelect;
type Runner = typeof runnerInstances.$inferSelect;

export async function hasReleasedGuardrail(db: Pick<ControllerDatabase, "select">, id: string): Promise<boolean> {
  const versions = await db.select({ id: guardrailVersions.artifactId }).from(guardrailVersions)
    .innerJoin(artifacts, and(eq(artifacts.id, guardrailVersions.artifactId), eq(artifacts.guardrailId, guardrailVersions.guardrailId), eq(artifacts.guardrailVersion, guardrailVersions.version)))
    .where(and(eq(guardrailVersions.guardrailId, id), eq(guardrailVersions.status, "ready"))).limit(1);
  return versions.length > 0;
}

/** Keep last fully applied mode visible while explicitly exposing mixed replicas. */
export function protectionModeSnapshot(row: Guardrail, runners: Runner[], ready: boolean, cutoff: number): ProtectionModeSettings {
  const generation = row.protectionModeGeneration ?? 0;
  const states = runners.map(r => {
    const supported = r.labels?.[PROTECTION_MODE_CAPABILITY] === "1";
    const offline = r.status === "offline" || r.lastHeartbeatAt.getTime() < cutoff;
    const modeApplied = supported && !offline && r.protectionGeneration >= generation;
    const status = offline ? "offline" : !supported ? "unsupported" : modeApplied ? "applied"
      : r.protectionError && r.protectionRejectedGeneration >= generation ? "failed" : "pending";
    return { runnerId: r.runnerId, modeApplied, status, reason: status === "failed" ? r.protectionError : null } as const;
  });
  const applied = states.filter(r => r.modeApplied).length;
  const failed = states.some(r => r.status === "failed" || r.status === "unsupported");
  return { guardrailId: row.id, mode: row.protectionMode ?? "enforce", appliedMode: row.protectionModeApplied ?? "enforce",
    generation, ready, applied, total: states.length, runners: states,
    status: !states.length ? "waiting" : applied === states.length ? "applied" : applied ? "partial" : failed ? "failed" : "applying",
    updatedAt: row.protectionModeUpdatedAt?.toISOString() ?? null,
    updatedBy: row.protectionModeUpdatedBy ?? null, reason: row.protectionModeReason ?? "" };
}

export class ProtectionModeService {
  constructor(private readonly db: ControllerDatabase, private readonly offlineAfterSeconds: number) {}

  private async runners(db: Pick<ControllerDatabase, "select"> = this.db) {
    return (await db.select({ runner: runnerInstances }).from(runnerInstances)
      .innerJoin(runnerPools, eq(runnerPools.id, runnerInstances.poolId))).map(r => r.runner);
  }

  async summary(row: Guardrail, ready: boolean) {
    const snapshot = protectionModeSnapshot(row, await this.runners(), ready, Date.now() - this.offlineAfterSeconds * 1000);
    const [actor] = row.protectionModeUpdatedBy ? await this.db.select({ name: user.name }).from(user).where(eq(user.id, row.protectionModeUpdatedBy)) : [];
    return { ...snapshot, updatedBy: actor?.name ?? snapshot.updatedBy };
  }

  async get(id: string) {
    const [row] = await this.db.select().from(guardrails).where(and(eq(guardrails.id, id), isNull(guardrails.deletedAt)));
    if (!row) throw new NotFoundError("Guardrail", id);
    return this.summary(row, row.status !== "disabled" && await hasReleasedGuardrail(this.db, id));
  }

  async update(input: { id: string; mode: ProtectionMode; expectedGeneration: number; reason: string; actorId: string }) {
    await this.db.transaction(async tx => {
      const [row] = await tx.select().from(guardrails).where(and(eq(guardrails.id, input.id), isNull(guardrails.deletedAt))).for("update");
      if (!row) throw new NotFoundError("Guardrail", input.id);
      if (row.protectionModeGeneration !== input.expectedGeneration) {
        throw new ConflictError("The protection mode changed. Reload before applying another change.", "protection_mode_conflict");
      }
      if (row.status === "disabled" || !await hasReleasedGuardrail(tx, row.id)) {
        throw new ConflictError("Publish a Guardrail version before changing its protection mode.", "guardrail_not_ready");
      }
      const now = new Date();
      const [state] = await tx.update(controllerState).set({ desiredGeneration: increment(controllerState.desiredGeneration), updatedAt: now })
        .where(eq(controllerState.id, "singleton")).returning();
      if (!state) throw new Error("Controller state is not initialized.");
      await tx.update(guardrails).set({ protectionMode: input.mode, protectionModeGeneration: state.desiredGeneration,
        protectionModeUpdatedAt: now, protectionModeUpdatedBy: input.actorId, protectionModeReason: input.reason,
        desiredGeneration: state.desiredGeneration, updatedAt: now }).where(eq(guardrails.id, row.id));
      await tx.insert(outboxEvents).values({ id: randomUUID(), kind: "runner.desired_state_changed", aggregateId: row.id,
        payload: { guardrailId: row.id, protectionMode: input.mode, generation: state.desiredGeneration } });
      await tx.insert(auditEvents).values({ id: randomUUID(), kind: "guardrail.protection_mode_changed", actorId: input.actorId,
        resourceType: "guardrail", resourceId: row.id,
        detail: { previousMode: row.protectionMode, mode: input.mode, reason: input.reason, generation: state.desiredGeneration } });
    });
    return this.get(input.id);
  }

  async desiredState() {
    return this.db.transaction(async tx => {
      // Lock the generation first so its map is a coherent snapshot of commits.
      const [state] = await tx.select({ generation: controllerState.desiredGeneration }).from(controllerState)
        .where(eq(controllerState.id, "singleton")).for("share");
      const rows = await tx.select({ id: guardrails.id, mode: guardrails.protectionMode }).from(guardrails)
        .where(and(isNull(guardrails.deletedAt), eq(guardrails.status, "active")));
      return { generation: state?.generation ?? 0, modes: Object.fromEntries(rows.map(r => [r.id, r.mode])) };
    });
  }

  async recordResult(input: { runnerId: string; bootId: string; generation: number; accepted: boolean; reason?: string }) {
    await this.db.transaction(async tx => {
      const [state] = await tx.select({ generation: controllerState.desiredGeneration }).from(controllerState).where(eq(controllerState.id, "singleton"));
      if (!state || input.generation > state.generation) return;
      const [runner] = await tx.update(runnerInstances).set(input.accepted
        ? { protectionGeneration: input.generation, protectionError: null, protectionRejectedGeneration: 0 }
        : { protectionError: input.reason || "Runner rejected the protection mode.", protectionRejectedGeneration: input.generation })
        .where(and(eq(runnerInstances.runnerId, input.runnerId), eq(runnerInstances.bootId, input.bootId),
          lte(runnerInstances.protectionGeneration, input.generation), lte(runnerInstances.protectionRejectedGeneration, input.generation)))
        .returning();
      if (!runner || !input.accepted) return;
      const rows = await tx.select().from(guardrails).where(and(isNull(guardrails.deletedAt), gt(guardrails.protectionModeGeneration, 0),
        ne(guardrails.protectionModeApplied, guardrails.protectionMode)));
      const runners = await this.runners(tx);
      for (const row of rows) {
        if (protectionModeSnapshot(row, runners, true, Date.now() - this.offlineAfterSeconds * 1000).status !== "applied") continue;
        await tx.update(guardrails).set({ protectionModeApplied: row.protectionMode })
          .where(and(eq(guardrails.id, row.id), eq(guardrails.protectionModeGeneration, row.protectionModeGeneration)));
      }
    });
  }
}
