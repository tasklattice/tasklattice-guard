/** Authority boundaries; these are scopes, not three mutually exclusive human roles. */
export const authorityScopes = ["platform", "project", "user"] as const;
export type AuthorityScope = typeof authorityScopes[number];
export type AuthorityContext =
  | { scope: "platform"; actorId?: string; role: "admin" }
  | { scope: "project"; projectId: string; actorId?: string; role?: AccountRole }
  | { scope: "user"; actorId: string; role: AccountRole };

/** Account authority shared by the API, browser and personal access tokens. */
export const accountRoles = ["admin", "user"] as const;
export type AccountRole = typeof accountRoles[number];
export type AccessAction = "read" | "write";
export const permissionResources = ["guardrails", "policies", "playground", "routers", "endpoints", "models", "runners", "runtime", "audit", "providers", "modelConfiguration", "modelPricing", "projects", "projectGroups", "users"] as const;
export type PermissionResource = typeof permissionResources[number];

/** Write includes read. Missing entries deny access. */
export const rolePermissions: Readonly<Record<AccountRole, Readonly<Partial<Record<PermissionResource, AccessAction>>>>> = {
  admin: {
    guardrails: "read", policies: "read", playground: "read", routers: "read", endpoints: "read",
    models: "write", runners: "write", providers: "write", modelConfiguration: "write", modelPricing: "write",
    projects: "write", projectGroups: "write", users: "write",
    audit: "read",
  },
  user: {
    guardrails: "write", policies: "write", playground: "write", routers: "write", endpoints: "write",
    models: "write", providers: "read", modelConfiguration: "read", runtime: "read", runners: "read",
  },
};

export function isAccountRole(role: string | null | undefined): role is AccountRole {
  return role === "admin" || role === "user";
}

export function accountPermission(role: string | null | undefined, resource: PermissionResource): AccessAction | null {
  return isAccountRole(role) ? rolePermissions[role][resource] ?? null : null;
}

export function hasPermission(role: string | null | undefined, resource: PermissionResource, action: AccessAction = "read"): boolean {
  const granted = accountPermission(role, resource);
  return granted === "write" || granted === action;
}

export function isPlatformAdministrator(role: string | null | undefined): boolean {
  return role === "admin";
}

export function roleHome(role: string | null | undefined): "/settings/providers" | "/" {
  return isPlatformAdministrator(role) ? "/settings/providers" : "/";
}

export function pagePermission(pathname: string): { resource: PermissionResource; action: AccessAction } | null {
  const path = pathname.replace(/\/$/, "") || "/";
  if (["/settings", "/settings/health", "/settings/runner", "/settings/version"].includes(path)) {
    return { resource: "runners", action: "read" };
  }
  const routes: ReadonlyArray<readonly [string, PermissionResource, AccessAction]> = [
    ["/settings/providers", "providers", "write"], ["/settings/project-groups", "projectGroups", "read"],
    ["/access/projects", "projects", "read"], ["/settings/pricing", "modelPricing", "read"],
    ["/settings", "modelConfiguration", "write"], ["/access", "users", "read"],
    ["/", "runtime", "read"], ["/billing", "runtime", "read"], ["/logs", "runtime", "read"], ["/audit-log", "audit", "read"],
    // Authoring workspaces belong to users; platform configuration retains
    // read access to business metadata without opening these workspaces.
    ["/guardrails", "guardrails", "write"], ["/policy-library", "policies", "write"],
    ["/playground", "playground", "write"], ["/integration/routers", "routers", "write"],
    ["/integration/endpoints", "endpoints", "write"],
    ["/sharing", "guardrails", "write"],
  ];
  const route = routes.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`));
  return route ? { resource: route[1], action: route[2] } : null;
}
