import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, isNull, or, sql, type AnyColumn, type SQL } from "drizzle-orm";

import type { ControllerDatabase } from "../db/client.js";
import {
  endpoints,
  guardrails,
  modelDefinitions,
  policyImportedVersions,
  policyRecords,
  policyResources,
  resourceShares,
  trafficRouters,
} from "../db/schema.js";
import type { AccountRole } from "../../shared/rbac.js";
import { ControllerError, NotFoundError, ValidationError } from "../domain/errors.js";

export const LEGACY_TENANT_ID = "tenantA";

export type ShareableResourceType = "guardrail" | "router" | "endpoint" | "policy" | "model";

export type TenantContext = { tenantId: string; actorId?: string; role?: AccountRole };

const requestTenant = new AsyncLocalStorage<TenantContext>();

/** A missing context identifies trusted startup, Runner, and migration work. */
export function runWithTenantContext<T>(context: TenantContext, callback: () => T): T {
  if (!context.tenantId) throw new ValidationError("A tenant ID is required.");
  return requestTenant.run(context, callback);
}

export function currentTenantId(): string | null {
  const context = requestTenant.getStore();
  return context?.role === "admin" ? null : context?.tenantId ?? null;
}

export function currentAccountRole(): AccountRole | null {
  return requestTenant.getStore()?.role ?? null;
}

export function assertPlatformAuthority(): void {
  if (currentTenantId()) throw new ControllerError("Platform administrator access is required.", 403, "forbidden");
}

export function tenantOwnerForCreate(): string {
  return currentTenantId() ?? LEGACY_TENANT_ID;
}

/** Attribute telemetry to the caller boundary, even when a Guardrail is shared. */
export function runtimeEventTenantId(event: { endpointId?: string | null | undefined; routerId?: string | null | undefined; guardrailId?: string | null | undefined }): SQL<string> {
  return sql<string>`coalesce(
    (select ${endpoints.tenantId} from ${endpoints} where ${endpoints.id} = ${event.endpointId ?? null}),
    (select ${trafficRouters.tenantId} from ${trafficRouters} where ${trafficRouters.id} = ${event.routerId ?? null}),
    (select ${guardrails.tenantId} from ${guardrails} where ${guardrails.id} = ${event.guardrailId ?? null}), 'tenantA')`;
}

export function resourceReadPredicate(
  kind: ShareableResourceType,
  idColumn: AnyColumn,
  ownerColumn: AnyColumn,
): SQL | undefined {
  const tenantId = currentTenantId();
  if (!tenantId) return undefined;
  return or(
    eq(ownerColumn, tenantId),
    // Match the current owner too, so a stale grant cannot follow a moved ID.
    sql`exists (select 1 from ${resourceShares}
      where ${resourceShares.resourceType} = ${kind}
        and ${resourceShares.resourceId} = ${idColumn}
        and ${resourceShares.ownerTenantId} = ${ownerColumn}
        and ${resourceShares.recipientTenantId} = ${tenantId})`,
  );
}

export function resourceWritePredicate(ownerColumn: AnyColumn): SQL | undefined {
  const tenantId = currentTenantId();
  return tenantId ? eq(ownerColumn, tenantId) : undefined;
}

export async function assertResourceOwner(db: ControllerDatabase, kind: ShareableResourceType, id: string): Promise<void> {
  const tenantId = currentTenantId();
  if (!tenantId) throw new ValidationError("Tenant context is required to manage shares.");
  const owner = await resourceOwner(db, kind, id);
  if (owner !== tenantId) throw new NotFoundError(kind, id);
}

export async function assertResourceWriteAccess(db: ControllerDatabase, kind: ShareableResourceType, id: string): Promise<void> {
  const tenantId = currentTenantId();
  if (tenantId && await resourceOwner(db, kind, id) !== tenantId) throw new NotFoundError(kind, id);
}

export async function assertResourceReadAccess(db: ControllerDatabase, kind: ShareableResourceType, id: string): Promise<void> {
  const tenantId = currentTenantId();
  if (!tenantId) return;
  const ownerTenantId = await resourceOwner(db, kind, id);
  if (!ownerTenantId) throw new NotFoundError(kind, id);
  if (ownerTenantId === tenantId) return;
  const [grant] = await db.select({ id: resourceShares.id }).from(resourceShares).where(and(
    eq(resourceShares.ownerTenantId, ownerTenantId),
    eq(resourceShares.recipientTenantId, tenantId),
    eq(resourceShares.resourceType, kind),
    eq(resourceShares.resourceId, id),
  )).limit(1);
  if (!grant) throw new NotFoundError(kind, id);
}

export async function resourceOwner(db: ControllerDatabase, kind: ShareableResourceType, id: string): Promise<string | null> {
  switch (kind) {
    case "guardrail": return (await db.select({ tenantId: guardrails.tenantId }).from(guardrails).where(and(eq(guardrails.id, id), isNull(guardrails.deletedAt))).limit(1))[0]?.tenantId ?? null;
    case "router": return (await db.select({ tenantId: trafficRouters.tenantId }).from(trafficRouters).where(and(eq(trafficRouters.id, id), isNull(trafficRouters.deletedAt))).limit(1))[0]?.tenantId ?? null;
    case "endpoint": return (await db.select({ tenantId: endpoints.tenantId }).from(endpoints).where(and(eq(endpoints.id, id), isNull(endpoints.deletedAt))).limit(1))[0]?.tenantId ?? null;
    case "policy": return (await db.select({ tenantId: policyResources.tenantId }).from(policyResources).where(eq(policyResources.id, id)).limit(1))[0]?.tenantId ?? (await db.select({ tenantId: policyRecords.tenantId }).from(policyRecords).where(eq(policyRecords.id, id)).limit(1))[0]?.tenantId ?? (await db.select({ tenantId: policyImportedVersions.tenantId }).from(policyImportedVersions).where(eq(policyImportedVersions.policyId, id)).limit(1))[0]?.tenantId ?? null;
    case "model": return (await db.select({ tenantId: modelDefinitions.tenantId }).from(modelDefinitions).where(eq(modelDefinitions.id, id)).limit(1))[0]?.tenantId ?? null;
  }
}
