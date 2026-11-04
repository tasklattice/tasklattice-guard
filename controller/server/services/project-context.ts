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
import type { AccountRole, AuthorityContext, AuthorityScope } from "../../shared/rbac.js";
import { ControllerError, NotFoundError, ValidationError } from "../domain/errors.js";

export type ShareableResourceType = "guardrail" | "router" | "endpoint" | "policy" | "model";

export type ProjectContext = { projectId: string | null; actorId?: string; role?: AccountRole };

const requestProject = new AsyncLocalStorage<AuthorityContext>();

/** A missing context identifies trusted startup, Runner, and migration work. */
export function runWithProjectContext<T>(context: ProjectContext, callback: () => T): T {
  if (!context.projectId && context.role !== "admin") throw new ValidationError("A project ID is required.");
  return requestProject.run(context.role === "admin"
    ? { scope: "platform", role: "admin", ...(context.actorId ? { actorId: context.actorId } : {}) }
    : { ...context, scope: "project", projectId: context.projectId! }, callback);
}

export function currentProjectId(): string | null {
  const context = requestProject.getStore();
  if (context?.scope === "user") throw new ControllerError("Project authority is required for this resource.", 403, "project_required");
  return context?.scope === "project" ? context.projectId : null;
}

/** Personal account operations never inherit platform or project resource access. */
export function runWithUserContext<T>(actorId: string, role: AccountRole, callback: () => T): T {
  return requestProject.run({ scope: "user", actorId, role }, callback);
}

export function currentAuthorityScope(): AuthorityScope | null {
  return requestProject.getStore()?.scope ?? null;
}

export function currentAccountRole(): AccountRole | null {
  return requestProject.getStore()?.role ?? null;
}

export function assertPlatformAuthority(): void {
  if (currentProjectId()) throw new ControllerError("Platform administrator access is required.", 403, "forbidden");
}

export function projectOwnerForCreate(): string {
  const projectId = currentProjectId();
  if (!projectId) throw new ControllerError("Select an initialized project before creating resources.", 403, "project_required");
  return projectId;
}

/** Resolve provenance from an Endpoint or a Controller-minted invocation.
 * Missing or conflicting provenance is NULL (visible only to platform operators).
 * A Guardrail's owner is not necessarily the caller when it is shared. */
