import { randomUUID } from "node:crypto";
import { and, eq, gt, ilike, or, sql } from "drizzle-orm";
import type { ControllerDatabase } from "../db/client.js";
import {
  account,
  auditEvents,
  projectMembers,
  runnerPools,
  session,
  projectGroups,
  projects,
  user,
} from "../db/schema.js";
import { ControllerError, NotFoundError } from "../domain/errors.js";
import {
  createProjectSchema,
  type ProjectAccessStatus,
} from "../../shared/projects.js";
import { refreshSsoMemberships } from "./sso-memberships.js";
import {
  directoryPage,
  searchPattern,
  type DirectoryQuery,
} from "../../shared/directory.js";
import { SSO_PROVIDER_ID } from "../sso-config.js";
import { projectPoolAllocation } from "./runner-allocation.js";
import { advisoryTransactionLock } from "../db/postgres-locks.js";
import { projectNameSchema } from "../../shared/runner-naming.js";

type Transaction = Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0];

export class ProjectService {
  constructor(
    private readonly db: ControllerDatabase,
    private readonly provisionDefault: (tx: Transaction, projectId: string) => Promise<void>,
    private readonly defaultRuntimeUrl?: string,
  ) {}

  /** Explicit bootstrap target only; ordinary onboarding never grants membership. */
  async ensureBootstrapMembership(username: string, projectName: string) {
    const name = projectNameSchema.parse(projectName);
    return this.db.transaction(async (tx) => {
      await advisoryTransactionLock(tx, "traffic-router-bindings");
      const [member] = await tx.select({ id: user.id, role: user.role }).from(user)
        .where(eq(user.username, username)).for("update");
      if (!member || member.role !== "user") throw new Error("Bootstrap Project requires a local business user.");
      const [external] = await tx.select({ id: account.id }).from(account)
        .where(and(eq(account.userId, member.id), eq(account.providerId, SSO_PROVIDER_ID))).limit(1);
      if (external) throw new Error("Manage SSO Project membership in Keycloak.");
      await tx.insert(projects).values({ id: name, name, groupId: "default" }).onConflictDoNothing();
      const [project] = await tx.select({ id: projects.id, groupId: projects.groupId }).from(projects)
        .where(eq(projects.name, name)).for("update");
      if (!project) throw new Error("Bootstrap Project name conflicts with an existing ID.");
      const [dedicated] = await tx.select({ id: runnerPools.id }).from(runnerPools)
        .where(eq(runnerPools.projectId, project.id)).limit(1);
      if (project.groupId !== "default" || dedicated) {
        throw new Error("Bootstrap Project must use the default shared Runner pool.");
      }
      await this.provisionDefault(tx, project.id);
      const added = await tx.insert(projectMembers).values({ projectId: project.id, userId: member.id })
        .onConflictDoNothing().returning({ userId: projectMembers.userId });
      if (added.length) await tx.insert(auditEvents).values({
        id: randomUUID(), projectId: project.id, actorId: member.id,
        kind: "project.member_added", resourceType: "project", resourceId: project.id,
        detail: { userId: member.id, source: "bootstrap" },
      });
    });
  }

  async runnerInitialized(projectId: string): Promise<boolean> {
    const pools = await this.db
      .select({ id: runnerPools.id, runtimeUrl: runnerPools.runtimeUrl })
      .from(projects)
      .innerJoin(runnerPools, projectPoolAllocation)
      .where(eq(projects.id, projectId));
    return pools.some((pool) =>
      Boolean(
        pool.runtimeUrl || (pool.id === "default" && this.defaultRuntimeUrl),
      ),
    );
  }

