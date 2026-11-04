import {
  directoryPage,
  searchPattern,
  type DirectoryQuery,
} from "../../shared/directory.js";
import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, ilike, ne, sql, type SQL } from "drizzle-orm";
import type { ControllerDatabase } from "../db/client.js";
import {
  auditEvents,
  controllerState,
  outboxEvents,
  runnerInstances,
  runnerPools,
  runnerServingGrants,
  projectGroups,
  projects,
} from "../db/schema.js";
import { advisoryTransactionLock } from "../db/postgres-locks.js";
import { increment } from "../db/postgres-expressions.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../domain/errors.js";
import { assertPlatformAuthority } from "./project-context.js";
import { retireEndpointTelemetryContexts } from "./endpoint-telemetry-contexts.js";
import { projectPoolAllocation } from "./runner-allocation.js";
import { runnerPoolName } from "../../shared/runner-naming.js";
import {
  DEFAULT_PROJECT_GROUP_ID,
  createGroupPoolSchema,
  createProjectGroupSchema,
  projectGroupAssignmentSchema,
  projectRunnerConfigurationSchema,
  type ProjectRunnerView,
  projectGroupIdSchema,
  updatePoolConnectivitySchema,
  updateProjectGroupSchema,
  type ProjectGroupPool,
  type ProjectGroupView,
} from "../../shared/project-groups.js";

type Transaction = Parameters<
  Parameters<ControllerDatabase["transaction"]>[0]
>[0];
const bindingsLock = "traffic-router-bindings";

/** Platform allocation, independent of project read-sharing and resource ownership. */
export class ProjectGroupService {
  constructor(
    private readonly db: ControllerDatabase,
    private readonly experimentalLeaseGrants = false,
  ) {}

  private summaryColumns() {
    return {
      id: projectGroups.id,
      name: projectGroups.name,
      isDefault: projectGroups.isDefault,
      createdAt: projectGroups.createdAt,
      updatedAt: projectGroups.updatedAt,
      projectCount: sql<number>`(select count(*)::int from ${projects} p where p.group_id=project_group.id)`,
      poolCount: sql<number>`(select count(*)::int from ${runnerPools} p where p.group_id=project_group.id)`,
    };
  }
  async list(query: DirectoryQuery) {
    assertPlatformAuthority();
    const rows = await this.db
      .select(this.summaryColumns())
      .from(projectGroups)
      .where(
        and(
          query.cursor ? gt(projectGroups.id, query.cursor) : undefined,
          query.q
            ? ilike(projectGroups.name, searchPattern(query.q))
            : undefined,
        ),
      )
      .orderBy(projectGroups.id)
      .limit(query.limit + 1);
    return directoryPage(
      rows.map((row) => ({
        ...publicGroup(row),
        projectCount: row.projectCount,
        poolCount: row.poolCount,
      })),
      query.limit,
      (row) => row.id,
    );
  }
  async get(id: string) {
    assertPlatformAuthority();
    const [row] = await this.db
      .select(this.summaryColumns())
      .from(projectGroups)
      .where(eq(projectGroups.id, id))
      .limit(1);
    if (!row) throw new NotFoundError("Project group", id);
    return {
      ...publicGroup(row),
      projectCount: row.projectCount,
      poolCount: row.poolCount,
    };
  }
  async pools(groupId: string, query: DirectoryQuery) {
    assertPlatformAuthority();
    const rows = await this.db
      .select({
        pool: runnerPools,
        connectedCount: sql<number>`(select count(*)::int from ${runnerInstances} r where r.pool_id=${runnerPools.id} and r.status<>'offline')`,
      })
      .from(runnerPools)
      .where(
        and(
          eq(runnerPools.groupId, groupId),
          query.cursor ? gt(runnerPools.id, query.cursor) : undefined,
          query.q ? ilike(runnerPools.name, searchPattern(query.q)) : undefined,
        ),
      )
      .orderBy(runnerPools.id)
      .limit(query.limit + 1);
    return directoryPage(
      rows.map((row) => ({
        ...publicPool(row.pool),
        connectedCount: row.connectedCount,
      })),
      query.limit,
      (row) => row.id,
    );
  }

