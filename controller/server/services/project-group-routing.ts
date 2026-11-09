import { projectPoolAllocation } from "./runner-allocation.js";
import { asc, eq } from "drizzle-orm";
import type { ControllerConfig } from "../config.js";
import type { ControllerDatabase } from "../db/client.js";
import { guardrails, policyRecords, policyResources, policyResourceValidations, runnerPools, projects } from "../db/schema.js";
import { ControllerError } from "../domain/errors.js";

/** Resolves allocation from trusted persisted project/pool membership, never request headers. */
export class ProjectGroupRouting {
  constructor(private readonly db: ControllerDatabase, private readonly config: ControllerConfig) {}

  async poolsForProject(projectId: string) {
    const [project] = await this.db.select({ groupId: projects.groupId }).from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project) throw new ControllerError("The project has no Runner group assignment.", 503, "project_group_unavailable");
    return this.db.select({ pool: runnerPools }).from(runnerPools).innerJoin(projects, projectPoolAllocation)
      .where(eq(projects.id, projectId)).orderBy(asc(runnerPools.id)).then(rows => rows.map(row => row.pool));
  }

  async poolForProject(projectId: string) {
    const [pool] = await this.poolsForProject(projectId);
    if (!pool) throw new ControllerError("No Runner pool is assigned to this project group.", 503, "project_group_pool_unavailable");
    const runtimeUrl = pool.runtimeUrl ?? (pool.id === "default" ? this.config.runtimeServiceUrl : null);
    if (!runtimeUrl) throw new ControllerError("The project group's Runner pool has no runtime address.", 503, "project_group_pool_unavailable");
    return { poolId: pool.id, groupId: pool.groupId, runtimeUrl,
      publicUrl: pool.publicUrl ?? (pool.id === "default" ? this.config.runtimePublicUrl : runtimeUrl) };
  }

  async poolsForValidation(kind: string, resourceId: string): Promise<string[]> {
    if (kind === "policy.validation_requested" && resourceId.startsWith("policy-job-")) {
      const [job] = await this.db.select({ projectId: policyResourceValidations.projectId }).from(policyResourceValidations).where(eq(policyResourceValidations.id, resourceId));
      if (job?.projectId) return (await this.poolsForProject(job.projectId)).map(pool => pool.id);
      return [];
    }
    let [resource] = kind === "guardrail.validation_requested"
      ? await this.db.select({ projectId: guardrails.projectId }).from(guardrails).where(eq(guardrails.id, resourceId)).limit(1)
      : kind === "policy.validation_requested"
        ? await this.db.select({ projectId: policyRecords.projectId }).from(policyRecords).where(eq(policyRecords.id, resourceId)).limit(1)
        : [];
    if (!resource && kind === "policy.validation_requested") {
      [resource] = await this.db.select({ projectId: policyResources.projectId }).from(policyResources).where(eq(policyResources.id, resourceId)).limit(1);
    }
    if (!resource) return [];
    if (resource.projectId === null) return ["default"]; // Platform deployment preset.
    return (await this.poolsForProject(resource.projectId)).map(pool => pool.id);
  }

  async allowedPoolIds(poolIds: string[], projectId: string): Promise<string[]> {
    if (!poolIds.length) return [];
    const permitted = await this.poolsForProject(projectId);
    const allowed = new Set(permitted.map(pool => pool.id));
    return poolIds.filter(id => allowed.has(id));
  }
}