  async accessStatus(
    userId: string,
    projectId: string | null,
  ): Promise<ProjectAccessStatus> {
    const [membership] = projectId
      ? await this.db
          .select({ id: projectMembers.projectId })
          .from(projectMembers)
          .where(
            and(
              eq(projectMembers.userId, userId),
              eq(projectMembers.projectId, projectId),
            ),
          )
          .limit(1)
      : [];
    const { rows: missingProjects } = await this.db.execute<{
      projectId: string;
      departmentId: string;
    }>(sql`
      select grants.value->>'projectId' as "projectId",grants.value->>'departmentId' as "departmentId"
      from ${user} u cross join lateral jsonb_array_elements(u.sso_project_grants) as grants(value)
      where u.id=${userId} and not exists(select 1 from ${projectMembers} m where m.user_id=u.id and m.project_id=grants.value->>'projectId')
      order by grants.value->>'projectId' limit 25`);
    const state = !membership
      ? missingProjects.length
        ? "project_missing"
        : "project_required"
      : (await this.runnerInitialized(projectId!))
        ? "ready"
        : "runner_uninitialized";
    return { state, projectId, missingProjects };
  }

  async refreshAccess(userId: string, sessionId: string) {
    await refreshSsoMemberships(this.db, userId);
    const [active] = await this.db
      .select({ projectId: session.activeProjectId })
      .from(session)
      .where(and(eq(session.id, sessionId), eq(session.userId, userId)));
    const current = active?.projectId
      ? await this.membership(userId, active.projectId)
      : null;
    const [first] = current
      ? []
      : await this.db
          .select({ id: projectMembers.projectId })
          .from(projectMembers)
          .where(eq(projectMembers.userId, userId))
          .orderBy(projectMembers.projectId)
          .limit(1);
    const projectId = current?.projectId ?? first?.id ?? null;
    if (projectId) await this.select(userId, sessionId, projectId);
    return this.accessStatus(userId, projectId);
  }

