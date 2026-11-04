import {directoryPage, searchPattern, type DirectoryQuery} from "../../shared/directory.js";
import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, ilike, ne, inArray, isNull } from "drizzle-orm";

import type { ControllerDatabase } from "../db/client.js";
import { advisoryTransactionLock } from "../db/postgres-locks.js";
import {
  auditEvents, endpoints, guardrails, guardrailVersions, modelConfigurationRevisions, modelDefinitions, policyImportedVersions, policyRecords, policyResources,
  resourceShares, projects, trafficRouters,
} from "../db/schema.js";
import { ConflictError, NotFoundError, ValidationError } from "../domain/errors.js";
import { assignedModelIds, normalizeModelAssignments } from "../model-config/domain.js";
import { assertResourceOwner, currentProjectId, type ShareableResourceType } from "./project-context.js";

export type ShareInput = {
  resourceType: ShareableResourceType;
  resourceId: string;
  recipientProjectId: string;
};

/** Sharing is an explicit, revocable, read-only grant on one root resource. */
export class ProjectShareService {
  constructor(private readonly db: ControllerDatabase) {}

  private projectId(): string {
    const projectId = currentProjectId();
    if (!projectId) throw new ValidationError("Project context is required to manage shares.");
    return projectId;
  }

  async assertOwner(resourceType: ShareableResourceType, resourceId: string): Promise<void> {
    this.projectId();
    await assertResourceOwner(this.db, resourceType, resourceId);
  }

  async listProjects(query: DirectoryQuery) {
    const rows = await this.db.select({id:projects.id,name:projects.name}).from(projects).where(and(ne(projects.id,this.projectId()), query.cursor ? gt(projects.id,query.cursor) : undefined, query.q ? ilike(projects.name,searchPattern(query.q)) : undefined)).orderBy(projects.id).limit(query.limit+1);
    return directoryPage(rows,query.limit,row=>row.id);
  }

  async listOwnedResources() {
    const projectId = this.projectId();
    const [policies, guardrailRows, endpointRows, routerRows, models, declarative, imported] = await Promise.all([
      this.db.select({ resourceId: policyRecords.id, name: policyRecords.name }).from(policyRecords).where(eq(policyRecords.projectId, projectId)),
      this.db.select({ resourceId: guardrails.id, name: guardrails.name }).from(guardrails).where(and(eq(guardrails.projectId, projectId), isNull(guardrails.deletedAt))),
      this.db.select({ resourceId: endpoints.id, name: endpoints.name }).from(endpoints).where(and(eq(endpoints.projectId, projectId), isNull(endpoints.deletedAt))),
      this.db.select({ resourceId: trafficRouters.id, name: trafficRouters.name }).from(trafficRouters).where(and(eq(trafficRouters.projectId, projectId), isNull(trafficRouters.deletedAt))),
      this.db.select({ resourceId: modelDefinitions.id, name: modelDefinitions.name }).from(modelDefinitions).where(eq(modelDefinitions.projectId, projectId)),
      this.db.select({ resourceId: policyResources.id, name: policyResources.definition }).from(policyResources).where(eq(policyResources.projectId, projectId)),
      this.db.select({ resourceId: policyImportedVersions.policyId, definition: policyImportedVersions.definition }).from(policyImportedVersions).where(eq(policyImportedVersions.projectId, projectId)),
    ]);
    const resources = [
      ...imported.map(row => ({ resourceId: row.resourceId, name: typeof row.definition.name === "string" ? row.definition.name : row.resourceId, resourceType: "policy" as const })),
      ...declarative.map(row => ({ resourceId: row.resourceId, name: row.name.metadata.name, resourceType: "policy" as const })),
      ...policies.map(row => ({ ...row, resourceType: "policy" as const })),
      ...guardrailRows.map(row => ({ ...row, resourceType: "guardrail" as const })),
      ...endpointRows.map(row => ({ ...row, resourceType: "endpoint" as const })),
      ...routerRows.map(row => ({ ...row, resourceType: "router" as const })),
      ...models.map(row => ({ ...row, resourceType: "model" as const })),
    ];
    return [...new Map(resources.map(row => [`${row.resourceType}:${row.resourceId}`, row])).values()].sort((a, b) => a.resourceType.localeCompare(b.resourceType) || a.name.localeCompare(b.name));
  }

  async listShares() {
    return this.db.select({
      id: resourceShares.id,
      resourceType: resourceShares.resourceType,
      resourceId: resourceShares.resourceId,
      recipientProjectId: resourceShares.recipientProjectId,
      createdAt: resourceShares.createdAt,
    }).from(resourceShares).where(eq(resourceShares.ownerProjectId, this.projectId())).orderBy(asc(resourceShares.createdAt));
  }

