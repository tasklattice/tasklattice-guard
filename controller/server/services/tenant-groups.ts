import { randomUUID } from "node:crypto";
import { and, asc, eq, ne, or, type SQL } from "drizzle-orm";
import type { ControllerDatabase } from "../db/client.js";
import { auditEvents, controllerState, outboxEvents, runnerInstances, runnerPools, runnerServingGrants, tenantGroupMoves, tenantGroupMovePools, tenantGroups, tenants } from "../db/schema.js";
import { advisoryTransactionLock } from "../db/postgres-locks.js";
import { increment } from "../db/postgres-expressions.js";
import { ConflictError, NotFoundError, ValidationError } from "../domain/errors.js";
import { assertPlatformAuthority } from "./tenant-context.js";
import { assertNoPreparedAllocationTransition } from "./tenant-group-moves.js";
import { retireEndpointTelemetryContexts } from "./endpoint-telemetry-contexts.js";
import {
  DEFAULT_TENANT_GROUP_ID, createGroupPoolSchema, createTenantGroupSchema, tenantGroupAssignmentSchema,
  tenantGroupIdSchema, updatePoolConnectivitySchema, updateTenantGroupSchema,
  type TenantGroupInventory, type TenantGroupPool, type TenantGroupView,
} from "../../shared/tenant-groups.js";

type Transaction = Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0];
const bindingsLock = "traffic-router-bindings";

/** Platform allocation, independent of tenant read-sharing and resource ownership. */
export class TenantGroupService {
  constructor(private readonly db: ControllerDatabase, private readonly experimentalLeaseGrants = false) {}

  async list(): Promise<TenantGroupInventory> {
    assertPlatformAuthority();
    const [groups, members, pools] = await Promise.all([
      this.db.select().from(tenantGroups).orderBy(asc(tenantGroups.name), asc(tenantGroups.id)),
      this.listTenants(),
      this.db.select().from(runnerPools).orderBy(asc(runnerPools.name), asc(runnerPools.id)),
    ]);
    return { items: groups.map(group => ({ ...publicGroup(group),
      tenantIds: members.filter(tenant => tenant.groupId === group.id).map(tenant => tenant.id),
      poolIds: pools.filter(pool => pool.groupId === group.id).map(pool => pool.id),
    })), tenants: members, pools: pools.map(publicPool) };
  }

  async listTenants() {
    assertPlatformAuthority();
    return this.db.select({ id: tenants.id, name: tenants.name, groupId: tenants.groupId })
      .from(tenants).orderBy(asc(tenants.name), asc(tenants.id));
  }

  async create(raw: unknown, actorId: string): Promise<TenantGroupView> {
    assertPlatformAuthority();
    const input = createTenantGroupSchema.parse(raw);
    const id = input.id ?? `group-${randomUUID()}`;
    return this.db.transaction(async tx => {
      const [group] = await tx.insert(tenantGroups).values({ id, name: input.name }).onConflictDoNothing().returning();
      if (!group) throw new ConflictError("This Tenant Group ID already exists.", "tenant_group_exists");
      await this.audit(tx, actorId, "tenant_group.created", "tenant_group", id, { name: input.name });
      return { ...publicGroup(group), tenantIds: [], poolIds: [] };
    });
  }

  async update(id: string, raw: unknown, actorId: string) {
    assertPlatformAuthority(); tenantGroupIdSchema.parse(id);
    const input = updateTenantGroupSchema.parse(raw);
    await this.db.transaction(async tx => {
      const [group] = await tx.update(tenantGroups).set({ name: input.name, updatedAt: new Date() })
        .where(eq(tenantGroups.id, id)).returning();
      if (!group) throw new NotFoundError("Tenant Group", id);
      await this.audit(tx, actorId, "tenant_group.updated", "tenant_group", id, { name: input.name });
    });
    return (await this.list()).items.find(group => group.id === id)!;
  }