  // Summary first; Runner connectivity and authorization scope are fetched on demand.
  async projectRunner(id: string): Promise<ProjectRunnerView> {
    assertPlatformAuthority();
    const [row] = await this.db.select({
      projectId: projects.id, projectName: projects.name, groupId: projects.groupId,
      pool: runnerPools,
      connectedCount: sql<number>`(select count(*)::int from ${runnerInstances} r where r.pool_id=${runnerPools.id} and r.status<>'offline')`,
      projectCount: sql<number>`(select count(*)::int from ${projects} p where p.group_id=${projects.groupId})`,
      poolCount: sql<number>`(select count(*)::int from ${runnerPools} p where p.group_id=${projects.groupId})`,
    }).from(projects).leftJoin(runnerPools, projectPoolAllocation)
      .where(eq(projects.id, id)).limit(1);
    if (!row) throw new NotFoundError("Project", id);
    return {
      projectId: row.projectId, projectName: row.projectName, groupId: row.groupId,
      pool: row.pool ? { ...publicPool(row.pool), connectedCount: row.connectedCount } : null,
      modelScope: { projectCount: row.projectCount, poolCount: row.poolCount },
    };
  }

  async configureProjectRunner(id: string, raw: unknown, actorId: string) {
    assertPlatformAuthority();
    const input = projectRunnerConfigurationSchema.parse(raw);
    await this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, bindingsLock);
      const [project] = await tx.select().from(projects).where(eq(projects.id, id)).for("update");
      if (!project) throw new NotFoundError("Project", id);
      this.checkExpectedGroup(project.groupId, input.expectedGroupId);
      const [current] = await tx.select({ pool: runnerPools }).from(projects)
        .innerJoin(runnerPools, projectPoolAllocation).where(eq(projects.id, id));
      if ((current?.pool.id ?? null) !== input.expectedPoolId)
        throw new ConflictError("Runner allocation changed. Reload before saving.", "runner_allocation_conflict");
      if (current?.pool.projectId) {
        // A dedicated pool has immutable ownership. Connectivity can be edited separately.
        throw new ConflictError("This Project already has a dedicated Runner. Edit its connection settings instead.", "runner_pool_exists");
      }
      if (input.mode === "shared" && current?.pool.id === "default") return;
      await this.assertOffline(tx, eq(runnerPools.groupId, project.groupId));
      const sourcePools = await tx.select({ id: runnerPools.id }).from(runnerPools)
        .where(eq(runnerPools.groupId, project.groupId));
      await retireEndpointTelemetryContexts(tx, sourcePools.map(pool => pool.id));
      let groupId = "default";
      let poolId = "default";
      if (input.mode === "dedicated") {
        const [otherProject] = await tx.select({ id: projects.id }).from(projects)
          .where(and(eq(projects.groupId, project.groupId), ne(projects.id, id))).limit(1);
        // Reuse an existing exclusive scope (and its grants); never broaden a shared grant.
        groupId = project.groupId;
        if (groupId === "default" || otherProject || sourcePools.length) {
          groupId = `group-${randomUUID()}`;
          await tx.insert(projectGroups).values({ id: groupId, name: project.name });
        }
        poolId = project.name;
        const [pool] = await tx.insert(runnerPools).values({
          id: poolId, name: runnerPoolName(project.name), projectId: id, groupId,
          runtimeUrl: input.runtimeUrl, publicUrl: input.publicUrl,
          desiredReplicas: 1, safeRpsPerRunner: 50, maxConcurrencyPerRunner: 64,
        }).onConflictDoNothing().returning({ id: runnerPools.id });
        if (!pool) throw new ConflictError("The dedicated Runner pool already exists.", "runner_pool_exists");
      } else {
        const pool = await this.lockPool(tx, "default");
        if (pool.groupId !== "default") throw new ValidationError("The default Runner pool is not initialized.");
      }
      await tx.update(projects).set({ groupId }).where(eq(projects.id, id));
      const detail = { previousGroupId: project.groupId, groupId, poolId, mode: input.mode };
      const generation = await this.advance(tx, "project", id, detail);
      await this.audit(tx, actorId, "project.runner_configured", "project", id, { ...detail, generation });
    });
    return this.projectRunner(id);
  }

  async create(raw: unknown, actorId: string): Promise<ProjectGroupView> {
    assertPlatformAuthority();
    const input = createProjectGroupSchema.parse(raw);
    const id = input.id ?? `group-${randomUUID()}`;
    return this.db.transaction(async (tx) => {
      const [group] = await tx
        .insert(projectGroups)
        .values({ id, name: input.name })
        .onConflictDoNothing()
        .returning();
      if (!group)
        throw new ConflictError(
          "This Project Group ID already exists.",
          "project_group_exists",
        );
      await this.audit(
        tx,
        actorId,
        "project_group.created",
        "project_group",
        id,
        { name: input.name },
      );
      return { ...publicGroup(group), projectCount: 0, poolCount: 0 };
    });
  }

  async update(id: string, raw: unknown, actorId: string) {
    assertPlatformAuthority();
    projectGroupIdSchema.parse(id);
    const input = updateProjectGroupSchema.parse(raw);
    await this.db.transaction(async (tx) => {
      const [group] = await tx
        .update(projectGroups)
        .set({ name: input.name, updatedAt: new Date() })
        .where(eq(projectGroups.id, id))
        .returning();
      if (!group) throw new NotFoundError("Project Group", id);
      await this.audit(
        tx,
        actorId,
        "project_group.updated",
        "project_group",
        id,
        { name: input.name },
      );
    });
    return this.get(id);
  }

  async remove(id: string, actorId: string): Promise<void> {
    assertPlatformAuthority();
    projectGroupIdSchema.parse(id);
    await this.db.transaction(async (tx) => {
      await advisoryTransactionLock(tx, bindingsLock);
      const group = await this.lockGroup(tx, id);
      if (group.isDefault || id === DEFAULT_PROJECT_GROUP_ID)
        throw new ConflictError(
          "The Default Project Group cannot be deleted.",
          "default_project_group_protected",
        );
      const [member] = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.groupId, id))
        .limit(1);
      const [pool] = await tx
        .select({ id: runnerPools.id })
        .from(runnerPools)
        .where(eq(runnerPools.groupId, id))
        .limit(1);
      if (member || pool)
        throw new ConflictError(
          "Move every Project and Runner pool out of this group before deleting it.",
          "project_group_in_use",
        );
      await tx.delete(projectGroups).where(eq(projectGroups.id, id));
      await this.audit(
        tx,
        actorId,
        "project_group.deleted",
        "project_group",
        id,
        { name: group.name },
      );
    });
  }

  async assignProject(id: string, raw: unknown, actorId: string) {
    assertPlatformAuthority();
    const input = projectGroupAssignmentSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await advisoryTransactionLock(tx, bindingsLock);
      await this.lockGroup(tx, input.groupId);
      const [project] = await tx
        .select()
        .from(projects)
        .where(eq(projects.id, id))
        .for("update");
      if (!project) throw new NotFoundError("Project", id);
      this.checkExpectedGroup(project.groupId, input.expectedGroupId);
      if (project.groupId === input.groupId)
        return {
          id: project.id,
          name: project.name,
          groupId: project.groupId,
          generation: await this.generation(tx),
        };
      this.assertReassignmentAvailable();
      await this.assertNoGrantHistory(
        tx,
        eq(runnerPools.groupId, project.groupId),
      );
      const [live] = await tx
        .select({ id: runnerInstances.runnerId })
        .from(runnerInstances)
        .innerJoin(runnerPools, eq(runnerPools.id, runnerInstances.poolId))
        .where(
          and(
            eq(runnerPools.groupId, project.groupId),
            ne(runnerInstances.status, "offline"),
          ),
        )
        .limit(1);
      if (live)
        throw new ConflictError(
          "Stop the old group's Runners and wait until every registration is offline before moving this Project. This prevents stale Runner state from retaining the Project's Endpoints.",
          "project_group_runners_active",
          { groupId: project.groupId },
        );
      const sourcePools = await tx
        .select({ id: runnerPools.id })
        .from(runnerPools)
        .where(eq(runnerPools.groupId, project.groupId));
      await retireEndpointTelemetryContexts(
        tx,
        sourcePools.map((pool) => pool.id),
      );
      await tx
        .update(projects)
        .set({ groupId: input.groupId })
        .where(eq(projects.id, id));
      // Dedicated capacity follows its immutable Project identity.
      await tx
        .update(runnerPools)
        .set({ groupId: input.groupId, updatedAt: new Date() })
        .where(eq(runnerPools.projectId, id));
      const generation = await this.advance(tx, "project", id, {
        previousGroupId: project.groupId,
        groupId: input.groupId,
      });
      await this.audit(tx, actorId, "project.group_assigned", "project", id, {
        previousGroupId: project.groupId,
        groupId: input.groupId,
        generation,
      });
      return {
        id: project.id,
        name: project.name,
        groupId: input.groupId,
        generation,
      };
    });
  }

  async createPool(groupId: string, raw: unknown, actorId: string) {
    assertPlatformAuthority();
    projectGroupIdSchema.parse(groupId);
    const input = createGroupPoolSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await advisoryTransactionLock(tx, bindingsLock);
      await this.lockGroup(tx, groupId);
      const [project] = await tx
        .select()
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .for("update");
      if (!project) throw new NotFoundError("Project", input.projectId);
      if (project.groupId !== groupId)
        throw new ValidationError(
          "Register dedicated Runners in the Project's runtime group.",
        );
      await this.assertOffline(tx, eq(runnerPools.groupId, groupId));
      const [pool] = await tx
        .insert(runnerPools)
        .values({
          id: project.name,
          name: runnerPoolName(project.name),
          projectId: project.id,
          groupId,
          runtimeUrl: input.runtimeUrl,
          publicUrl: input.publicUrl ?? null,
          desiredReplicas: 1,
          safeRpsPerRunner: 50,
          maxConcurrencyPerRunner: 64,
        })
        .onConflictDoNothing()
        .returning();
      if (!pool)
        throw new ConflictError(
          "This Project already has a dedicated Runner pool, or its pool ID is in use.",
          "runner_pool_exists",
        );
      const generation = await this.advance(tx, "runner_pool", pool.id, {
        groupId,
      });
      await this.audit(
        tx,
        actorId,
        "runner_pool.registered",
        "runner_pool",
        pool.id,
        {
          groupId,
          projectId: pool.projectId,
          name: pool.name,
          runtimeUrl: pool.runtimeUrl,
          publicUrl: pool.publicUrl,
          generation,
        },
      );
      return { ...publicPool(pool), generation };
    });
  }

  async updateConnectivity(id: string, raw: unknown, actorId: string) {
    assertPlatformAuthority();
    const input = updatePoolConnectivitySchema.parse(raw);
    if (id !== "default" && input.runtimeUrl === null)
      throw new ValidationError(
        "A non-default Runner pool requires an explicit runtime URL.",
      );
    return this.db.transaction(async (tx) => {
      await advisoryTransactionLock(tx, bindingsLock);
      const pool = await this.lockPool(tx, id);
      if (
        pool.runtimeUrl === input.runtimeUrl &&
        pool.publicUrl === input.publicUrl
      )
        return { ...publicPool(pool), generation: await this.generation(tx) };
      const [updated] = await tx
        .update(runnerPools)
        .set({
          runtimeUrl: input.runtimeUrl,
          publicUrl: input.publicUrl,
          updatedAt: new Date(),
        })
        .where(eq(runnerPools.id, id))
        .returning();
      const generation = await this.advance(tx, "runner_pool", id, {
        connectivityChanged: true,
      });
      await this.audit(
        tx,
        actorId,
        "runner_pool.connectivity_updated",
        "runner_pool",
        id,
        {
          projectId: updated!.projectId,
          previousProjectId: pool.projectId,
          runtimeUrl: input.runtimeUrl,
          publicUrl: input.publicUrl,
          previousRuntimeUrl: pool.runtimeUrl,
          previousPublicUrl: pool.publicUrl,
          generation,
        },
      );
      return { ...publicPool(updated!), generation };
    });
  }

  private checkExpectedGroup(current: string, expected: string) {
    if (current !== expected)
      throw new ConflictError(
        "The group assignment changed. Reload its current allocation before trying again.",
        "project_group_assignment_conflict",
        { expectedGroupId: expected, currentGroupId: current },
      );
  }
  private async assertOffline(tx: Transaction, predicate: SQL) {
    const [live] = await tx
      .select({ id: runnerInstances.runnerId })
      .from(runnerInstances)
      .innerJoin(runnerPools, eq(runnerPools.id, runnerInstances.poolId))
      .where(and(predicate, ne(runnerInstances.status, "offline")))
      .limit(1);
    if (live)
      throw new ConflictError(
        "Stop this group's Runners and wait until registrations are offline before changing dedicated allocation.",
        "project_group_runners_active",
      );
    this.assertReassignmentAvailable();
    await this.assertNoGrantHistory(tx, predicate);
  }
  private assertReassignmentAvailable() {
    // An offline registration is not proof that an old lease or workload has
    // stopped. Until moves participate in durable drain/epoch coordination,
    // experimental grants must not be combined with immediate reassignment.
    if (this.experimentalLeaseGrants)
      throw new ConflictError(
        "Project and pool reassignment is unavailable while experimental Runner lease grants are enabled. Lease-aware drain and allocation transitions are not implemented yet.",
        "runner_lease_reassignment_unavailable",
      );
  }
  private async assertNoGrantHistory(tx: Transaction, affectedPool: SQL) {
    const [grant] = await tx
      .select({ poolId: runnerServingGrants.poolId })
      .from(runnerServingGrants)
      .innerJoin(runnerPools, eq(runnerPools.id, runnerServingGrants.poolId))
      .where(affectedPool)
      .limit(1);
    // Disabling the experiment must not bypass grants already issued. Without
    // a verified drain/epoch protocol, a DB-clock expiry is insufficient proof
    // that old work stopped; retain history and refuse the move conservatively.
    if (grant)
      throw new ConflictError(
        "Reassignment is unavailable because an affected pool has Runner lease grant history. Lease-aware drain and allocation transitions are required before moving it.",
        "runner_lease_reassignment_unavailable",
      );
  }
  private async lockGroup(tx: Transaction, id: string) {
    const [group] = await tx
      .select()
      .from(projectGroups)
      .where(eq(projectGroups.id, id))
      .for("update");
    if (!group) throw new NotFoundError("Project Group", id);
    return group;
  }
  private async lockPool(tx: Transaction, id: string) {
    const [pool] = await tx
      .select()
      .from(runnerPools)
      .where(eq(runnerPools.id, id))
      .for("update");
    if (!pool) throw new NotFoundError("Runner Pool", id);
    return pool;
  }
  private async generation(tx: Transaction) {
    const [state] = await tx
      .select({ generation: controllerState.desiredGeneration })
      .from(controllerState)
      .where(eq(controllerState.id, "singleton"));
    return state?.generation ?? 0;
  }
  private async advance(
    tx: Transaction,
    resourceType: string,
    resourceId: string,
    detail: Record<string, unknown>,
  ) {
    const [state] = await tx
      .update(controllerState)
      .set({
        desiredGeneration: increment(controllerState.desiredGeneration),
        updatedAt: new Date(),
      })
      .where(eq(controllerState.id, "singleton"))
      .returning();
    if (!state) throw new Error("Controller state is not initialized.");
    await tx
      .insert(outboxEvents)
      .values({
        id: randomUUID(),
        kind: "runner.desired_state_changed",
        aggregateId: resourceId,
        payload: {
          resourceType,
          resourceId,
          generation: state.desiredGeneration,
          ...detail,
        },
      });
    return state.desiredGeneration;
  }
  private async audit(
    tx: Transaction,
    actorId: string,
    kind: string,
    resourceType: string,
    resourceId: string,
    detail: Record<string, unknown>,
  ) {
    await tx
      .insert(auditEvents)
      .values({
        id: randomUUID(),
        actorId,
        kind,
        resourceType,
        resourceId,
        detail,
      });
  }
}

function publicGroup(group: typeof projectGroups.$inferSelect) {
  return {
    id: group.id,
    name: group.name,
    isDefault: group.isDefault,
    createdAt: group.createdAt.toISOString(),
    updatedAt: group.updatedAt.toISOString(),
  };
}
function publicPool(pool: typeof runnerPools.$inferSelect): ProjectGroupPool {
  return {
    id: pool.id,
    name: pool.name,
    projectId: pool.projectId,
    groupId: pool.groupId,
    isDefault: pool.isDefault,
    runtimeUrl: pool.runtimeUrl,
    publicUrl: pool.publicUrl,
    desiredReplicas: pool.desiredReplicas,
    safeRpsPerRunner: pool.safeRpsPerRunner,
    maxConcurrencyPerRunner: pool.maxConcurrencyPerRunner,
  };
}
