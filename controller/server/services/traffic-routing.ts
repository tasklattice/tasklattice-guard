import { routerRolloutState } from "../../shared/router-lifecycle.js";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lte, lt, sql } from "drizzle-orm";
import type { ControllerDatabase } from "../db/client.js";
import { auditEvents, controllerState, endpoints, guardrails, guardrailVersions, routeAssignments, runnerInstances, telemetryWatermarks, trafficRouters, trafficRouterRevisions, type RouterRevisionContext } from "../db/schema.js";
import { ConflictError, NotFoundError, ValidationError } from "../domain/errors.js";
import { capabilityIssues, routingIssues, type RouterDraft } from "../../shared/traffic-routing.js";
import { advisoryTransactionLock } from "../db/postgres-locks.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

export const routingEventSchema = z.object({
  id: z.string().min(1).max(300), eventType: z.enum(["route_assignment", "completion"]),
  decisionId: z.string().min(1).max(256), callId: z.string().min(1).max(256), runnerId: z.string().min(1).max(256),
  poolId: z.string().max(128).optional(), endpointId: z.string().min(1).max(256),
  routerId: z.string().max(256).default(""), routerRevision: z.number().int().nonnegative().default(0),
  routeId: z.string().max(256).default(""), targetId: z.string().max(256).default(""),
  guardrailId: z.string().max(256).default(""), guardrailVersion: z.string().max(256).default(""),
  occurredAt: z.coerce.date(), decisionAt: z.coerce.date(), assignmentStatus: z.enum(["assigned", "unassigned"]),
  failureReason: z.string().max(1000).optional(), outcome: z.enum(["allow", "block", "transform", "intervene", "error", "timeout"]).optional(),
  durationMs: z.number().int().nonnegative().max(2147483647).optional(),
}).superRefine((event, context) => {
  if (event.assignmentStatus === "assigned" && (!event.routerId || !event.routerRevision || !event.routeId || !event.targetId || !event.guardrailId || !event.guardrailVersion)) context.addIssue({ code: "custom", message: "Assigned events require complete routing identity" });
  if (event.eventType === "completion" && !event.outcome) context.addIssue({ code: "custom", message: "Completion requires an outcome" });
});
export type RoutingEvent = z.infer<typeof routingEventSchema>;

const endpointContext = (rows: Array<{ id: string; name: string; adapter: string }>) =>
  rows.map(({ id, name, adapter }) => ({ id, name, adapter })).sort((a, b) => a.id.localeCompare(b.id));