  async requireExists(projectId: string): Promise<void> {
    const [project] = await this.db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project) throw new NotFoundError("Project", projectId);
  }

  async list(
    query: DirectoryQuery & {
      groupId?: string | undefined;
      withoutPool?: boolean;
    },
    userId?: string,
  ) {
    const rows = await this.db
      .select({
        id: projects.id,
        name: projects.name,
        groupId: projects.groupId,
        externalDepartmentId: projects.externalDepartmentId,
        groupName: projectGroups.name,
        poolId: runnerPools.id,
        poolName: runnerPools.name,
        memberCount: sql<number>`(select count(*)::int from ${projectMembers} m where m.project_id=${projects.id})`,
      })
      .from(projects)
      .innerJoin(projectGroups, eq(projectGroups.id, projects.groupId))
      .leftJoin(runnerPools, projectPoolAllocation)
      .where(
        and(
          query.cursor ? gt(projects.id, query.cursor) : undefined,
          query.q ? ilike(projects.name, searchPattern(query.q)) : undefined,
          query.groupId ? eq(projects.groupId, query.groupId) : undefined,
          query.withoutPool
            ? sql`not exists(select 1 from runner_pool p where p.project_id=${projects.id})`
            : undefined,
          userId
            ? sql`exists(select 1 from ${projectMembers} m where m.project_id=${projects.id} and m.user_id=${userId})`
            : undefined,
        ),
      )
      .orderBy(projects.id)
      .limit(query.limit + 1);
    return directoryPage(rows, query.limit, (row) => row.id);
  }

  async membership(userId: string, projectId: string) {
    return (
      await this.db
        .select()
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.userId, userId),
            eq(projectMembers.projectId, projectId),
          ),
        )
        .limit(1)
    )[0];
  }

  async create(actorId: string, raw: unknown) {
    const input = createProjectSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await advisoryTransactionLock(tx, "traffic-router-bindings");
      const [group] = await tx
        .select({ id: projectGroups.id })
        .from(projectGroups)
        .where(eq(projectGroups.id, input.groupId))
        .limit(1);
      if (!group) throw new NotFoundError("Project group", input.groupId);
      const id = input.name;
      const [project] = await tx
        .insert(projects)
        .values({ ...input, id })
        .onConflictDoNothing()
        .returning();
      if (!project)
        throw new ControllerError(
          "Project name or ID already exists.",
          409,
          "project_exists",
        );
      await this.provisionDefault(tx, id);
      await tx
        .insert(auditEvents)
        .values({
          id: randomUUID(),
          projectId: id,
          actorId,
          kind: "project.created",
          resourceType: "project",
          resourceId: id,
          detail: { name: input.name },
        });
      return { id: project.id, name: project.name, groupId: project.groupId };
    });
  }

  async members(projectId: string, query: DirectoryQuery) {
    const rows = await this.db
      .select({
        userId: user.id,
        username: user.username,
        email: user.email,
        source: sql<string>`case when exists(select 1 from ${account} a where a.user_id=${user.id} and a.provider_id=${SSO_PROVIDER_ID}) then 'sso' else 'local' end`,
        access: projectMembers.access,
        roles: projectMembers.roles,
      })
      .from(projectMembers)
      .innerJoin(user, eq(user.id, projectMembers.userId))
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          query.cursor ? gt(user.id, query.cursor) : undefined,
          query.q
            ? or(
                ilike(user.username, searchPattern(query.q)),
              )
            : undefined,
        ),
      )
      .orderBy(user.id)
      .limit(query.limit + 1);
    return directoryPage(rows, query.limit, (row) => row.userId);
  }

  async memberCandidates(projectId: string, query: DirectoryQuery) {
    const rows = await this.db
      .select({ id: user.id, username: user.username })
      .from(user)
      .where(
        and(
          eq(user.role, "user"),
          eq(user.banned, false),
          query.cursor ? gt(user.id, query.cursor) : undefined,
          query.q
            ? or(
                ilike(user.username, searchPattern(query.q)),
              )
            : undefined,
          sql`not exists(select 1 from ${account} a where a.user_id=${user.id} and a.provider_id=${SSO_PROVIDER_ID})`,
          sql`not exists(select 1 from ${projectMembers} m where m.user_id=${user.id} and m.project_id=${projectId})`,
        ),
      )
      .orderBy(user.id)
      .limit(query.limit + 1);
    return directoryPage(rows, query.limit, (row) => row.id);
  }

  async setMember(
    actorId: string,
    projectId: string,
    userId: string,
    enabled: boolean,
  ) {
    await this.db.transaction(async (tx) => {
      const [project] = await tx
        .select()
        .from(projects)
        .where(eq(projects.id, projectId))
        .for("update");
      const [member] = await tx
        .select()
        .from(user)
        .where(eq(user.id, userId))
        .for("update");
      if (!project || !member)
        throw new NotFoundError("Project or user", projectId);
      const [external] = await tx
        .select({ id: account.id })
        .from(account)
        .where(
          and(
            eq(account.userId, userId),
            eq(account.providerId, SSO_PROVIDER_ID),
          ),
        )
        .limit(1);
      if (external)
        throw new ControllerError(
          "Manage SSO project membership in Keycloak.",
          403,
          "sso_managed_membership",
        );
      if (enabled && member.role !== "user")
        throw new ControllerError(
          "Only human business accounts can join a project.",
          400,
          "invalid_project_member",
        );
      if (enabled)
        await tx
          .insert(projectMembers)
          .values({ projectId, userId })
          .onConflictDoNothing();
      else {
        await tx
          .delete(projectMembers)
          .where(
            and(
              eq(projectMembers.projectId, projectId),
              eq(projectMembers.userId, userId),
            ),
          );
        await tx
          .update(session)
          .set({ activeProjectId: null })
          .where(
            and(
              eq(session.userId, userId),
              eq(session.activeProjectId, projectId),
            ),
          );
      }
      await tx
        .insert(auditEvents)
        .values({
          id: randomUUID(),
          projectId: projectId,
          actorId,
          kind: enabled ? "project.member_added" : "project.member_removed",
          resourceType: "project",
          resourceId: projectId,
          detail: { userId },
        });
    });
  }

  async select(userId: string, sessionId: string, projectId: string) {
    // The conditional write also checks membership: a concurrent revocation
    // cannot grant access merely by leaving a stale selection in a session.
    const rows = await this.db
      .update(session)
      .set({ activeProjectId: projectId })
      .where(
        and(
          eq(session.id, sessionId),
          eq(session.userId, userId),
          sql`exists (
        select 1 from ${projectMembers} where ${projectMembers.userId} = ${userId} and ${projectMembers.projectId} = ${projectId})`,
        ),
      )
      .returning({ id: session.id });
    if (!rows.length)
      throw new ControllerError(
        "You are not a member of this project.",
        403,
        "project_access_denied",
      );
  }
}