export function runtimeEventProjectId(event: { requestId: string; occurredAt: Date; endpointId?: string | null | undefined; routerId?: string | null | undefined; guardrailId?: string | null | undefined; guardrailVersion?: string | null | undefined; allocationContextId?: string | null | undefined; metadata: Record<string, unknown> }, authenticatedPoolId?: string): SQL<string | null> {
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
      select ${playgroundInvocations.projectId} from ${playgroundInvocations}
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
      select ${context.projectId} from ${context}
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
      select ${endpoints.projectId} from ${endpoints}
      where ${endpoints.id} = ${endpointId}
        and (${routerId}::text is null or exists (select 1 from ${trafficRouters}
          where ${trafficRouters.id} = ${routerId} and ${trafficRouters.projectId} = ${endpoints.projectId}))
    )
    else null end`;
}

export function resourceReadPredicate(
  kind: ShareableResourceType,
  idColumn: AnyColumn,
  ownerColumn: AnyColumn,
): SQL | undefined {
  const projectId = currentProjectId();
  if (!projectId) return undefined;
  const access = or(
    eq(ownerColumn, projectId),
    // Match the current owner too, so a stale grant cannot follow a moved ID.
    sql`exists (select 1 from ${resourceShares}
      where ${resourceShares.resourceType} = ${kind}
        and ${resourceShares.resourceId} = ${idColumn}
        and ${resourceShares.ownerProjectId} = ${ownerColumn}
        and ${resourceShares.recipientProjectId} = ${projectId})`,
  );
  // A Policy ID can exist in several current/legacy root tables. A share or
  // ownership of just one root must not expose another owner's identity.
  return kind === "policy" ? and(access, policyOwnershipPredicate(idColumn, ownerColumn)) : access;
}

/** All existing Policy representations must agree with this root's owner. */
export function policyOwnershipPredicate(idColumn: AnyColumn, ownerColumn: AnyColumn): SQL {
  // Explicit aliases avoid shadowing the outer table when a root is selected.
  return sql`NOT EXISTS (SELECT 1 FROM policy_resource AS policy_identity_resource
      WHERE policy_identity_resource.id = ${idColumn} AND policy_identity_resource.project_id IS DISTINCT FROM ${ownerColumn})
    AND NOT EXISTS (SELECT 1 FROM policy_record AS policy_identity_record
      WHERE policy_identity_record.id = ${idColumn} AND policy_identity_record.project_id IS DISTINCT FROM ${ownerColumn})
    AND NOT EXISTS (SELECT 1 FROM policy_imported_version AS policy_identity_import
      WHERE policy_identity_import.policy_id = ${idColumn} AND policy_identity_import.project_id IS DISTINCT FROM ${ownerColumn})`;
}

export function policyWritePredicate(idColumn: AnyColumn, ownerColumn: AnyColumn): SQL | undefined {
  const projectId = currentProjectId();
  return projectId ? and(eq(ownerColumn, projectId), policyOwnershipPredicate(idColumn, ownerColumn)) : undefined;
}

export function resourceWritePredicate(ownerColumn: AnyColumn): SQL | undefined {
  const projectId = currentProjectId();
  return projectId ? eq(ownerColumn, projectId) : undefined;
}

export async function assertResourceOwner(db: ControllerDatabase, kind: ShareableResourceType, id: string): Promise<void> {
  const projectId = currentProjectId();
  if (!projectId) throw new ValidationError("Project context is required to manage shares.");
  const owner = await resourceOwner(db, kind, id);
  if (owner !== projectId) throw new NotFoundError(kind, id);
}

export async function assertResourceWriteAccess(db: ControllerDatabase, kind: ShareableResourceType, id: string): Promise<void> {
  const projectId = currentProjectId();
  if (projectId && await resourceOwner(db, kind, id) !== projectId) throw new NotFoundError(kind, id);
}

export async function assertResourceReadAccess(db: ControllerDatabase, kind: ShareableResourceType, id: string): Promise<void> {
  const projectId = currentProjectId();
  if (!projectId) return;
  const ownerProjectId = await resourceOwner(db, kind, id);
  if (!ownerProjectId) throw new NotFoundError(kind, id);
  if (ownerProjectId === projectId) return;
  const [grant] = await db.select({ id: resourceShares.id }).from(resourceShares).where(and(
    eq(resourceShares.ownerProjectId, ownerProjectId),
    eq(resourceShares.recipientProjectId, projectId),
    eq(resourceShares.resourceType, kind),
    eq(resourceShares.resourceId, id),
  )).limit(1);
  if (!grant) throw new NotFoundError(kind, id);
}

export async function resourceOwner(db: ControllerDatabase, kind: ShareableResourceType, id: string): Promise<string | null> {
  switch (kind) {
    case "guardrail": return (await db.select({ projectId: guardrails.projectId }).from(guardrails).where(and(eq(guardrails.id, id), isNull(guardrails.deletedAt))).limit(1))[0]?.projectId ?? null;
    case "router": return (await db.select({ projectId: trafficRouters.projectId }).from(trafficRouters).where(and(eq(trafficRouters.id, id), isNull(trafficRouters.deletedAt))).limit(1))[0]?.projectId ?? null;
    case "endpoint": return (await db.select({ projectId: endpoints.projectId }).from(endpoints).where(and(eq(endpoints.id, id), isNull(endpoints.deletedAt))).limit(1))[0]?.projectId ?? null;
    case "policy": {
      // One Policy ID can have roots in multiple legacy/current tables. Read
      // all owners in one snapshot and never authorize an ambiguous identity.
      const result = await db.execute<{ project_id: string }>(sql`
        SELECT ${policyResources.projectId} AS project_id FROM ${policyResources} WHERE ${policyResources.id} = ${id}
        UNION
        SELECT ${policyRecords.projectId} AS project_id FROM ${policyRecords} WHERE ${policyRecords.id} = ${id}
        UNION
        SELECT ${policyImportedVersions.projectId} AS project_id FROM ${policyImportedVersions} WHERE ${policyImportedVersions.policyId} = ${id}`);
      return result.rows.length === 1 ? result.rows[0]!.project_id : null;
    }
    case "model": return (await db.select({ projectId: modelDefinitions.projectId }).from(modelDefinitions).where(eq(modelDefinitions.id, id)).limit(1))[0]?.projectId ?? null;
  }
}