type Tx = Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0];
export class TrafficRoutingService {
  constructor(private db: ControllerDatabase) {}
  async list() {
    const [rows, bindings, runners] = await Promise.all([
      this.db.select().from(trafficRouters).where(isNull(trafficRouters.deletedAt)).orderBy(asc(trafficRouters.name)),
      this.db.select({ id: endpoints.id, routerId: endpoints.trafficRouterId }).from(endpoints).where(isNull(endpoints.deletedAt)),
      this.db.select().from(runnerInstances).where(eq(runnerInstances.poolId, "default")),
    ]);
    return rows.map(r => ({ ...r, endpointIds: bindings.filter(e => e.routerId === r.id).map(e => e.id),
      rolloutStatus: routerRolloutState(r, runners),
    }));
  }
  async get(id: string) {
    const found = (await this.list()).find(r => r.id === id);
    if (!found) throw new NotFoundError("Router", id);
    return found;
  }
  async create(name: string, description: string, draft: RouterDraft, actorId: string, endpointIds: string[] = []) {
    const errors = routingIssues(draft);
    if (errors.length) throw new ValidationError(errors.join("; "));
    const id = randomUUID();
    await this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, "traffic-router-bindings");
      const requested = [...new Set(endpointIds)];
      const available = await tx.select().from(endpoints).where(isNull(endpoints.deletedAt));
      const selected = available.filter(endpoint => requested.includes(endpoint.id));
      if (selected.length !== requested.length) throw new ValidationError("Endpoint was not found.");
      for (const endpoint of selected) {
        if (endpoint.trafficRouterId) throw new ConflictError(`${endpoint.name} is already bound to another Router.`, "endpoint_router_conflict");
      }
      const issues = capabilityIssues(draft, selected);
      if (selected.length && issues.length) throw new ValidationError(issues.join("; "));
      await tx.insert(trafficRouters).values({ id, name, description, draft });
      for (const endpoint of selected) {
        await tx.update(endpoints).set({ trafficRouterId: id, updatedAt: new Date() }).where(eq(endpoints.id, endpoint.id));
      }
      await this.audit(tx, id, actorId, "router.created", { name, endpointIds: requested, endpoints: endpointContext(selected) });
    });
    return this.get(id);
  }
  async save(id: string, expectedDraftRevision: number, draft: RouterDraft, actorId: string) {
    const errors = routingIssues(draft);
    if (errors.length) throw new ValidationError(errors.join("; "));
    await this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, "traffic-router-bindings");
      const rows = await tx.update(trafficRouters).set({ draft, draftRevision: expectedDraftRevision + 1, updatedAt: new Date() })
        .where(and(eq(trafficRouters.id, id), eq(trafficRouters.draftRevision, expectedDraftRevision), isNull(trafficRouters.deletedAt))).returning();
      if (!rows.length) throw new ConflictError("Router draft changed. Reload and compare your changes.", "router_draft_conflict");
      await this.audit(tx, id, actorId, "router.draft_saved", { previousDraftRevision: expectedDraftRevision, draft });
    });
    return this.get(id);
  }
  private async resolvePublication(tx: Tx, id: string, draft: RouterDraft) {
    const initialErrors = routingIssues(draft, true);
    if (initialErrors.length) throw new ValidationError(initialErrors.join("; "));
    const bound = await tx.select().from(endpoints).where(and(eq(endpoints.trafficRouterId, id), isNull(endpoints.deletedAt)));
    const ids = [...new Set(draft.routes.flatMap(r => r.targets.map(t => t.guardrailId)))];
    const versions = ids.length ? await tx.select({ id: guardrailVersions.guardrailId, version: guardrailVersions.version,
      artifactId: guardrailVersions.artifactId, status: guardrailVersions.status, name: guardrails.name, deletedAt: guardrails.deletedAt })
      .from(guardrailVersions).innerJoin(guardrails, eq(guardrails.id, guardrailVersions.guardrailId))
      .where(inArray(guardrailVersions.guardrailId, ids))
      .orderBy(desc(guardrailVersions.generation), asc(guardrailVersions.version)) : [];
    const snapshot: RouterDraft = { routes: draft.routes.map(route => ({ ...route, targets: route.targets.map(target => {
      const { versionStrategy, ...pinned } = target;
      if (versionStrategy === "latest") {
        // Generation is globally unique and monotonic; version labels are opaque strings.
        const latest = versions.find(v => v.id === target.guardrailId && !v.deletedAt && v.status === "ready" && v.artifactId);
        if (!latest) throw new ValidationError(`${route.name}: ${target.guardrailId} has no ready Guardrail Version`);
        pinned.guardrailVersion = latest.version;
      }
      return pinned;
    }) })) };
    const errors = [...routingIssues(snapshot, true), ...capabilityIssues(snapshot, bound)];
    if (errors.length) throw new ValidationError(errors.join("; "));
    const context: RouterRevisionContext = { endpoints: endpointContext(bound), guardrails: [] };
    const captured = new Set<string>();
    for (const route of snapshot.routes) for (const target of route.targets) {
      const version = versions.find(v => v.id === target.guardrailId && v.version === target.guardrailVersion);
      if (route.enabled && target.weightBps > 0 && (!version?.artifactId || version.status !== "ready" || version.deletedAt)) {
        throw new ValidationError(`${route.name}: ${target.guardrailId} ${target.guardrailVersion} is not a ready Guardrail Version`);
      }
      // Missing inactive references remain in snapshot, without invented metadata.
      const key = JSON.stringify([target.guardrailId, target.guardrailVersion]);
      if (version && !captured.has(key)) {
        context.guardrails.push({ id: target.guardrailId, name: version.name, version: target.guardrailVersion });
        captured.add(key);
      }
    }
    return { snapshot, context, endpointIds: context.endpoints.map(e => e.id) };
  }
  async preview(id: string, expectedDraftRevision: number) {
    return this.db.transaction(async tx => {
      const [router] = await tx.select().from(trafficRouters).where(and(eq(trafficRouters.id, id), isNull(trafficRouters.deletedAt)));
      if (!router) throw new NotFoundError("Router", id);
      if (router.draftRevision !== expectedDraftRevision) throw new ConflictError("Router draft changed; reload before reviewing.", "router_draft_conflict");
      const { snapshot, endpointIds } = await this.resolvePublication(tx, id, router.draft);
      return { draftRevision: router.draftRevision, snapshot, endpointIds };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }
  async publish(id: string, expectedDraftRevision: number, idempotencyKey: string, actorId: string, rollbackRevision?: number, reviewedSnapshot?: RouterDraft, reviewedEndpointIds?: string[]) {
    const requestDigest = createHash("sha256").update(canonical({ actorId, expectedDraftRevision, rollbackRevision: rollbackRevision ?? null, reviewedSnapshot: reviewedSnapshot ?? null, reviewedEndpointIds: reviewedEndpointIds ? [...new Set(reviewedEndpointIds)].sort() : null })).digest("hex");
    const publication = await this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, "traffic-router-bindings");
      const [router] = await tx.select().from(trafficRouters).where(eq(trafficRouters.id, id)).for("update");
      if (!router || router.deletedAt) throw new NotFoundError("Router", id);
      const [prior] = await tx.select().from(trafficRouterRevisions).where(and(eq(trafficRouterRevisions.routerId, id), eq(trafficRouterRevisions.idempotencyKey, idempotencyKey)));
      if (prior) {
        if (prior.requestDigest !== requestDigest) throw new ConflictError("Idempotency key belongs to another publish request.", "router_publish_key_conflict");
        return { revision: prior.revision, generation: prior.generation, replayed: true };
      }
      const [deletedPublication] = await tx.select({ id: auditEvents.id }).from(auditEvents).where(and(eq(auditEvents.resourceId, id), eq(auditEvents.kind, "router.revision_deleted"), sql`${auditEvents.detail}->>'idempotencyKey' = ${idempotencyKey}`)).limit(1);
      if (deletedPublication) throw new ConflictError("The revision created by this publication was deleted. Use a new publication key.", "router_revision_deleted");
      if (router.draftRevision !== expectedDraftRevision) throw new ConflictError("Router draft changed; reload before publishing.", "router_draft_conflict");
      let draft = router.draft;
      if (rollbackRevision !== undefined) {
        const [revision] = await tx.select().from(trafficRouterRevisions).where(and(eq(trafficRouterRevisions.routerId, id), eq(trafficRouterRevisions.revision, rollbackRevision)));
        if (!revision) throw new NotFoundError("Router revision", String(rollbackRevision));
        draft = revision.snapshot;
      }
      if ((reviewedSnapshot === undefined) !== (reviewedEndpointIds === undefined)) throw new ValidationError("Provide both reviewedSnapshot and reviewedEndpointIds.");
      const resolved = await this.resolvePublication(tx, id, draft).catch(error => {
        if (reviewedSnapshot !== undefined && error instanceof ValidationError) {
          throw new ConflictError("Router publication is no longer valid. Review again before publishing.", "router_review_conflict");
        }
        throw error;
      });
      const { snapshot, context, endpointIds } = resolved;
      if (reviewedSnapshot !== undefined && (!isDeepStrictEqual(snapshot, reviewedSnapshot) ||
        !isDeepStrictEqual(endpointIds, [...new Set(reviewedEndpointIds!)].sort((a, b) => a.localeCompare(b))))) {
        throw new ConflictError("Router publication changed since review. Review again before publishing.", "router_review_conflict");
      }
      const revision = (router.activeRevision ?? 0) + 1;
      const sourceDraftRevision = rollbackRevision === undefined ? router.draftRevision : router.draftRevision + 1;
      const generation = await this.advance(tx);
      await tx.insert(trafficRouterRevisions).values({ routerId: id, revision, sourceDraftRevision, snapshot, context, idempotencyKey, requestDigest, generation, requestDraftRevision: expectedDraftRevision, rollbackRevision: rollbackRevision ?? null, createdBy: actorId });
      await tx.update(trafficRouters).set({ draft: rollbackRevision === undefined ? router.draft : snapshot, draftRevision: sourceDraftRevision, activeDraftRevision: sourceDraftRevision, activeRevision: revision, activeSnapshot: snapshot, rolloutError: null, desiredGeneration: generation, updatedAt: new Date() }).where(eq(trafficRouters.id, id));
      await this.audit(tx, id, actorId, rollbackRevision ? "router.rolled_back" : "router.published", { revision, previous: router.activeSnapshot, snapshot, endpointIds });
      return { revision, generation, replayed: false };
    });
    return { ...await this.get(id), publication: { ...publication, revisionUrl: `/api/v1/routers/${encodeURIComponent(id)}/revisions/${publication.revision}`, statusUrl: `/api/v1/routers/${encodeURIComponent(id)}` } };
  }
  async revisions(id: string) {
    await this.get(id);
    return this.db.select().from(trafficRouterRevisions).where(eq(trafficRouterRevisions.routerId, id)).orderBy(desc(trafficRouterRevisions.revision));
  }
  async deleteRevision(id: string, revision: number, actorId: string) {
    await this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, "traffic-router-bindings");
      const [router] = await tx.select().from(trafficRouters).where(eq(trafficRouters.id, id)).for("update");
      if (!router || router.deletedAt) throw new NotFoundError("Router", id);
      const [record] = await tx.select().from(trafficRouterRevisions).where(and(eq(trafficRouterRevisions.routerId, id), eq(trafficRouterRevisions.revision, revision)));
      if (!record) throw new NotFoundError("Router revision", String(revision));
      if (router.activeRevision === revision) throw new ConflictError("The current Router revision cannot be deleted. Publish another revision first.", "revision_in_use");
      const runners = await tx.select().from(runnerInstances).where(eq(runnerInstances.poolId, "default"));
      if (routerRolloutState(router, runners) !== "active" || Date.now() - router.updatedAt.getTime() < 300000) throw new ConflictError("Wait for Runner convergence and the five-minute call retention window before deleting historical revisions.", "revision_in_use");
      const [pending] = await tx.select().from(routeAssignments).where(and(eq(routeAssignments.routerId, id), eq(routeAssignments.routerRevision, revision), isNull(routeAssignments.completedAt), gte(routeAssignments.occurredAt, new Date(Date.now() - 300000)))).limit(1);
      if (pending) throw new ConflictError("This revision still has in-flight calls.", "revision_in_use");
      await this.audit(tx, id, actorId, "router.revision_deleted", { revision, snapshot: record.snapshot, context: record.context, idempotencyKey: record.idempotencyKey });
      await tx.delete(trafficRouterRevisions).where(and(eq(trafficRouterRevisions.routerId, id), eq(trafficRouterRevisions.revision, revision)));
    });
  }
  async bind(id: string, endpointIds: string[], actorId: string) {
    const changed = await this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, "traffic-router-bindings");
      const [router] = await tx.select().from(trafficRouters).where(eq(trafficRouters.id, id)).for("update");
      if (!router || router.deletedAt) throw new NotFoundError("Router", id);
      const all = await tx.select().from(endpoints).where(isNull(endpoints.deletedAt));
      const requested = [...new Set(endpointIds)];
      const selected = all.filter(e => requested.includes(e.id));
      if (selected.length !== requested.length) throw new ValidationError("Endpoint was not found.");
      if (isDeepStrictEqual(all.filter(e => e.trafficRouterId === id).map(e => e.id).sort(), [...requested].sort())) return false;
      const errors = capabilityIssues(router.activeSnapshot ?? router.draft, selected);
      if (errors.length) throw new ValidationError(errors.join("; "));
      for (const endpoint of all) {
        if (requested.includes(endpoint.id)) {
          if (endpoint.trafficRouterId && endpoint.trafficRouterId !== id) throw new ConflictError(`${endpoint.name} is already bound to another Router. Unbind it there first.`, "endpoint_router_conflict");
          await tx.update(endpoints).set({ trafficRouterId: id, updatedAt: new Date() }).where(eq(endpoints.id, endpoint.id));
        } else if (endpoint.trafficRouterId === id) await tx.update(endpoints).set({ trafficRouterId: null, updatedAt: new Date() }).where(eq(endpoints.id, endpoint.id));
      }
      const generation = await this.advance(tx);
      await tx.update(trafficRouters).set({ desiredGeneration: generation, rolloutError: null }).where(eq(trafficRouters.id, id));
      await this.audit(tx, id, actorId, "router.source_endpoints_changed", {
        endpointIds: requested, routerRevision: router.activeRevision, generation,
        previousEndpoints: endpointContext(all.filter(e => e.trafficRouterId === id)), endpoints: endpointContext(selected),
      });
      return true;
    });
    return { ...await this.get(id), changed };
  }
  async distribution(id: string, hours: number, revision?: number, endpointId?: string) {
    await this.get(id);
    const until = new Date(), since = new Date(until.getTime() - hours * 3600000);
    const rows = await this.db.select({
      routeId: routeAssignments.routeId, targetId: routeAssignments.targetId, routerRevision: routeAssignments.routerRevision,
      guardrailId: routeAssignments.guardrailId, guardrailVersion: routeAssignments.guardrailVersion,
      assignmentStatus: routeAssignments.assignmentStatus,
      count: sql<number>`count(*)::int`, errors: sql<number>`count(*) filter (where ${routeAssignments.outcome} IN ('error','timeout'))::int`,
      inferredCompletions: sql<number>`count(*) filter (where ${routeAssignments.completionInferred})::int`,
      completed: sql<number>`count(${routeAssignments.completedAt})::int`, blocked: sql<number>`count(*) filter (where ${routeAssignments.outcome} = 'block')::int`,
      transformed: sql<number>`count(*) filter (where ${routeAssignments.outcome} = 'transform')::int`, intervened: sql<number>`count(*) filter (where ${routeAssignments.outcome} = 'intervene')::int`,
      allowed: sql<number>`count(*) filter (where ${routeAssignments.outcome} = 'allow')::int`,
      p95Ms: sql<number | null>`percentile_cont(0.95) within group (order by ${routeAssignments.durationMs})`,
    }).from(routeAssignments).where(and(eq(routeAssignments.routerId, id), gte(routeAssignments.occurredAt, since), lte(routeAssignments.occurredAt, until), revision ? eq(routeAssignments.routerRevision, revision) : undefined, endpointId ? eq(routeAssignments.endpointId, endpointId) : undefined))
      .groupBy(routeAssignments.routeId, routeAssignments.targetId, routeAssignments.routerRevision, routeAssignments.guardrailId, routeAssignments.guardrailVersion, routeAssignments.assignmentStatus);
    const watermarks = await this.db.select({ at: telemetryWatermarks.lastReceivedAt, heartbeat: runnerInstances.lastHeartbeatAt }).from(runnerInstances)
      .leftJoin(telemetryWatermarks, eq(telemetryWatermarks.runnerId, runnerInstances.runnerId)).where(eq(runnerInstances.poolId, "default"));
    const telemetryFresh = watermarks.length > 0 && watermarks.every(r => r.at && until.getTime() - r.at.getTime() < 60000 && until.getTime() - r.heartbeat.getTime() < 60000);
    const dates = watermarks.flatMap(r => r.at ? [r.at.getTime()] : []);
    const total = rows.reduce((n, r) => n + r.count, 0), unassigned = rows.filter(r => r.assignmentStatus === "unassigned").reduce((n, r) => n + r.count, 0);
    const revisions = await this.revisions(id);
    const trend = await this.db.select({ at: sql<string>`date_bin(interval '15 minutes', ${routeAssignments.occurredAt}, timestamptz '2000-01-01')::text`, routeId: routeAssignments.routeId, count: sql<number>`count(*)::int` }).from(routeAssignments)
      .where(and(eq(routeAssignments.routerId, id), gte(routeAssignments.occurredAt, since), lte(routeAssignments.occurredAt, until), revision ? eq(routeAssignments.routerRevision, revision) : undefined, endpointId ? eq(routeAssignments.endpointId, endpointId) : undefined))
      .groupBy(sql`date_bin(interval '15 minutes', ${routeAssignments.occurredAt}, timestamptz '2000-01-01')`, routeAssignments.routeId);
    return { since: since.toISOString(), until: until.toISOString(), rows, total, assigned: total - unassigned, unassigned, trend,
      revisions: revisions.map(r => ({ revision: r.revision, snapshot: r.snapshot, context: r.context })),
      telemetryFresh, completeness: telemetryFresh ? "current" : "delayed_or_unavailable", dataWatermark: dates.length ? new Date(Math.min(...dates)).toISOString() : null,
      unit: "logical_call", multipleRevisions: new Set(rows.map(r => r.routerRevision)).size > 1 };
  }
  async expireCalls() {
    await this.db.update(routeAssignments).set({ completionInferred: true, outcome: "timeout", completedAt: sql`${routeAssignments.occurredAt} + interval '300 seconds'`, durationMs: 300000 })
      .where(and(isNull(routeAssignments.completedAt), lt(routeAssignments.occurredAt, new Date(Date.now() - 300000))));
  }
  private lastRetentionAt = 0;
  async recordEvents(events: readonly RoutingEvent[]) {
    if (Date.now() - this.lastRetentionAt > 3600000) {
      await this.db.delete(routeAssignments).where(lt(routeAssignments.occurredAt, new Date(Date.now() - 30 * 86400000)));
      this.lastRetentionAt = Date.now();
    }
    await this.db.transaction(async tx => {
      for (const event of events) {
        if (event.decisionAt.getTime() < Date.now() - 30 * 86400000) continue;
        const complete = event.eventType === "completion";
        await tx.insert(routeAssignments).values({ decisionId: event.decisionId, callId: event.callId, routerId: event.routerId, routerRevision: event.routerRevision,
          routeId: event.routeId, targetId: event.targetId, guardrailId: event.guardrailId, guardrailVersion: event.guardrailVersion, endpointId: event.endpointId,
          assignmentStatus: event.assignmentStatus, failureReason: event.failureReason ?? null, occurredAt: event.decisionAt,
          completedAt: complete ? event.occurredAt : null, outcome: complete ? event.outcome! : null, durationMs: complete ? event.durationMs ?? null : null,
        }).onConflictDoUpdate({ target: routeAssignments.decisionId, set: {
          completionInferred: sql`CASE WHEN excluded.completed_at IS NOT NULL THEN false ELSE ${routeAssignments.completionInferred} END`,
          completedAt: sql`CASE WHEN ${routeAssignments.completionInferred} AND excluded.completed_at IS NOT NULL THEN excluded.completed_at ELSE coalesce(${routeAssignments.completedAt}, excluded.completed_at) END`,
          outcome: sql`CASE WHEN ${routeAssignments.completionInferred} AND excluded.completed_at IS NOT NULL THEN excluded.outcome WHEN ${routeAssignments.outcome} IN ('error','timeout') THEN ${routeAssignments.outcome}
            WHEN excluded.outcome IN ('error','timeout') THEN excluded.outcome
            WHEN ${routeAssignments.outcome} = 'block' OR excluded.outcome = 'block' THEN 'block'
            WHEN ${routeAssignments.outcome} = 'intervene' OR excluded.outcome = 'intervene' THEN 'intervene'
            WHEN ${routeAssignments.outcome} = 'transform' OR excluded.outcome = 'transform' THEN 'transform'
            ELSE coalesce(${routeAssignments.outcome}, excluded.outcome) END`,
          durationMs: sql`CASE WHEN ${routeAssignments.completionInferred} AND excluded.completed_at IS NOT NULL THEN excluded.duration_ms ELSE greatest(${routeAssignments.durationMs}, excluded.duration_ms) END`,
        }});
        await tx.insert(telemetryWatermarks).values({ runnerId: event.runnerId, lastEventOccurredAt: event.occurredAt, lastReceivedAt: new Date(), updatedAt: new Date() })
          .onConflictDoUpdate({ target: telemetryWatermarks.runnerId, set: { lastEventOccurredAt: event.occurredAt, lastReceivedAt: new Date(), updatedAt: new Date() } });
      }
    });
  }

  async runtimeSnapshots(tx: Tx | ControllerDatabase = this.db) {
    const rows = await tx.select().from(trafficRouters).where(isNull(trafficRouters.deletedAt));
    const bindings = await tx.select({ id: endpoints.id, routerId: endpoints.trafficRouterId }).from(endpoints).where(isNull(endpoints.deletedAt));
    const versions = await tx.select().from(guardrailVersions);
    return rows.filter(r => r.activeSnapshot).map(r => ({ routerId: r.id, revision: r.activeRevision!, endpointIds: bindings.filter(e => e.routerId === r.id).map(e => e.id), routes: r.activeSnapshot!.routes.map(route => ({ ...route, targets: route.targets.map(t => ({ ...t, artifactId: versions.find(v => v.guardrailId === t.guardrailId && v.version === t.guardrailVersion)?.artifactId ?? "" })) })) }));
  }
  async assertGuardrailUnused(id: string, tx: Tx | ControllerDatabase = this.db) {
    const rows = await tx.select().from(trafficRouters).where(isNull(trafficRouters.deletedAt));
    const recentRevisions = await tx.select().from(trafficRouterRevisions).where(gte(trafficRouterRevisions.createdAt, new Date(Date.now() - 300000)));
    const recentlyChanged = new Set(recentRevisions.map(r => r.routerId));
    if (recentlyChanged.size) {
      const history = await tx.select().from(trafficRouterRevisions);
      if (history.some(r => recentlyChanged.has(r.routerId) && r.snapshot.routes.some(route => route.targets.some(t => t.guardrailId === id)))) throw new ConflictError("Wait for the five-minute call retention window after changing routes before deleting this Guardrail.", "guardrail_in_use");
    }
    const refs = rows.filter(r => r.activeSnapshot?.routes.some(route => route.targets.some(t => t.guardrailId === id)));
    const [pending] = await tx.select({ count: sql<number>`count(*)::int` }).from(routeAssignments).where(and(eq(routeAssignments.guardrailId, id), isNull(routeAssignments.completedAt), gte(routeAssignments.occurredAt, new Date(Date.now() - 300000))));
    if (pending?.count) throw new ConflictError("Guardrail still has in-flight calls.", "guardrail_in_use");
    if (refs.length) throw new ConflictError(`Guardrail is referenced by published Routers: ${refs.map(r => r.name).join(", ")}`, "guardrail_in_use");
  }
  async reportRolloutFailure(generation: number, runnerId: string, reason: string) {
    await this.db.update(trafficRouters).set({ rolloutError: `${runnerId}: ${reason}` }).where(and(isNull(trafficRouters.deletedAt), lte(trafficRouters.desiredGeneration, generation), sql`${trafficRouters.activeRevision} IS NOT NULL`));
  }
  async remove(id: string, actorId: string) {
    await this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, "traffic-router-bindings");
      const [router] = await tx.select().from(trafficRouters).where(and(eq(trafficRouters.id, id), isNull(trafficRouters.deletedAt))).for("update");
      if (!router) throw new NotFoundError("Router", id);
      const bound = await tx.select({ id: endpoints.id }).from(endpoints).where(and(eq(endpoints.trafficRouterId, id), isNull(endpoints.deletedAt)));
      if (bound.length) throw new ConflictError("Unbind Endpoints before deleting this Router.", "router_in_use");
      const generation = await this.advance(tx);
      await tx.update(trafficRouters).set({ deletedAt: new Date(), desiredGeneration: generation }).where(eq(trafficRouters.id, id));
      await this.audit(tx, id, actorId, "router.deleted", { name: router.name });
    });
  }
  private async advance(tx: Tx) {
    const [row] = await tx.update(controllerState).set({ desiredGeneration: sql`${controllerState.desiredGeneration} + 1`, updatedAt: new Date() }).where(eq(controllerState.id, "singleton")).returning();
    if (!row) throw new Error("Controller state is not initialized");
    return row.desiredGeneration;
  }
  private async audit(tx: Tx, id: string, actorId: string, kind: string, detail: Record<string, unknown>) {
    await tx.insert(auditEvents).values({ id: randomUUID(), resourceType: "router", resourceId: id, actorId, kind, detail });
  }
}
