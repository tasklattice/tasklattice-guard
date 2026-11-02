import { guardrailTelemetryFilter } from "./guardrail-operational-data.js";
import { routerRolloutState } from "../../shared/router-lifecycle.js";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, getTableColumns, gte, inArray, isNull, lte, lt, ne, or, sql } from "drizzle-orm";
import type { ControllerDatabase } from "../db/client.js";
import { auditEvents, controllerState, endpoints, guardrails, guardrailVersions, resourceShares, routeAssignments, runnerInstances, runnerPools, telemetryWatermarks, tenants, trafficRouterChangeRequests, trafficRouters, trafficRouterRevisions, user, type RouterRevisionContext } from "../db/schema.js";
import { ConflictError, ControllerError, NotFoundError, ValidationError } from "../domain/errors.js";
import { capabilityIssues, routingIssues, type RouterChangeRequest, type RouterDraft, type SelectorExpression } from "../../shared/traffic-routing.js";
import { advisoryTransactionLock } from "../db/postgres-locks.js";
import { routingEventTenantId } from "./routing-telemetry-context.js";
import { lockEndpointTelemetryContextReaders } from "./endpoint-telemetry-contexts.js";
import {
  assertResourceWriteAccess,
  currentTenantId,
  resourceReadPredicate,
  resourceWritePredicate,
  tenantOwnerForCreate,
} from "./tenant-context.js";

/** How long a Runner load check of an imported version counts as current. */
export const IMPORTED_VERSION_CHECK_TTL_MS = 10 * 60_000;

const sortedIds = (ids: readonly string[]) => [...new Set(ids)].sort((a, b) => a.localeCompare(b));

type VisibleReferences = { endpoints: Set<string> | null; guardrails: Set<string> | null; restrictedEndpoints: Set<string> };

/** Tenant-facing views must not turn a Router share into a resource share. */
function endpointSelectorValues(expression: SelectorExpression): string[] {
  return expression.conditions.flatMap(condition => {
    if ("conditions" in condition) return endpointSelectorValues(condition);
    if (condition.field !== "endpoint.id" && condition.field !== "auth.principal") return [];
    return (Array.isArray(condition.value) ? condition.value : [condition.value]).filter(Boolean);
  });
}

function redactSelector(expression: SelectorExpression, restrictedEndpoints: Set<string>): SelectorExpression {
  return { ...expression, conditions: expression.conditions.map(condition => {
    if ("conditions" in condition) return redactSelector(condition, restrictedEndpoints);
    if (condition.field !== "endpoint.id" && condition.field !== "auth.principal") return condition;
    const redact = (value: string) => restrictedEndpoints.has(value) ? "[restricted]" : value;
    return { ...condition, value: Array.isArray(condition.value) ? condition.value.map(redact) : redact(condition.value) };
  }) };
}

function redactSnapshot(snapshot: RouterDraft, refs: VisibleReferences): RouterDraft {
  if (refs.guardrails === null || refs.endpoints === null) return snapshot;
  return { ...snapshot, routes: snapshot.routes.map(route => ({ ...route,
    selector: { ...route.selector, expression: redactSelector(route.selector.expression, refs.restrictedEndpoints) },
    targets: route.targets.filter(target => refs.guardrails!.has(target.guardrailId)),
  })) };
}

function redactContext(context: RouterRevisionContext | null, refs: VisibleReferences): RouterRevisionContext | null {
  if (!context) return context;
  return {
    endpoints: context.endpoints.filter(endpoint => refs.endpoints === null || refs.endpoints.has(endpoint.id)),
    guardrails: context.guardrails.filter(guardrail => refs.guardrails === null || refs.guardrails.has(guardrail.id)),
  };
}

