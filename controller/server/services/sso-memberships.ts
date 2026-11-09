import { randomUUID } from "node:crypto";
import { and, eq, notInArray } from "drizzle-orm";
import type { ControllerDatabase } from "../db/client.js";
import { auditEvents, projectMembers, session, projects, user } from "../db/schema.js";
import { relayEntitlements, type RelayProjectGrant } from "../sso.js";
import { ControllerError, NotFoundError } from "../domain/errors.js";

type Transaction = Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0];

/** Called only with an ID token just verified by Better Auth's OIDC callback. */
export async function synchronizeSsoMemberships(db: ControllerDatabase, userId: string, claims: unknown, verifiedAt = new Date()) {
  const grants = relayEntitlements(claims);
  await db.transaction(async tx => {
    await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("update");
    await replaceMemberships(tx, userId, grants.projects);
    await tx.update(user).set({ role: grants.platformAdmin ? "admin" : "user", ssoProjectGrants: grants.projects, ssoVerifiedAt: verifiedAt }).where(eq(user.id, userId));
    await tx.insert(auditEvents).values({ id: randomUUID(), projectId: null, actorId: userId,
      kind: "sso.memberships_synchronized", resourceType: "user", resourceId: userId,
      detail: { platformAdmin: grants.platformAdmin, projects: grants.projects } });
  });
}

/** Retry provisioning after an administrator initializes a missing Project.
 * Reuse the latest verified grants without changing the role or login expiry. */
export async function refreshSsoMemberships(db: ControllerDatabase, userId: string) {
  await db.transaction(async tx => {
    const [owner] = await tx.select().from(user).where(eq(user.id, userId)).for("update");
    if (!owner) throw new NotFoundError("User", userId);
    if (!owner.ssoVerifiedAt) return;
    if (owner.ssoVerifiedAt.getTime() < Date.now() - 3600_000) {
      throw new ControllerError("Sign in again to refresh your project access.", 401, "reauthentication_required");
    }
    await replaceMemberships(tx, userId, owner.ssoProjectGrants);
    await tx.insert(auditEvents).values({ id: randomUUID(), projectId: null, actorId: userId,
      kind: "sso.memberships_refreshed", resourceType: "user", resourceId: userId,
      detail: { projects: owner.ssoProjectGrants } });
  });
}

async function replaceMemberships(tx: Transaction, userId: string, grants: RelayProjectGrant[]) {
  const initialized: RelayProjectGrant[] = [];
  for (const grant of grants) {
    const [stored] = await tx.select().from(projects).where(eq(projects.id, grant.projectId)).for("update");
    if (stored?.externalDepartmentId === grant.departmentId) initialized.push(grant);
  }
  // Keycloak is authoritative; local membership cannot retain revoked access.
  await tx.delete(projectMembers).where(eq(projectMembers.userId, userId));
  if (initialized.length) await tx.insert(projectMembers).values(initialized.map(project => ({
    userId, projectId: project.projectId, source: "sso", access: project.access, roles: project.roles,
  })));
  const projectIds = initialized.map(project => project.projectId);
  await tx.update(session).set({ activeProjectId: null }).where(and(eq(session.userId, userId),
    projectIds.length ? notInArray(session.activeProjectId, projectIds) : undefined));
}