  async createShare(input: ShareInput, actorId: string) {
    const ownerProjectId = this.projectId();
    if (input.recipientProjectId === ownerProjectId) throw new ValidationError("A project cannot share a resource with itself.");
    await assertResourceOwner(this.db, input.resourceType, input.resourceId);
    const [recipient] = await this.db.select({ id: projects.id }).from(projects).where(eq(projects.id, input.recipientProjectId)).limit(1);
    if (!recipient) throw new NotFoundError("Project", input.recipientProjectId);
    const [created] = await this.db.transaction(async tx => {
      const [grant] = await tx.insert(resourceShares).values({
        id: randomUUID(), ownerProjectId, recipientProjectId: recipient.id,
        resourceType: input.resourceType, resourceId: input.resourceId, createdBy: actorId,
      }).onConflictDoNothing().returning();
      if (grant) await tx.insert(auditEvents).values({
        id: randomUUID(), projectId: ownerProjectId, kind: "resource.shared", actorId,
        resourceType: input.resourceType, resourceId: input.resourceId,
        detail: { recipientProjectId: recipient.id, shareId: grant.id },
      });
      return [grant];
    });
    if (created) return created;
    const [existing] = await this.db.select().from(resourceShares).where(and(
      eq(resourceShares.ownerProjectId, ownerProjectId),
      eq(resourceShares.recipientProjectId, recipient.id),
      eq(resourceShares.resourceType, input.resourceType),
      eq(resourceShares.resourceId, input.resourceId),
    )).limit(1);
    return existing!;
  }

  async revokeShare(id: string, actorId: string): Promise<void> {
    const ownerProjectId = this.projectId();
    await this.db.transaction(async tx => {
      // Router publication uses this lock. Check its executable snapshot
      // before withdrawing a Guardrail that another project still runs.
      await advisoryTransactionLock(tx, "traffic-router-bindings");
      const [grant] = await tx.select().from(resourceShares).where(and(
        eq(resourceShares.id, id), eq(resourceShares.ownerProjectId, ownerProjectId),
      )).for("update");
      if (!grant) throw new NotFoundError("Share", id);
      if (grant.resourceType === "guardrail") {
        const published = await tx.select({ activeSnapshot: trafficRouters.activeSnapshot }).from(trafficRouters).where(and(
          eq(trafficRouters.projectId, grant.recipientProjectId), isNull(trafficRouters.deletedAt),
        ));
        if (published.some(router => router.activeSnapshot?.routes.some(route =>
          route.targets.some(target => target.guardrailId === grant.resourceId)))) {
          throw new ConflictError("Remove this Guardrail from the recipient's active Routers before revoking its share.", "share_in_use");
        }
      }
      if (grant.resourceType === "policy") {
        const versions = await tx.select({ sourceSnapshot: guardrailVersions.sourceSnapshot })
          .from(guardrailVersions).innerJoin(guardrails, eq(guardrails.id, guardrailVersions.guardrailId))
          .where(and(eq(guardrails.projectId, grant.recipientProjectId), isNull(guardrails.deletedAt),
            inArray(guardrailVersions.status, ["pending", "ready"])));
        if (versions.some(version => version.sourceSnapshot?.draftConfig.policyBindings.some(binding =>
          binding.policyId === grant.resourceId))) {
          throw new ConflictError("Remove the recipient's published Guardrail versions that use this Policy before revoking its share.", "share_in_use");
        }
      }
      if (grant.resourceType === "model") {
        const revisions = await tx.select({ assignments: modelConfigurationRevisions.assignments })
          .from(modelConfigurationRevisions).where(and(
            eq(modelConfigurationRevisions.projectId, grant.recipientProjectId),
            inArray(modelConfigurationRevisions.state, ["validated", "activating", "active"]),
          ));
        const assigned = new Set(revisions.flatMap(revision => assignedModelIds(normalizeModelAssignments(revision.assignments))));
        if (assigned.has(grant.resourceId)) {
          throw new ConflictError("Remove this Model from the recipient's validated and active configurations before revoking its share.", "share_in_use");
        }
      }
      const [removed] = await tx.delete(resourceShares).where(eq(resourceShares.id, grant.id)).returning();
      if (!removed) throw new NotFoundError("Share", id);
      await tx.insert(auditEvents).values({
        id: randomUUID(), projectId: ownerProjectId, kind: "resource.share_revoked", actorId,
        resourceType: removed.resourceType, resourceId: removed.resourceId,
        detail: { recipientProjectId: removed.recipientProjectId, shareId: removed.id },
      });
    });
  }
}