export const routingEventSchema = z.object({
  id: z.string().min(1).max(300), eventType: z.enum(["route_assignment", "completion"]),
  decisionId: z.string().min(1).max(256), callId: z.string().min(1).max(256), runnerId: z.string().min(1).max(256),
  poolId: z.string().max(128).optional(), endpointId: z.string().min(1).max(256),
  allocationContextId: z.string().min(1).max(128).optional(),
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
  constructor(private db: ControllerDatabase, private readonly scopedTelemetry = false) {}
  async list() {
    const [rows, bindings, runners, changes] = await Promise.all([
      this.db.select().from(trafficRouters).where(and(
        isNull(trafficRouters.deletedAt), resourceReadPredicate("router", trafficRouters.id, trafficRouters.tenantId),
      )).orderBy(asc(trafficRouters.name)),
      this.db.select({ id: endpoints.id, routerId: endpoints.trafficRouterId }).from(endpoints).where(and(
        isNull(endpoints.deletedAt), resourceReadPredicate("endpoint", endpoints.id, endpoints.tenantId),
      )),
      this.db.select({ ...getTableColumns(runnerInstances), groupId: runnerPools.groupId }).from(runnerInstances)
        .innerJoin(runnerPools, eq(runnerPools.id, runnerInstances.poolId)),
      this.db.select({ change: trafficRouterChangeRequests }).from(trafficRouterChangeRequests)
        .innerJoin(trafficRouters, eq(trafficRouters.id, trafficRouterChangeRequests.routerId))
        .where(or(eq(trafficRouterChangeRequests.status, "pending"), and(eq(trafficRouterChangeRequests.status, "applied"),
          eq(trafficRouterChangeRequests.kind, "publish"), eq(trafficRouterChangeRequests.appliedRevision, trafficRouters.activeRevision))))
        .then(found => this.withNames(this.db, found.map(row => row.change))),
    ]);
    const owners = [...new Set(rows.map(row => row.tenantId))];
    const allocations = owners.length ? await this.db.select({ id: tenants.id, groupId: tenants.groupId })
      .from(tenants).where(inArray(tenants.id, owners)) : [];
    const refs = await this.visibleReferences(this.db, rows.flatMap(row => [row.draft, row.activeSnapshot]), [], []);
    return rows.map(r => {
      const groupId = allocations.find(tenant => tenant.id === r.tenantId)?.groupId;
      const revertible = changes.find(c => c.routerId === r.id && c.status === "applied" && c.baseRevision !== null);
      return { ...r, draft: redactSnapshot(r.draft, refs),
        activeSnapshot: r.activeSnapshot ? redactSnapshot(r.activeSnapshot, refs) : null,
        rolloutError: currentTenantId() && r.rolloutError ? "Runner reported a rollout error." : r.rolloutError,
        endpointIds: bindings.filter(e => e.routerId === r.id).map(e => e.id),
        rolloutStatus: routerRolloutState(r, groupId ? runners.filter(runner => runner.groupId === groupId) : []),
        pendingChangeRequest: changes.find(c => c.routerId === r.id && c.status === "pending") ?? null,
        revertibleChangeRequest: revertible ? { id: revertible.id, baseRevision: revertible.baseRevision!, appliedRevision: revertible.appliedRevision! } : null,
      };
    });
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
      await this.assertDraftGuardrailsVisible(tx, draft);
      const requested = [...new Set(endpointIds)];
      const available = await tx.select().from(endpoints).where(and(
        isNull(endpoints.deletedAt), resourceWritePredicate(endpoints.tenantId),
      ));
      const selected = available.filter(endpoint => requested.includes(endpoint.id));
      if (selected.length !== requested.length) throw new ValidationError("Endpoint was not found.");
      for (const endpoint of selected) {
        if (endpoint.trafficRouterId) throw new ConflictError(`${endpoint.name} is already bound to another Router.`, "endpoint_router_conflict");
      }
      const issues = capabilityIssues(draft, selected);
      if (selected.length && issues.length) throw new ValidationError(issues.join("; "));
      await tx.insert(trafficRouters).values({ id, tenantId: tenantOwnerForCreate(), name, description, draft });
      for (const endpoint of selected) {
        await tx.update(endpoints).set({ trafficRouterId: id, updatedAt: new Date() }).where(eq(endpoints.id, endpoint.id));
      }
      await this.audit(tx, id, actorId, "router.created", { name, endpointIds: requested, endpoints: endpointContext(selected) });
    });
    return this.get(id);
  }
  async save(id: string, expectedDraftRevision: number, draft: RouterDraft, actorId: string) {
    await assertResourceWriteAccess(this.db, "router", id);
    const errors = routingIssues(draft);
    if (errors.length) throw new ValidationError(errors.join("; "));
    await this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, "traffic-router-bindings");
      await this.assertDraftGuardrailsVisible(tx, draft);
      const rows = await tx.update(trafficRouters).set({ draft, draftRevision: expectedDraftRevision + 1, updatedAt: new Date() })
        .where(and(eq(trafficRouters.id, id), eq(trafficRouters.draftRevision, expectedDraftRevision), isNull(trafficRouters.deletedAt), resourceWritePredicate(trafficRouters.tenantId))).returning();
      if (!rows.length) throw new ConflictError("Router draft changed. Reload and compare your changes.", "router_draft_conflict");
      await this.audit(tx, id, actorId, "router.draft_saved", { previousDraftRevision: expectedDraftRevision, draft });
    });
    return this.get(id);
  }
  private async resolvePublication(tx: Tx, id: string, draft: RouterDraft, options: { verifyImports?: boolean } = {}) {
    const initialErrors = routingIssues(draft, true);
    if (initialErrors.length) throw new ValidationError(initialErrors.join("; "));
    // A readable Router does not transitively grant access to its targets.
    // Recheck even disabled/zero-weight targets before returning a preview.
    if (currentTenantId()) await this.assertDraftGuardrailsVisible(tx, draft);
    const bound = await tx.select().from(endpoints).where(and(
      eq(endpoints.trafficRouterId, id), isNull(endpoints.deletedAt), resourceWritePredicate(endpoints.tenantId),
    ));
    const ids = [...new Set(draft.routes.flatMap(r => r.targets.map(t => t.guardrailId)))];
    const versions = ids.length ? await tx.select({ id: guardrailVersions.guardrailId, version: guardrailVersions.version,
      artifactId: guardrailVersions.artifactId, status: guardrailVersions.status, name: guardrails.name, deletedAt: guardrails.deletedAt,
      origin: guardrailVersions.origin, environmentCheck: guardrailVersions.environmentCheck })
      .from(guardrailVersions).innerJoin(guardrails, eq(guardrails.id, guardrailVersions.guardrailId))
      .where(and(inArray(guardrailVersions.guardrailId, ids), resourceReadPredicate("guardrail", guardrails.id, guardrails.tenantId))) : [];
    // Targets already name immutable versions: the reviewed snapshot is the draft itself.
    const snapshot: RouterDraft = structuredClone(draft);
    const errors = [...routingIssues(snapshot, true), ...capabilityIssues(snapshot, bound)];
    if (errors.length) throw new ValidationError(errors.join("; "));
    const context: RouterRevisionContext = { endpoints: endpointContext(bound), guardrails: [] };
    const captured = new Set<string>();
    for (const route of snapshot.routes) for (const target of route.targets) {
      const version = versions.find(v => v.id === target.guardrailId && v.version === target.guardrailVersion);
      if (route.enabled && target.weightBps > 0 && version?.status === "pending") {
        // Same validation as "not ready", so a change that drifts here is superseded rather than applied.
        throw new ValidationError(`${route.name}: ${target.guardrailId} ${target.guardrailVersion} has not been released in this environment. Run its test suite and release it first`,
          { guardrailId: target.guardrailId, version: target.guardrailVersion, reason: "not_released" });
      }
      if (route.enabled && target.weightBps > 0 && (!version?.artifactId || version.status !== "ready" || version.deletedAt)) {
        throw new ValidationError(`${route.name}: ${target.guardrailId} ${target.guardrailVersion} is not a ready Guardrail Version`);
      }
      // An imported version was tested elsewhere. It may receive traffic only
      // after Runners here proved they can load it (see checkRoutedImports).
      if (options.verifyImports && route.enabled && target.weightBps > 0 && version?.origin === "imported") {
        const check = version.environmentCheck;
        const fresh = check && Date.now() - Date.parse(check.checkedAt) <= IMPORTED_VERSION_CHECK_TTL_MS;
        if (!fresh || check.status !== "compatible") {
          throw new ConflictError(
            `${route.name}: this environment has not confirmed it can serve ${target.guardrailId} ${target.guardrailVersion}. Resolve the missing dependencies and check again.`,
            "guardrail_version_environment_unverified",
            { guardrailId: target.guardrailId, version: target.guardrailVersion, environment: check ?? null },
          );
        }
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
    await assertResourceWriteAccess(this.db, "router", id);
    return this.db.transaction(async tx => {
      const [router] = await tx.select().from(trafficRouters).where(and(eq(trafficRouters.id, id), isNull(trafficRouters.deletedAt)));
      if (!router) throw new NotFoundError("Router", id);
      if (router.draftRevision !== expectedDraftRevision) throw new ConflictError("Router draft changed; reload before reviewing.", "router_draft_conflict");
      const { snapshot, endpointIds } = await this.resolvePublication(tx, id, router.draft);
      return { draftRevision: router.draftRevision, snapshot, endpointIds };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }
  async changeRequests(id: string) {
    await this.get(id);
    const rows = await this.db.select().from(trafficRouterChangeRequests).where(eq(trafficRouterChangeRequests.routerId, id)).orderBy(desc(trafficRouterChangeRequests.submittedAt));
    return this.withNames(this.db, rows);
  }
  async changeRequest(id: string, changeId: string) {
    const found = (await this.changeRequests(id)).find(change => change.id === changeId);
    if (!found) throw new NotFoundError("Router change request", changeId);
    return found;
  }
  /** Freeze the reviewed draft as a pending change. Nothing is published until approval. */
  async submitChange(id: string, input: { expectedDraftRevision: number; reviewedSnapshot: RouterDraft; reviewedEndpointIds: string[]; reason: string; ticket: string; restore?: { revision: number; expectedActiveRevision: number } | undefined }, actorId: string) {
    await assertResourceWriteAccess(this.db, "router", id);
    const changeId = randomUUID();
    await this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, "traffic-router-bindings");
      const router = await this.lockRouter(tx, id);
      if (router.draftRevision !== input.expectedDraftRevision) throw new ConflictError("Router draft changed; review again before submitting.", "router_draft_conflict");
      const [pending] = await tx.select({ id: trafficRouterChangeRequests.id }).from(trafficRouterChangeRequests)
        .where(and(eq(trafficRouterChangeRequests.routerId, id), eq(trafficRouterChangeRequests.status, "pending")));
      if (pending) throw new ConflictError("This Router already has a pending change request.", "router_change_request_pending", { changeRequestId: pending.id });
      let source = router.draft;
      if (input.restore) {
        if (router.activeRevision !== input.restore.expectedActiveRevision) throw new ConflictError("The active Router revision changed; review the restoration again.", "router_review_conflict");
        if (input.restore.revision === router.activeRevision) throw new ConflictError("This Router revision is already active.", "router_restore_unavailable");
        const [target] = await tx.select().from(trafficRouterRevisions).where(and(eq(trafficRouterRevisions.routerId, id), eq(trafficRouterRevisions.revision, input.restore.revision)));
        if (!target) throw new NotFoundError("Router revision", String(input.restore.revision));
        source = target.snapshot;
      }
      const { snapshot, context, endpointIds } = await this.resolvePublication(tx, id, source, { verifyImports: true }).catch(error => {
        if (error instanceof ValidationError) throw new ConflictError("Router publication is no longer valid. Review again before submitting.", "router_review_conflict");
        throw error;
      });
      if (!isDeepStrictEqual(snapshot, input.reviewedSnapshot) || !isDeepStrictEqual(endpointIds, sortedIds(input.reviewedEndpointIds))) {
        throw new ConflictError("Router publication changed since review. Review again before submitting.", "router_review_conflict");
      }
      // Persist the restored draft and its request atomically: a failed submission
      // must never replace an existing draft, and submission never publishes.
      const sourceDraftRevision = router.draftRevision + (input.restore ? 1 : 0);
      if (input.restore) await tx.update(trafficRouters).set({ draft: snapshot, draftRevision: sourceDraftRevision, updatedAt: new Date() }).where(eq(trafficRouters.id, id));
      await tx.insert(trafficRouterChangeRequests).values({ id: changeId, routerId: id, kind: "publish", status: "pending",
        sourceDraftRevision, baseRevision: router.activeRevision, snapshot, endpointIds, context,
        ticket: input.ticket, reason: input.reason, submittedBy: actorId });
      await this.audit(tx, id, actorId, "router.change_submitted", { changeRequestId: changeId, ticket: input.ticket, baseRevision: router.activeRevision, snapshot, endpointIds, ...(input.restore ? { restoredRevision: input.restore.revision } : {}) });
    });
    return this.changeRequest(id, changeId);
  }
  /** Apply a pending change. Approval requires a second administrator; emergency application requires a reason. */
  async approveChange(id: string, changeId: string, actorId: string, decision: { note?: string | undefined } | { emergency: { reason: string } }) {
    const emergency = "emergency" in decision ? decision.emergency : null;
    const outcome = await this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, "traffic-router-bindings");
      const router = await this.lockRouter(tx, id);
      const change = await this.lockChange(tx, id, changeId);
      if (change.status === "applied" && change.decidedBy === actorId && change.kind === "publish" && Boolean(change.emergencyReason) === Boolean(emergency)) {
        const [revision] = await tx.select().from(trafficRouterRevisions).where(and(eq(trafficRouterRevisions.routerId, id), eq(trafficRouterRevisions.revision, change.appliedRevision!)));
        return { revision: change.appliedRevision!, generation: revision?.generation ?? null, replayed: true };
      }
      if (change.status !== "pending") throw new ConflictError(`This change request is already ${change.status}.`, "router_change_request_closed");
      if (!emergency && change.submittedBy === actorId) {
        throw new ControllerError("The submitter cannot approve their own change request. Ask another administrator, or use emergency apply.", 403, "router_change_request_self_approval");
      }
      const stale = await this.staleReason(tx, router, change);
      if (stale) {
        await tx.update(trafficRouterChangeRequests).set({ status: "superseded", decidedAt: new Date(), decisionNote: stale, updatedAt: new Date() }).where(eq(trafficRouterChangeRequests.id, changeId));
        await this.audit(tx, id, actorId, "router.change_superseded", { changeRequestId: changeId, reason: stale });
        return { stale };
      }
      const applied = await this.applySnapshot(tx, router, { snapshot: change.snapshot, context: change.context, changeId, actorId,
        sourceDraftRevision: change.sourceDraftRevision!, requestDraftRevision: change.sourceDraftRevision!, rollbackRevision: null });
      await tx.update(trafficRouterChangeRequests).set({ status: "applied", decidedBy: actorId, decidedAt: new Date(), appliedRevision: applied.revision,
        decisionNote: emergency ? null : ("note" in decision ? decision.note ?? null : null),
        emergencyReason: emergency?.reason ?? null, updatedAt: new Date() })
        .where(eq(trafficRouterChangeRequests.id, changeId));
      await this.audit(tx, id, actorId, emergency ? "router.change_emergency_applied" : "router.change_approved", {
        changeRequestId: changeId, ticket: change.ticket, submittedBy: change.submittedBy, revision: applied.revision,
        previous: router.activeSnapshot, snapshot: change.snapshot, endpointIds: change.endpointIds,
        ...(emergency ? { emergencyReason: emergency.reason } : {}),
      });
      return { ...applied, replayed: false };
    });
    if ("stale" in outcome) throw new ConflictError(`This change request is no longer valid: ${outcome.stale} Submit the change again.`, "router_change_request_stale");
    return this.withPublication(id, outcome);
  }
  async rejectChange(id: string, changeId: string, actorId: string, note: string) {
    return this.closeChange(id, changeId, actorId, "rejected", note);
  }
  async withdrawChange(id: string, changeId: string, actorId: string) {
    return this.closeChange(id, changeId, actorId, "withdrawn", null);
  }
  /** Restore the base revision of the active change; it was approved together with that change. */
  async revertChange(id: string, changeId: string, actorId: string, reason: string) {
    const revertId = randomUUID();
    const outcome = await this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, "traffic-router-bindings");
      const router = await this.lockRouter(tx, id);
      const change = await this.lockChange(tx, id, changeId);
      if (change.kind !== "publish" || change.status !== "applied" || change.baseRevision === null || change.appliedRevision !== router.activeRevision) {
        throw new ConflictError("Only the change that produced the active revision can be reverted without approval.", "router_revert_unavailable");
      }
      const [base] = await tx.select().from(trafficRouterRevisions).where(and(eq(trafficRouterRevisions.routerId, id), eq(trafficRouterRevisions.revision, change.baseRevision)));
      if (!base) throw new ConflictError(`Router revision ${change.baseRevision} is no longer available.`, "router_revert_unavailable");
      const { snapshot, context, endpointIds } = await this.resolvePublication(tx, id, base.snapshot).catch(error => {
        if (error instanceof ValidationError) throw new ConflictError(`Router revision ${change.baseRevision} can no longer be applied: ${error.message}`, "router_revert_unavailable");
        throw error;
      });
      await tx.insert(trafficRouterChangeRequests).values({ id: revertId, routerId: id, kind: "revert", status: "applied",
        sourceDraftRevision: null, baseRevision: router.activeRevision, snapshot, endpointIds, context, ticket: change.ticket, reason,
        submittedBy: actorId, decidedBy: actorId, decidedAt: new Date(), decisionNote: null, revertsChangeRequestId: changeId });
      const applied = await this.applySnapshot(tx, router, { snapshot, context, changeId: revertId, actorId,
        sourceDraftRevision: router.draftRevision + 1, requestDraftRevision: router.draftRevision, rollbackRevision: change.baseRevision, replaceDraft: true });
      await tx.update(trafficRouterChangeRequests).set({ appliedRevision: applied.revision }).where(eq(trafficRouterChangeRequests.id, revertId));
      // A pending change was reviewed against the revision just replaced.
      await tx.update(trafficRouterChangeRequests).set({ status: "superseded", decidedAt: new Date(), decisionNote: "The active Router revision was reverted.", updatedAt: new Date() })
        .where(and(eq(trafficRouterChangeRequests.routerId, id), eq(trafficRouterChangeRequests.status, "pending")));
      await this.audit(tx, id, actorId, "router.change_reverted", { changeRequestId: revertId, revertsChangeRequestId: changeId, reason, revision: applied.revision, restoredRevision: change.baseRevision, previous: router.activeSnapshot, snapshot, endpointIds });
      return { ...applied, replayed: false };
    });
    return this.withPublication(id, outcome);
  }
  private async closeChange(id: string, changeId: string, actorId: string, status: "rejected" | "withdrawn", note: string | null) {
    await this.db.transaction(async tx => {
      await this.lockRouter(tx, id);
      const change = await this.lockChange(tx, id, changeId);
      if (change.status !== "pending") throw new ConflictError(`This change request is already ${change.status}.`, "router_change_request_closed");
      if (status === "withdrawn" && change.submittedBy !== actorId) throw new ControllerError("Only the submitter can withdraw a change request.", 403, "router_change_request_not_submitter");
      if (status === "rejected" && change.submittedBy === actorId) throw new ControllerError("Withdraw your own change request instead of rejecting it.", 403, "router_change_request_self_approval");
      await tx.update(trafficRouterChangeRequests).set({ status, decidedBy: actorId, decidedAt: new Date(), decisionNote: note, updatedAt: new Date() }).where(eq(trafficRouterChangeRequests.id, changeId));
      await this.audit(tx, id, actorId, `router.change_${status}`, { changeRequestId: changeId, note });
    });
    return this.changeRequest(id, changeId);
  }
  /** Why a frozen change can no longer be applied as reviewed, or null when it still can. */
  private async staleReason(tx: Tx, router: typeof trafficRouters.$inferSelect, change: typeof trafficRouterChangeRequests.$inferSelect) {
    if (router.activeRevision !== change.baseRevision) return "The active Router revision changed after submission.";
    try {
      const resolved = await this.resolvePublication(tx, router.id, change.snapshot, { verifyImports: true });
      if (!isDeepStrictEqual(resolved.snapshot, change.snapshot)) return "The referenced Guardrail versions changed after submission.";
      if (!isDeepStrictEqual(resolved.endpointIds, sortedIds(change.endpointIds))) return "The bound Endpoints changed after submission.";
      return null;
    } catch (error) {
      if (error instanceof ValidationError) return error.message.endsWith(".") ? error.message : `${error.message}.`;
      throw error;
    }
  }
  private async applySnapshot(tx: Tx, router: typeof trafficRouters.$inferSelect, input: { snapshot: RouterDraft; context: RouterRevisionContext | null; changeId: string; actorId: string; sourceDraftRevision: number; requestDraftRevision: number; rollbackRevision: number | null; replaceDraft?: boolean }) {
    const revision = (router.activeRevision ?? 0) + 1;
    const generation = await this.advance(tx);
    await tx.insert(trafficRouterRevisions).values({ routerId: router.id, revision, sourceDraftRevision: input.sourceDraftRevision, snapshot: input.snapshot, context: input.context,
      idempotencyKey: `change-request:${input.changeId}`, changeRequestId: input.changeId, generation, requestDraftRevision: input.requestDraftRevision, rollbackRevision: input.rollbackRevision, createdBy: input.actorId });
    await tx.update(trafficRouters).set({ ...(input.replaceDraft ? { draft: input.snapshot, draftRevision: input.sourceDraftRevision } : {}),
      activeDraftRevision: input.sourceDraftRevision, activeRevision: revision, activeSnapshot: input.snapshot, rolloutError: null, desiredGeneration: generation, updatedAt: new Date() })
      .where(eq(trafficRouters.id, router.id));
    return { revision, generation };
  }
  private async withPublication(id: string, publication: { revision: number; generation: number | null; replayed: boolean }) {
    return { ...await this.get(id), publication: { ...publication, revisionUrl: `/api/v1/routers/${encodeURIComponent(id)}/revisions/${publication.revision}`, statusUrl: `/api/v1/routers/${encodeURIComponent(id)}` } };
  }
  private async lockRouter(tx: Tx, id: string) {
    const [router] = await tx.select().from(trafficRouters).where(and(eq(trafficRouters.id, id), resourceWritePredicate(trafficRouters.tenantId))).for("update");
    if (!router || router.deletedAt) throw new NotFoundError("Router", id);
    return router;
  }
  private async lockChange(tx: Tx, id: string, changeId: string) {
    const [change] = await tx.select().from(trafficRouterChangeRequests).where(and(eq(trafficRouterChangeRequests.id, changeId), eq(trafficRouterChangeRequests.routerId, id))).for("update");
    if (!change) throw new NotFoundError("Router change request", changeId);
    return change;
  }
  private async withNames(tx: Tx | ControllerDatabase, rows: Array<typeof trafficRouterChangeRequests.$inferSelect>): Promise<RouterChangeRequest[]> {
    const ids = [...new Set(rows.flatMap(row => [row.submittedBy, row.decidedBy].filter((value): value is string => Boolean(value))))];
    const people = ids.length ? await tx.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ids)) : [];
    const refs = await this.visibleReferences(tx, rows.map(row => row.snapshot), rows.map(row => row.context), rows.flatMap(row => row.endpointIds));
    const name = (userId: string | null) => people.find(person => person.id === userId)?.name ?? null;
    return rows.map(row => ({ ...row, snapshot: redactSnapshot(row.snapshot, refs),
      endpointIds: row.endpointIds.filter(id => refs.endpoints === null || refs.endpoints.has(id)),
      context: redactContext(row.context, refs), submittedByName: name(row.submittedBy), decidedByName: name(row.decidedBy),
      submittedAt: row.submittedAt.toISOString(), decidedAt: row.decidedAt?.toISOString() ?? null }));
  }
  async revisions(id: string) {
    await this.get(id);
    const rows = await this.db.select().from(trafficRouterRevisions).where(eq(trafficRouterRevisions.routerId, id)).orderBy(desc(trafficRouterRevisions.revision));
    const refs = await this.visibleReferences(this.db, rows.map(row => row.snapshot), rows.map(row => row.context), []);
    return rows.map(row => ({ ...row, snapshot: redactSnapshot(row.snapshot, refs), context: redactContext(row.context, refs) }));
  }

  /** A Router share does not grant access to referenced resource metadata. */
  private async visibleReferences(tx: Tx | ControllerDatabase, snapshots: Array<RouterDraft | null>, contexts: Array<RouterRevisionContext | null>, endpointIds: string[]) {
    if (!currentTenantId()) return { endpoints: null, guardrails: null, restrictedEndpoints: new Set<string>() };
    const targetIds = [...new Set([
      ...snapshots.flatMap(snapshot => snapshot?.routes.flatMap(route => route.targets.map(target => target.guardrailId)) ?? []),
      ...contexts.flatMap(context => context?.guardrails.map(guardrail => guardrail.id) ?? []),
    ])];
    const sourceIds = [...new Set([...endpointIds, ...contexts.flatMap(context => context?.endpoints.map(endpoint => endpoint.id) ?? []),
      ...snapshots.flatMap(snapshot => snapshot?.routes.flatMap(route => endpointSelectorValues(route.selector.expression)) ?? []),
    ])];
    const [readableEndpoints, readableGuardrails, existingEndpoints] = await Promise.all([
      sourceIds.length ? tx.select({ id: endpoints.id }).from(endpoints).where(and(inArray(endpoints.id, sourceIds),
        isNull(endpoints.deletedAt), resourceReadPredicate("endpoint", endpoints.id, endpoints.tenantId))) : [],
      targetIds.length ? tx.select({ id: guardrails.id }).from(guardrails).where(and(inArray(guardrails.id, targetIds),
        isNull(guardrails.deletedAt), resourceReadPredicate("guardrail", guardrails.id, guardrails.tenantId))) : [],
      sourceIds.length ? tx.select({ id: endpoints.id }).from(endpoints).where(inArray(endpoints.id, sourceIds)) : [],
    ]);
    const readableEndpointIds = new Set(readableEndpoints.map(row => row.id));
    return { endpoints: readableEndpointIds, guardrails: new Set(readableGuardrails.map(row => row.id)),
      restrictedEndpoints: new Set(existingEndpoints.filter(row => !readableEndpointIds.has(row.id)).map(row => row.id)) };
  }
  async deleteRevision(id: string, revision: number, actorId: string) {
    await assertResourceWriteAccess(this.db, "router", id);
    await this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, "traffic-router-bindings");
      const [router] = await tx.select().from(trafficRouters).where(eq(trafficRouters.id, id)).for("update");
      if (!router || router.deletedAt) throw new NotFoundError("Router", id);
      const [record] = await tx.select().from(trafficRouterRevisions).where(and(eq(trafficRouterRevisions.routerId, id), eq(trafficRouterRevisions.revision, revision)));
      if (!record) throw new NotFoundError("Router revision", String(revision));
      if (router.activeRevision === revision) throw new ConflictError("The current Router revision cannot be deleted. Publish another revision first.", "revision_in_use");
      const [rollbackTarget] = await tx.select({ id: trafficRouterChangeRequests.id }).from(trafficRouterChangeRequests).where(and(
        eq(trafficRouterChangeRequests.routerId, id), eq(trafficRouterChangeRequests.status, "applied"), eq(trafficRouterChangeRequests.kind, "publish"),
        eq(trafficRouterChangeRequests.appliedRevision, router.activeRevision ?? -1), eq(trafficRouterChangeRequests.baseRevision, revision))).limit(1);
      if (rollbackTarget) throw new ConflictError("This revision is the pre-approved rollback target of the active change.", "revision_in_use");
      const runners = await tx.select({ ...getTableColumns(runnerInstances) }).from(runnerInstances)
        .innerJoin(runnerPools, eq(runnerPools.id, runnerInstances.poolId))
        .where(sql`exists (select 1 from ${tenants}
          where ${tenants.id} = ${router.tenantId} and ${tenants.groupId} = ${runnerPools.groupId})`);
      if (routerRolloutState(router, runners) !== "active" || Date.now() - router.updatedAt.getTime() < 300000) throw new ConflictError("Wait for Runner convergence and the five-minute call retention window before deleting historical revisions.", "revision_in_use");
      const [pending] = await tx.select().from(routeAssignments).where(and(eq(routeAssignments.routerId, id), eq(routeAssignments.routerRevision, revision), isNull(routeAssignments.completedAt), gte(routeAssignments.occurredAt, new Date(Date.now() - 300000)))).limit(1);
      if (pending) throw new ConflictError("This revision still has in-flight calls.", "revision_in_use");
      await this.audit(tx, id, actorId, "router.revision_deleted", { revision, snapshot: record.snapshot, context: record.context, idempotencyKey: record.idempotencyKey });
      await tx.delete(trafficRouterRevisions).where(and(eq(trafficRouterRevisions.routerId, id), eq(trafficRouterRevisions.revision, revision)));
    });
  }
  async bind(id: string, endpointIds: string[], actorId: string) {
    await assertResourceWriteAccess(this.db, "router", id);
    const changed = await this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, "traffic-router-bindings");
      const [router] = await tx.select().from(trafficRouters).where(eq(trafficRouters.id, id)).for("update");
      if (!router || router.deletedAt) throw new NotFoundError("Router", id);
      await this.assertDraftGuardrailsVisible(tx, router.activeSnapshot ?? router.draft);
      const all = await tx.select().from(endpoints).where(and(
        isNull(endpoints.deletedAt), resourceWritePredicate(endpoints.tenantId),
      ));
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
    const router = await this.get(id);
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
    }).from(routeAssignments).where(and(eq(routeAssignments.routerId, id), currentTenantId() ? eq(routeAssignments.tenantId, currentTenantId()!) : undefined, gte(routeAssignments.occurredAt, since), lte(routeAssignments.occurredAt, until), revision ? eq(routeAssignments.routerRevision, revision) : undefined, endpointId ? eq(routeAssignments.endpointId, endpointId) : undefined))
      .groupBy(routeAssignments.routeId, routeAssignments.targetId, routeAssignments.routerRevision, routeAssignments.guardrailId, routeAssignments.guardrailVersion, routeAssignments.assignmentStatus);
    // Runtime snapshots follow the Router owner's group, which may contain
    // several pools. An unrelated healthy default pool must not make this
    // Router's distribution look current.
    const pools = await this.db.select({ id: runnerPools.id }).from(runnerPools)
      .innerJoin(tenants, eq(tenants.groupId, runnerPools.groupId)).where(eq(tenants.id, router.tenantId));
    const poolIds = pools.map(pool => pool.id);
    const watermarks = poolIds.length ? await this.db.select({ poolId: runnerInstances.poolId, at: telemetryWatermarks.lastReceivedAt, heartbeat: runnerInstances.lastHeartbeatAt }).from(runnerInstances)
      .leftJoin(telemetryWatermarks, eq(telemetryWatermarks.runnerId, runnerInstances.runnerId))
      .where(and(inArray(runnerInstances.poolId, poolIds), ne(runnerInstances.status, "offline"))) : [];
    const everyPoolHasRunner = poolIds.length > 0 && poolIds.every(poolId => watermarks.some(r => r.poolId === poolId));
    // Scoped ingestion cannot yet establish a Runner/boot watermark. A fresh
    // watermark left by legacy mode (or a mixed-version writer) is not proof
    // that the quarantined routing events are complete.
    const telemetryFresh = !this.scopedTelemetry && everyPoolHasRunner && watermarks.every(r => r.at && until.getTime() - r.at.getTime() < 60000 && until.getTime() - r.heartbeat.getTime() < 60000);
    const dates = watermarks.flatMap(r => r.at ? [r.at.getTime()] : []);
    const total = rows.reduce((n, r) => n + r.count, 0), unassigned = rows.filter(r => r.assignmentStatus === "unassigned").reduce((n, r) => n + r.count, 0);
    const revisions = await this.revisions(id);
    const trend = await this.db.select({ at: sql<string>`date_bin(interval '15 minutes', ${routeAssignments.occurredAt}, timestamptz '2000-01-01')::text`, routeId: routeAssignments.routeId, count: sql<number>`count(*)::int` }).from(routeAssignments)
      .where(and(eq(routeAssignments.routerId, id), currentTenantId() ? eq(routeAssignments.tenantId, currentTenantId()!) : undefined, gte(routeAssignments.occurredAt, since), lte(routeAssignments.occurredAt, until), revision ? eq(routeAssignments.routerRevision, revision) : undefined, endpointId ? eq(routeAssignments.endpointId, endpointId) : undefined))
      .groupBy(sql`date_bin(interval '15 minutes', ${routeAssignments.occurredAt}, timestamptz '2000-01-01')`, routeAssignments.routeId);
    return { since: since.toISOString(), until: until.toISOString(), rows, total, assigned: total - unassigned, unassigned, trend,
      revisions: revisions.map(r => ({ revision: r.revision, snapshot: r.snapshot, context: r.context })),
      telemetryFresh, completeness: telemetryFresh ? "current" : "delayed_or_unavailable", dataWatermark: !this.scopedTelemetry && everyPoolHasRunner && dates.length === watermarks.length ? new Date(Math.min(...dates)).toISOString() : null,
      unit: "logical_call", multipleRevisions: new Set(rows.map(r => r.routerRevision)).size > 1 };
  }
  async expireCalls() {
    await this.db.update(routeAssignments).set({ completionInferred: true, outcome: "timeout", completedAt: sql`${routeAssignments.occurredAt} + interval '300 seconds'`, durationMs: 300000 })
      .where(and(isNull(routeAssignments.completedAt), lt(routeAssignments.occurredAt, new Date(Date.now() - 300000))));
  }
  private lastRetentionAt = 0;
  async recordEvents(events: readonly RoutingEvent[], quarantine = false, authenticatedPoolId?: string, transaction?: Tx) {
    const restricted = quarantine || this.scopedTelemetry || authenticatedPoolId !== undefined;
    if (Date.now() - this.lastRetentionAt > 3600000) {
      await (transaction ?? this.db).delete(routeAssignments).where(lt(routeAssignments.occurredAt, new Date(Date.now() - 30 * 86400000)));
      this.lastRetentionAt = Date.now();
    }
    const writeEvents = async (tx: Tx) => {
      const endpointIds = [...new Set(events.map(event => event.endpointId))];
      const routerIds = [...new Set(events.map(event => event.routerId).filter(Boolean))];
      const endpointOwners = new Map((!restricted && endpointIds.length ? await tx.select({ id: endpoints.id, tenantId: endpoints.tenantId })
        .from(endpoints).where(inArray(endpoints.id, endpointIds)) : []).map(row => [row.id, row.tenantId]));
      const routerOwners = new Map((!restricted && routerIds.length ? await tx.select({ id: trafficRouters.id, tenantId: trafficRouters.tenantId })
        .from(trafficRouters).where(inArray(trafficRouters.id, routerIds)) : []).map(row => [row.id, row.tenantId]));
      const accepts = await guardrailTelemetryFilter(tx, events.map(event => event.guardrailId));
      if (events.some(event => event.allocationContextId)) await lockEndpointTelemetryContextReaders(tx);
      for (const event of events) {
        if (!accepts(event.guardrailId, event.decisionAt)) continue;
        if (event.decisionAt.getTime() < Date.now() - 30 * 86400000) continue;
        const complete = event.eventType === "completion";
        // A Router alone cannot establish who invoked an Endpoint. Missing or
        // conflicting owners are platform-only rather than guessed as tenantA.
        const endpointOwner = endpointOwners.get(event.endpointId);
        const routerOwner = routerOwners.get(event.routerId);
        const eventTenant = restricted
          ? authenticatedPoolId === undefined ? null : routingEventTenantId(event, authenticatedPoolId)
          : endpointOwner && (!event.routerId || endpointOwner === routerOwner) ? endpointOwner : null;
        await tx.insert(routeAssignments).values({ decisionId: event.decisionId, tenantId: eventTenant, callId: event.callId, routerId: event.routerId, routerRevision: event.routerRevision,
          routeId: event.routeId, targetId: event.targetId, guardrailId: event.guardrailId, guardrailVersion: event.guardrailVersion, endpointId: event.endpointId,
          allocationContextId: event.allocationContextId ?? null,
          assignmentStatus: event.assignmentStatus, failureReason: event.failureReason ?? null, occurredAt: event.decisionAt,
          completedAt: complete ? event.occurredAt : null, outcome: complete ? event.outcome! : null, durationMs: complete ? event.durationMs ?? null : null,
        }).onConflictDoUpdate({ target: routeAssignments.decisionId, set: {
          failureReason: sql`CASE WHEN excluded.completed_at IS NOT NULL THEN coalesce(excluded.failure_reason, ${routeAssignments.failureReason}) ELSE ${routeAssignments.failureReason} END`,
          completionInferred: sql`CASE WHEN excluded.completed_at IS NOT NULL THEN false ELSE ${routeAssignments.completionInferred} END`,
          completedAt: sql`CASE WHEN ${routeAssignments.completionInferred} AND excluded.completed_at IS NOT NULL THEN excluded.completed_at ELSE coalesce(${routeAssignments.completedAt}, excluded.completed_at) END`,
          outcome: sql`CASE WHEN ${routeAssignments.completionInferred} AND excluded.completed_at IS NOT NULL THEN excluded.outcome WHEN ${routeAssignments.outcome} IN ('error','timeout') THEN ${routeAssignments.outcome}
            WHEN excluded.outcome IN ('error','timeout') THEN excluded.outcome
            WHEN ${routeAssignments.outcome} = 'block' OR excluded.outcome = 'block' THEN 'block'
            WHEN ${routeAssignments.outcome} = 'intervene' OR excluded.outcome = 'intervene' THEN 'intervene'
            WHEN ${routeAssignments.outcome} = 'transform' OR excluded.outcome = 'transform' THEN 'transform'
            ELSE coalesce(${routeAssignments.outcome}, excluded.outcome) END`,
          durationMs: sql`CASE WHEN ${routeAssignments.completionInferred} AND excluded.completed_at IS NOT NULL THEN excluded.duration_ms ELSE greatest(${routeAssignments.durationMs}, excluded.duration_ms) END`,
        }, setWhere: sql`(${restricted} AND excluded.tenant_id IS NOT NULL AND ${routeAssignments.tenantId} = excluded.tenant_id
            OR ${!restricted} AND (
            ${routeAssignments.tenantId} IS NOT DISTINCT FROM excluded.tenant_id
            -- A pre-upgrade call may finish after migration. Keep its NULL
            -- tenant, but allow its matching completion to update the evidence.
            OR (${routeAssignments.tenantId} IS NULL AND excluded.completed_at IS NOT NULL
              AND EXISTS (SELECT 1 FROM historical_telemetry_attribution
                WHERE resource_type = 'route_assignment' AND resource_id = ${routeAssignments.decisionId}))
          ))
          AND ${routeAssignments.allocationContextId} IS NOT DISTINCT FROM excluded.allocation_context_id
          AND ${routeAssignments.callId} = excluded.call_id
          AND ${routeAssignments.endpointId} = excluded.endpoint_id
          AND ${routeAssignments.routerId} = excluded.router_id
          AND ${routeAssignments.routerRevision} = excluded.router_revision
          AND ${routeAssignments.routeId} = excluded.route_id
          AND ${routeAssignments.targetId} = excluded.target_id
          AND ${routeAssignments.guardrailId} = excluded.guardrail_id
          AND ${routeAssignments.guardrailVersion} = excluded.guardrail_version
          AND ${routeAssignments.assignmentStatus} = excluded.assignment_status
          AND ${routeAssignments.occurredAt} = excluded.occurred_at` });
        if (restricted) continue;
        await tx.insert(telemetryWatermarks).values({ runnerId: event.runnerId, lastEventOccurredAt: event.occurredAt, lastReceivedAt: new Date(), updatedAt: new Date() })
          .onConflictDoUpdate({ target: telemetryWatermarks.runnerId, set: { lastEventOccurredAt: event.occurredAt, lastReceivedAt: new Date(), updatedAt: new Date() } });
      }
    };
    if (transaction) await writeEvents(transaction);
    else await this.db.transaction(writeEvents);
  }

  async runtimeSnapshots(tenantIds: readonly string[], tx: Tx | ControllerDatabase = this.db) {
    // Runtime distribution is an explicit allocation boundary, independent of
    // the HTTP actor's read visibility. An empty group must never mean "all".
    if (!tenantIds.length) return [];
    const rows = await tx.select().from(trafficRouters).where(and(
      isNull(trafficRouters.deletedAt), inArray(trafficRouters.tenantId, [...tenantIds]),
    ));
    const bindings = await tx.select({ id: endpoints.id, routerId: endpoints.trafficRouterId, tenantId: endpoints.tenantId })
      .from(endpoints).where(and(isNull(endpoints.deletedAt), inArray(endpoints.tenantId, [...tenantIds])));
    const published = rows.filter(row => row.activeSnapshot && row.activeRevision !== null);
    const ids = [...new Set(published.flatMap(row => row.activeSnapshot!.routes.flatMap(route => route.targets.map(target => target.guardrailId))))];
    const versions = ids.length ? await tx.select({
      guardrailId: guardrailVersions.guardrailId, version: guardrailVersions.version,
      artifactId: guardrailVersions.artifactId, ownerTenantId: guardrails.tenantId,
    }).from(guardrailVersions).innerJoin(guardrails, eq(guardrails.id, guardrailVersions.guardrailId))
      .where(and(inArray(guardrailVersions.guardrailId, ids), isNull(guardrails.deletedAt))) : [];
    const shares = ids.length ? await tx.select().from(resourceShares).where(and(
      eq(resourceShares.resourceType, "guardrail"), inArray(resourceShares.resourceId, ids),
      inArray(resourceShares.recipientTenantId, [...tenantIds]),
    )) : [];
    return published.flatMap(router => {
      const versionsForTarget = (target: { guardrailId: string; guardrailVersion: string }) =>
        versions.find(version => version.guardrailId === target.guardrailId && version.version === target.guardrailVersion);
      // A stale/deleted target or revoked share must not keep serving through
      // last-known-good state. Omit the entire Router so its Endpoints become
      // unbound in this accepted snapshot; never fall through to another Route.
      const invalid = router.activeSnapshot!.routes.some(route => route.targets.some(target => {
        const version = versionsForTarget(target);
        if (!version) return target.weightBps > 0;
        return (target.weightBps > 0 && !version.artifactId)
          || version.ownerTenantId !== router.tenantId && !shares.some(share =>
            share.resourceId === target.guardrailId && share.ownerTenantId === version.ownerTenantId
            && share.recipientTenantId === router.tenantId);
      }));
      if (invalid) return [];
      return [{ routerId: router.id, revision: router.activeRevision!,
        endpointIds: bindings.filter(endpoint => endpoint.routerId === router.id && endpoint.tenantId === router.tenantId).map(endpoint => endpoint.id),
        routes: router.activeSnapshot!.routes.map(route => ({ ...route,
          targets: route.targets.map(target => ({ ...target, artifactId: versionsForTarget(target)?.artifactId ?? "" })),
        })),
      }];
    });
  }
  /**
   * Routing that still depends on one immutable Guardrail version. Historical
   * revisions are not references: they are reported because deleting the
   * version makes them non-restorable. `retired` is when, and at which
   * generation, the version last stopped being served by an active revision.
   */
  async versionReferences(guardrailId: string, version: string, tx: Tx | ControllerDatabase = this.db) {
    const pinned = (draft: RouterDraft | null) => Boolean(draft?.routes.some(route => route.targets.some(t =>
      t.guardrailId === guardrailId && t.guardrailVersion === version)));
    const routers = await tx.select().from(trafficRouters).where(isNull(trafficRouters.deletedAt)).orderBy(asc(trafficRouters.name));
    const ids = routers.map(r => r.id);
    const readableIds = await this.readableRouterIds(tx, ids);
    const [history, changes] = ids.length ? await Promise.all([
      tx.select().from(trafficRouterRevisions).where(inArray(trafficRouterRevisions.routerId, ids)).orderBy(asc(trafficRouterRevisions.routerId), asc(trafficRouterRevisions.revision)),
      tx.select().from(trafficRouterChangeRequests).where(and(inArray(trafficRouterChangeRequests.routerId, ids),
        or(eq(trafficRouterChangeRequests.status, "pending"), and(eq(trafficRouterChangeRequests.status, "applied"), eq(trafficRouterChangeRequests.kind, "publish"))))),
    ]) : [[], []];
    const references: Array<{ kind: "router_active" | "router_draft" | "change_request" | "rollback_target"; routerId: string; routerName: string; changeRequestId?: string; ticket?: string; revision?: number }> = [];
    const historical: Array<{ routerId: string; routerName: string; revision: number; createdAt: string }> = [];
    let retired: { at: Date; generation: number | null } | null = null;
    for (const router of routers) {
      const readable = readableIds.has(router.id);
      const at = readable ? { routerId: router.id, routerName: router.name }
        : { routerId: "", routerName: "Another tenant’s Router" };
      if (pinned(router.activeSnapshot)) references.push({ kind: "router_active", ...at, ...(readable ? { revision: router.activeRevision! } : {}) });
      const pending = changes.find(c => c.routerId === router.id && c.status === "pending");
      if (pending && pinned(pending.snapshot)) references.push({ kind: "change_request", ...at, ...(readable ? { changeRequestId: pending.id, ticket: pending.ticket } : {}) });
      // A draft unchanged since the active or pending snapshot is already reported through it.
      const draftEdited = router.draftRevision !== router.activeDraftRevision && router.draftRevision !== pending?.sourceDraftRevision;
      if (draftEdited && pinned(router.draft)) references.push({ kind: "router_draft", ...at });
      const active = changes.find(c => c.routerId === router.id && c.status === "applied" && c.appliedRevision === router.activeRevision && c.baseRevision !== null);
      const revisions = history.filter(r => r.routerId === router.id);
      revisions.forEach((revision, index) => {
        if (!pinned(revision.snapshot)) return;
        if (revision.revision === active?.baseRevision) references.push({ kind: "rollback_target", ...at, ...(readable ? { revision: revision.revision, changeRequestId: active.id } : {}) });
        else if (readable && revision.revision !== router.activeRevision) historical.push({ ...at, revision: revision.revision, createdAt: revision.createdAt.toISOString() });
        const successor = revisions[index + 1];
        if (successor && !pinned(successor.snapshot) && (!retired || successor.createdAt > retired.at)) retired = { at: successor.createdAt, generation: successor.generation };
      });
    }
    return { references, historical, retired: retired as { at: Date; generation: number | null } | null };
  }
  async assertGuardrailUnused(id: string, tx: Tx | ControllerDatabase = this.db) {
    const rows = await tx.select().from(trafficRouters).where(isNull(trafficRouters.deletedAt));
    const readableIds = await this.readableRouterIds(tx, rows.map(row => row.id));
    const names = (routers: typeof rows) => routers.map(router => readableIds.has(router.id) ? router.name : "Another tenant’s Router").join(", ");
    const recentRevisions = await tx.select().from(trafficRouterRevisions).where(gte(trafficRouterRevisions.createdAt, new Date(Date.now() - 300000)));
    const recentlyChanged = new Set(recentRevisions.map(r => r.routerId));
    if (recentlyChanged.size) {
      const history = await tx.select().from(trafficRouterRevisions);
      if (history.some(r => recentlyChanged.has(r.routerId) && r.snapshot.routes.some(route => route.targets.some(t => t.guardrailId === id)))) throw new ConflictError("Wait for the five-minute call retention window after changing routes before deleting this Guardrail.", "guardrail_in_use");
    }
    const refs = rows.filter(r => r.activeSnapshot?.routes.some(route => route.targets.some(t => t.guardrailId === id)));
    const [pending] = await tx.select({ count: sql<number>`count(*)::int` }).from(routeAssignments).where(and(eq(routeAssignments.guardrailId, id), isNull(routeAssignments.completedAt), gte(routeAssignments.occurredAt, new Date(Date.now() - 300000))));
    if (pending?.count) throw new ConflictError("Guardrail still has in-flight calls.", "guardrail_in_use");
    if (refs.length) throw new ConflictError(`Guardrail is referenced by published Routers: ${names(refs)}`, "guardrail_in_use");
    const pendingChanges = await tx.select({ routerId: trafficRouterChangeRequests.routerId, snapshot: trafficRouterChangeRequests.snapshot }).from(trafficRouterChangeRequests).where(eq(trafficRouterChangeRequests.status, "pending"));
    const awaiting = rows.filter(r => pendingChanges.some(c => c.routerId === r.id && c.snapshot.routes.some(route => route.targets.some(t => t.guardrailId === id))));
    if (awaiting.length) throw new ConflictError(`Guardrail is referenced by pending Router change requests: ${names(awaiting)}`, "guardrail_in_use");
  }
  private async readableRouterIds(tx: Tx | ControllerDatabase, ids: string[]): Promise<Set<string>> {
    if (!currentTenantId() || !ids.length) return new Set(ids);
    const rows = await tx.select({ id: trafficRouters.id }).from(trafficRouters).where(and(
      inArray(trafficRouters.id, ids), resourceReadPredicate("router", trafficRouters.id, trafficRouters.tenantId),
    ));
    return new Set(rows.map(row => row.id));
  }
  async reportRolloutFailure(generation: number, runnerId: string, reason: string,
    principal?: { poolId: string; bootId: string; controlSessionId: string }) {
    // A pool's rejected snapshot is not authority to change another group's
    // Router status. Raw errors may contain a different same-group tenant's
    // private Endpoint/Policy identity, so only platform audit retains them.
    if (!principal || !Number.isSafeInteger(generation) || generation < 0) return;
    await this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, "traffic-router-bindings");
      const updated = await tx.update(trafficRouters).set({ rolloutError: "A Runner rejected this tenant group's runtime snapshot. Contact a platform administrator." })
        .where(and(isNull(trafficRouters.deletedAt), lte(trafficRouters.desiredGeneration, generation),
          sql`${trafficRouters.activeRevision} is not null`,
          sql`exists (select 1 from tenant failure_tenant
            inner join runner_pool failure_pool on failure_pool.group_id = failure_tenant.group_id
            inner join runner_instance failure_runner on failure_runner.pool_id = failure_pool.id
            inner join runner_control_session failure_session on failure_session.id = failure_runner.control_session_id
            where failure_tenant.id = ${trafficRouters.tenantId} and failure_pool.id = ${principal.poolId}
              and failure_runner.runner_id = ${runnerId} and failure_runner.boot_id = ${principal.bootId}
              and failure_runner.control_session_id = ${principal.controlSessionId}
              and failure_runner.disconnected_at is null and failure_runner.status <> 'offline'
              and failure_session.id = ${principal.controlSessionId} and failure_session.runner_id = ${runnerId}
              and failure_session.boot_id = ${principal.bootId} and failure_session.pool_id = ${principal.poolId}
              and failure_session.disconnected_at is null)`)).returning({ id: trafficRouters.id });
      if (updated.length) await tx.insert(auditEvents).values({ id: randomUUID(), tenantId: null,
        kind: "runner.snapshot_rejected", actorId: null, resourceType: "runner", resourceId: runnerId,
        detail: { poolId: principal.poolId, generation, affectedRouterCount: updated.length, reason: reason.slice(0, 2000) } });
    });
  }
  async remove(id: string, actorId: string) {
    await assertResourceWriteAccess(this.db, "router", id);
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
  private async assertDraftGuardrailsVisible(tx: Tx, draft: RouterDraft): Promise<void> {
    const ids = [...new Set(draft.routes.flatMap(route => route.targets.map(target => target.guardrailId)))];
    if (!ids.length) return;
    const rows = await tx.select({ id: guardrails.id }).from(guardrails).where(and(
      inArray(guardrails.id, ids), isNull(guardrails.deletedAt),
      resourceReadPredicate("guardrail", guardrails.id, guardrails.tenantId),
    ));
    if (rows.length !== ids.length) throw new ValidationError("Router references a Guardrail that is unavailable to this tenant.");
  }
  private async audit(tx: Tx, id: string, actorId: string, kind: string, detail: Record<string, unknown>) {
    await tx.insert(auditEvents).values({ id: randomUUID(), resourceType: "router", resourceId: id, actorId, kind, detail });
  }
}