  async remove(id: string, actorId: string): Promise<void> {
    assertPlatformAuthority(); tenantGroupIdSchema.parse(id);
    await this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, bindingsLock);
      const group = await this.lockGroup(tx, id);
      if (group.isDefault || id === DEFAULT_TENANT_GROUP_ID) throw new ConflictError("The Default Tenant Group cannot be deleted.", "default_tenant_group_protected");
      await assertNoPreparedAllocationTransition(tx, { groupIds: [id] });
      const [member] = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.groupId, id)).limit(1);
      const [pool] = await tx.select({ id: runnerPools.id }).from(runnerPools).where(eq(runnerPools.groupId, id)).limit(1);
      if (member || pool) throw new ConflictError("Move every Tenant and Runner pool out of this group before deleting it.", "tenant_group_in_use");
      const [move] = await tx.select({ id: tenantGroupMoves.id }).from(tenantGroupMoves)
        .where(or(eq(tenantGroupMoves.sourceGroupId, id), eq(tenantGroupMoves.destinationGroupId, id))).limit(1);
      const [capture] = await tx.select({ id: tenantGroupMovePools.moveId }).from(tenantGroupMovePools)
        .where(eq(tenantGroupMovePools.sourceGroupId, id)).limit(1);
      if (move || capture) throw new ConflictError(
        "This Tenant Group is retained by allocation transition history and cannot be deleted. Keep its identity until a coordinated history-retention workflow is available.",
        "tenant_group_history_retained");
      await tx.delete(tenantGroups).where(eq(tenantGroups.id, id));
      await this.audit(tx, actorId, "tenant_group.deleted", "tenant_group", id, { name: group.name });
    });
  }

  async assignTenant(id: string, raw: unknown, actorId: string) {
    assertPlatformAuthority();
    const input = tenantGroupAssignmentSchema.parse(raw);
    return this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, bindingsLock);
      await this.lockGroup(tx, input.groupId);
      const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, id)).for("update");
      if (!tenant) throw new NotFoundError("Tenant", id);
      this.checkExpectedGroup(tenant.groupId, input.expectedGroupId);
      if (tenant.groupId === input.groupId) return { id: tenant.id, name: tenant.name, groupId: tenant.groupId, generation: await this.generation(tx) };
      await assertNoPreparedAllocationTransition(tx, { groupIds: [tenant.groupId, input.groupId] });
      this.assertReassignmentAvailable();
      await this.assertNoGrantHistory(tx, eq(runnerPools.groupId, tenant.groupId));
      const [live] = await tx.select({ id: runnerInstances.runnerId }).from(runnerInstances)
        .innerJoin(runnerPools, eq(runnerPools.id, runnerInstances.poolId))
        .where(and(eq(runnerPools.groupId, tenant.groupId), ne(runnerInstances.status, "offline"))).limit(1);
      if (live) throw new ConflictError("Stop the old group's Runners and wait until every registration is offline before moving this Tenant. This prevents stale Runner state from retaining the Tenant's Endpoints.",
        "tenant_group_runners_active", { groupId: tenant.groupId });
      const sourcePools = await tx.select({ id: runnerPools.id }).from(runnerPools).where(eq(runnerPools.groupId, tenant.groupId));
      await retireEndpointTelemetryContexts(tx, sourcePools.map(pool => pool.id));
      await tx.update(tenants).set({ groupId: input.groupId }).where(eq(tenants.id, id));
      const generation = await this.advance(tx, "tenant", id, { previousGroupId: tenant.groupId, groupId: input.groupId });
      await this.audit(tx, actorId, "tenant.group_assigned", "tenant", id, { previousGroupId: tenant.groupId, groupId: input.groupId, generation });
      return { id: tenant.id, name: tenant.name, groupId: input.groupId, generation };
    });
  }

  async createPool(groupId: string, raw: unknown, actorId: string) {
    assertPlatformAuthority(); tenantGroupIdSchema.parse(groupId);
    const input = createGroupPoolSchema.parse(raw);
    if (input.id === "default") throw new ConflictError("The default Runner pool is created by platform bootstrap.", "default_runner_pool_protected");
    return this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, bindingsLock);
      await this.lockGroup(tx, groupId);
      await assertNoPreparedAllocationTransition(tx, { groupIds: [groupId] });
      const [pool] = await tx.insert(runnerPools).values({ id: input.id, name: input.name, groupId,
        runtimeUrl: input.runtimeUrl, publicUrl: input.publicUrl ?? null,
        desiredReplicas: 1, safeRpsPerRunner: 50, maxConcurrencyPerRunner: 64,
      }).onConflictDoNothing().returning();
      if (!pool) throw new ConflictError("This Runner pool ID already exists.", "runner_pool_exists");
      const generation = await this.advance(tx, "runner_pool", pool.id, { groupId });
      await this.audit(tx, actorId, "runner_pool.registered", "runner_pool", pool.id, { groupId, runtimeUrl: pool.runtimeUrl, publicUrl: pool.publicUrl, generation });
      return { ...publicPool(pool), generation };
    });
  }

  async assignPool(id: string, raw: unknown, actorId: string) {
    assertPlatformAuthority();
    const input = tenantGroupAssignmentSchema.parse(raw);
    return this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, bindingsLock);
      await this.lockGroup(tx, input.groupId);
      const pool = await this.lockPool(tx, id);
      this.checkExpectedGroup(pool.groupId, input.expectedGroupId);
      if (pool.groupId === input.groupId) return { ...publicPool(pool), generation: await this.generation(tx) };
      if (pool.isDefault || pool.id === "default") throw new ConflictError("The default Runner pool must remain in the Default Tenant Group.", "default_runner_pool_protected");
      await assertNoPreparedAllocationTransition(tx, { groupIds: [pool.groupId, input.groupId], poolIds: [id] });
      this.assertReassignmentAvailable();
      await this.assertNoGrantHistory(tx, eq(runnerPools.id, id));
      const [live] = await tx.select({ id: runnerInstances.runnerId }).from(runnerInstances)
        .where(and(eq(runnerInstances.poolId, id), ne(runnerInstances.status, "offline"))).limit(1);
      if (live) throw new ConflictError("Stop this pool's Runners and wait until every registration is offline before reallocating the pool. This prevents stale Runner state from serving its former group.", "runner_pool_runners_active");
      if (!pool.runtimeUrl) throw new ValidationError("Configure this pool's runtime URL before assigning it to another group.");
      await retireEndpointTelemetryContexts(tx, [id]);
      const [updated] = await tx.update(runnerPools).set({ groupId: input.groupId, updatedAt: new Date() }).where(eq(runnerPools.id, id)).returning();
      const generation = await this.advance(tx, "runner_pool", id, { previousGroupId: pool.groupId, groupId: input.groupId });
      await this.audit(tx, actorId, "runner_pool.group_assigned", "runner_pool", id, { previousGroupId: pool.groupId, groupId: input.groupId, generation });
      return { ...publicPool(updated!), generation };
    });
  }

  async updateConnectivity(id: string, raw: unknown, actorId: string) {
    assertPlatformAuthority();
    const input = updatePoolConnectivitySchema.parse(raw);
    if (id !== "default" && input.runtimeUrl === null) throw new ValidationError("A non-default Runner pool requires an explicit runtime URL.");
    return this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, bindingsLock);
      const pool = await this.lockPool(tx, id);
      if (pool.runtimeUrl === input.runtimeUrl && pool.publicUrl === input.publicUrl) return { ...publicPool(pool), generation: await this.generation(tx) };
      await assertNoPreparedAllocationTransition(tx, { groupIds: [pool.groupId], poolIds: [id] });
      const [updated] = await tx.update(runnerPools).set({ ...input, updatedAt: new Date() }).where(eq(runnerPools.id, id)).returning();
      const generation = await this.advance(tx, "runner_pool", id, { connectivityChanged: true });
      await this.audit(tx, actorId, "runner_pool.connectivity_updated", "runner_pool", id,
        { runtimeUrl: input.runtimeUrl, publicUrl: input.publicUrl, previousRuntimeUrl: pool.runtimeUrl, previousPublicUrl: pool.publicUrl, generation });
      return { ...publicPool(updated!), generation };
    });
  }

  private checkExpectedGroup(current: string, expected: string) {
    if (current !== expected) throw new ConflictError("The group assignment changed. Reload its current allocation before trying again.", "tenant_group_assignment_conflict", { expectedGroupId: expected, currentGroupId: current });
  }
  private assertReassignmentAvailable() {
    // An offline registration is not proof that an old lease or workload has
    // stopped. Until moves participate in durable drain/epoch coordination,
    // experimental grants must not be combined with immediate reassignment.
    if (this.experimentalLeaseGrants) throw new ConflictError(
      "Tenant and pool reassignment is unavailable while experimental Runner lease grants are enabled. Lease-aware drain and allocation transitions are not implemented yet.",
      "runner_lease_reassignment_unavailable");
  }
  private async assertNoGrantHistory(tx: Transaction, affectedPool: SQL) {
    const [grant] = await tx.select({ poolId: runnerServingGrants.poolId }).from(runnerServingGrants)
      .innerJoin(runnerPools, eq(runnerPools.id, runnerServingGrants.poolId)).where(affectedPool).limit(1);
    // Disabling the experiment must not bypass grants already issued. Without
    // a verified drain/epoch protocol, a DB-clock expiry is insufficient proof
    // that old work stopped; retain history and refuse the move conservatively.
    if (grant) throw new ConflictError(
      "Reassignment is unavailable because an affected pool has Runner lease grant history. Lease-aware drain and allocation transitions are required before moving it.",
      "runner_lease_reassignment_unavailable");
  }
  private async lockGroup(tx: Transaction, id: string) {
    const [group] = await tx.select().from(tenantGroups).where(eq(tenantGroups.id, id)).for("update");
    if (!group) throw new NotFoundError("Tenant Group", id);
    return group;
  }
  private async lockPool(tx: Transaction, id: string) {
    const [pool] = await tx.select().from(runnerPools).where(eq(runnerPools.id, id)).for("update");
    if (!pool) throw new NotFoundError("Runner Pool", id);
    return pool;
  }
  private async generation(tx: Transaction) {
    const [state] = await tx.select({ generation: controllerState.desiredGeneration }).from(controllerState).where(eq(controllerState.id, "singleton"));
    return state?.generation ?? 0;
  }
  private async advance(tx: Transaction, resourceType: string, resourceId: string, detail: Record<string, unknown>) {
    const [state] = await tx.update(controllerState).set({ desiredGeneration: increment(controllerState.desiredGeneration), updatedAt: new Date() })
      .where(eq(controllerState.id, "singleton")).returning();
    if (!state) throw new Error("Controller state is not initialized.");
    await tx.insert(outboxEvents).values({ id: randomUUID(), kind: "runner.desired_state_changed", aggregateId: resourceId,
      payload: { resourceType, resourceId, generation: state.desiredGeneration, ...detail } });
    return state.desiredGeneration;
  }
  private async audit(tx: Transaction, actorId: string, kind: string, resourceType: string, resourceId: string, detail: Record<string, unknown>) {
    await tx.insert(auditEvents).values({ id: randomUUID(), actorId, kind, resourceType, resourceId, detail });
  }
}

function publicGroup(group: typeof tenantGroups.$inferSelect) {
  return { id: group.id, name: group.name, isDefault: group.isDefault, createdAt: group.createdAt.toISOString(), updatedAt: group.updatedAt.toISOString() };
}
function publicPool(pool: typeof runnerPools.$inferSelect): TenantGroupPool {
  return { id: pool.id, name: pool.name, groupId: pool.groupId, isDefault: pool.isDefault,
    runtimeUrl: pool.runtimeUrl, publicUrl: pool.publicUrl, desiredReplicas: pool.desiredReplicas,
    safeRpsPerRunner: pool.safeRpsPerRunner, maxConcurrencyPerRunner: pool.maxConcurrencyPerRunner };
}
