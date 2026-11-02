import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, isNull, or, sql, type AnyColumn, type SQL } from "drizzle-orm";

import type { ControllerDatabase } from "../db/client.js";
import {
  endpoints,
  endpointTelemetryContexts,
  guardrails,
  modelDefinitions,
  policyImportedVersions,
  policyRecords,
  policyResources,
  playgroundInvocations,
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

/** Resolve provenance from an Endpoint or a Controller-minted invocation.
 * Missing or conflicting provenance is NULL (visible only to platform operators).
 * A Guardrail's owner is not necessarily the caller when it is shared. */
export function runtimeEventTenantId(event: { requestId: string; occurredAt: Date; endpointId?: string | null | undefined; routerId?: string | null | undefined; guardrailId?: string | null | undefined; guardrailVersion?: string | null | undefined; allocationContextId?: string | null | undefined; metadata: Record<string, unknown> }, authenticatedPoolId?: string): SQL<string | null> {
  const endpointId = event.endpointId ?? null;
  const routerId = event.routerId ?? null;
  const protocol = event.metadata.protocol ?? null;
  const draftCost = event.metadata.costOnly === true && event.metadata.costSource === "testing";
  const context = endpointTelemetryContexts;
  const metadata = JSON.stringify(event.metadata);
  return sql<string | null>`case
    when exists (select 1 from ${playgroundInvocations} where ${playgroundInvocations.callId} = ${event.requestId})
      or ${protocol}::text = 'playground'
      or (${event.requestId} like 'playground:%' and ${draftCost}) then (
      select ${playgroundInvocations.tenantId} from ${playgroundInvocations}
      where ${playgroundInvocations.callId} = ${event.requestId}
        and (${authenticatedPoolId ?? null}::text is null or ${playgroundInvocations.poolId} = ${authenticatedPoolId ?? null})
        and ${playgroundInvocations.guardrailId} = ${event.guardrailId ?? null}
        and (${event.guardrailVersion ?? null}::text is null or ${playgroundInvocations.guardrailVersion} = ${event.guardrailVersion ?? null})
        -- Tolerate bounded Runner clock skew; the unpredictable call ID is
        -- generated and stored before Runner dispatch.
        and ${event.occurredAt} >= ${playgroundInvocations.createdAt} - interval '5 minutes'
        and ${event.occurredAt} <= ${playgroundInvocations.expiresAt}
        and ${endpointId}::text is null and ${routerId}::text is null
        and (${protocol}::text = 'playground' or ${draftCost})
    )
    when ${authenticatedPoolId ?? null}::text is not null and ${endpointId}::text is not null then (
      select ${context.tenantId} from ${context}
      where ${context.id} = ${event.allocationContextId ?? null}
        and ${context.poolId} = ${authenticatedPoolId ?? null}
        and ${context.endpointId} = ${endpointId}
        and ((${context.adapter} = 'litellm-generic-guardrail' and ${protocol}::text in ('litellm', 'litellm-stream'))
          or (${context.adapter} = 'f5-scan' and ${protocol}::text = 'scan'))
        and ${event.occurredAt} >= ${context.issuedAt} - interval '5 minutes'
        and ${event.occurredAt} <= clock_timestamp() + interval '5 minutes'
        and ${event.occurredAt} >= clock_timestamp() - interval '30 days'
        and (${context.retiredAt} is null or ${event.occurredAt} <= ${context.retiredAt} + interval '10 minutes')
        and (${routerId}::text is null or ${context.routerId} = ${routerId})
        and ((${event.guardrailId ?? null}::text is null and ${event.guardrailVersion ?? null}::text is null)
          or (${context.routerId} = ${routerId}
            and ${context.routerRevision}::text = ${metadata}::jsonb->>'routerRevision'
            and exists (select 1 from jsonb_array_elements(${context.targets}) target
              where target->>'guardrailId' = ${event.guardrailId ?? null}
                and target->>'guardrailVersion' = ${event.guardrailVersion ?? null}
                and target->>'routeId' = ${metadata}::jsonb->>'routeId'
                and target->>'targetId' = ${metadata}::jsonb->>'targetId')))
    )
    when ${authenticatedPoolId ?? null}::text is null and ${endpointId}::text is not null then (
      select ${endpoints.tenantId} from ${endpoints}
      where ${endpoints.id} = ${endpointId}
        and (${routerId}::text is null or exists (select 1 from ${trafficRouters}
          where ${trafficRouters.id} = ${routerId} and ${trafficRouters.tenantId} = ${endpoints.tenantId}))
    )
    else null end`;
}

export function resourceReadPredicate(
  kind: ShareableResourceType,
  idColumn: AnyColumn,
  ownerColumn: AnyColumn,
): SQL | undefined {
  const tenantId = currentTenantId();
  if (!tenantId) return undefined;
  const access = or(
    eq(ownerColumn, tenantId),
    // Match the current owner too, so a stale grant cannot follow a moved ID.
    sql`exists (select 1 from ${resourceShares}
      where ${resourceShares.resourceType} = ${kind}
        and ${resourceShares.resourceId} = ${idColumn}
        and ${resourceShares.ownerTenantId} = ${ownerColumn}
        and ${resourceShares.recipientTenantId} = ${tenantId})`,
  );
  // A Policy ID can exist in several current/legacy root tables. A share or
  // ownership of just one root must not expose another owner's identity.
  return kind === "policy" ? and(access, policyOwnershipPredicate(idColumn, ownerColumn)) : access;
}

/** All existing Policy representations must agree with this root's owner. */
export function policyOwnershipPredicate(idColumn: AnyColumn, ownerColumn: AnyColumn): SQL {
  // Explicit aliases avoid shadowing the outer table when a root is selected.
  return sql`NOT EXISTS (SELECT 1 FROM policy_resource AS policy_identity_resource
      WHERE policy_identity_resource.id = ${idColumn} AND policy_identity_resource.tenant_id IS DISTINCT FROM ${ownerColumn})
    AND NOT EXISTS (SELECT 1 FROM policy_record AS policy_identity_record
      WHERE policy_identity_record.id = ${idColumn} AND policy_identity_record.tenant_id IS DISTINCT FROM ${ownerColumn})
    AND NOT EXISTS (SELECT 1 FROM policy_imported_version AS policy_identity_import
      WHERE policy_identity_import.policy_id = ${idColumn} AND policy_identity_import.tenant_id IS DISTINCT FROM ${ownerColumn})`;
}

export function policyWritePredicate(idColumn: AnyColumn, ownerColumn: AnyColumn): SQL | undefined {
  const tenantId = currentTenantId();
  return tenantId ? and(eq(ownerColumn, tenantId), policyOwnershipPredicate(idColumn, ownerColumn)) : undefined;
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
    case "policy": {
      // One Policy ID can have roots in multiple legacy/current tables. Read
      // all owners in one snapshot and never authorize an ambiguous identity.
      const result = await db.execute<{ tenant_id: string }>(sql`
        SELECT ${policyResources.tenantId} AS tenant_id FROM ${policyResources} WHERE ${policyResources.id} = ${id}
        UNION
        SELECT ${policyRecords.tenantId} AS tenant_id FROM ${policyRecords} WHERE ${policyRecords.id} = ${id}
        UNION
        SELECT ${policyImportedVersions.tenantId} AS tenant_id FROM ${policyImportedVersions} WHERE ${policyImportedVersions.policyId} = ${id}`);
      return result.rows.length === 1 ? result.rows[0]!.tenant_id : null;
    }
    case "model": return (await db.select({ tenantId: modelDefinitions.tenantId }).from(modelDefinitions).where(eq(modelDefinitions.id, id)).limit(1))[0]?.tenantId ?? null;
  }
}
