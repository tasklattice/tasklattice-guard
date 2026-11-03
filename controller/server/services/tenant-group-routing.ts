import { asc, eq } from "drizzle-orm";
import type { ControllerConfig } from "../config.js";
import type { ControllerDatabase } from "../db/client.js";
import { guardrails, policyRecords, policyResources, runnerPools, tenants } from "../db/schema.js";
import { ControllerError } from "../domain/errors.js";

/** Resolves allocation from trusted persisted tenant/pool membership, never request headers. */
export class TenantGroupRouting {
  constructor(private readonly db: ControllerDatabase, private readonly config: ControllerConfig) {}

  async poolsForTenant(tenantId: string) {
    const [tenant] = await this.db.select({ groupId: tenants.groupId }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!tenant) throw new ControllerError("The tenant has no Runner group assignment.", 503, "tenant_group_unavailable");
    return this.db.select().from(runnerPools).where(eq(runnerPools.groupId, tenant.groupId)).orderBy(asc(runnerPools.id));
  }

  async poolForTenant(tenantId: string) {
    const pools = await this.poolsForTenant(tenantId);
    // Keep the pre-existing default pool as the primary route for the legacy group.
    const pool = pools.find(item => item.id === "default") ?? pools[0];
    if (!pool) throw new ControllerError("No Runner pool is assigned to this tenant group.", 503, "tenant_group_pool_unavailable");
    const runtimeUrl = pool.runtimeUrl ?? (pool.id === "default" ? this.config.runtimeServiceUrl : null);
    if (!runtimeUrl) throw new ControllerError("The tenant group's Runner pool has no runtime address.", 503, "tenant_group_pool_unavailable");
    return { poolId: pool.id, groupId: pool.groupId, runtimeUrl,
      publicUrl: pool.publicUrl ?? (pool.id === "default" ? this.config.runtimePublicUrl : runtimeUrl) };
  }

  async poolsForValidation(kind: string, resourceId: string): Promise<string[]> {
    let [resource] = kind === "guardrail.validation_requested"
      ? await this.db.select({ tenantId: guardrails.tenantId }).from(guardrails).where(eq(guardrails.id, resourceId)).limit(1)
      : kind === "policy.validation_requested"
        ? await this.db.select({ tenantId: policyRecords.tenantId }).from(policyRecords).where(eq(policyRecords.id, resourceId)).limit(1)
        : [];
    if (!resource && kind === "policy.validation_requested") {
      [resource] = await this.db.select({ tenantId: policyResources.tenantId }).from(policyResources).where(eq(policyResources.id, resourceId)).limit(1);
    }
    if (!resource) return [];
    return (await this.poolsForTenant(resource.tenantId)).map(pool => pool.id);
  }

  async allowedPoolIds(poolIds: string[], tenantId: string): Promise<string[]> {
    if (!poolIds.length) return [];
    const permitted = await this.poolsForTenant(tenantId);
    const allowed = new Set(permitted.map(pool => pool.id));
    return poolIds.filter(id => allowed.has(id));
  }
}
