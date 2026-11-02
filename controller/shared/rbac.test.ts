import { describe, expect, it } from "vitest";
import { accountRoles, hasPermission, permissionResources, pagePermission, roleHome } from "./rbac.js";
import { allowsTokenPermission, effectiveTokenPermissions, tokenModules } from "./access-tokens.js";

describe("Account RBAC", () => {
  it("defines exactly admin and user", () => expect(accountRoles).toEqual(["admin", "user"]));
  it.each(["guardrails", "policies", "playground", "routers", "endpoints"] as const)("lets users read and write %s", resource => {
    expect(hasPermission("user", resource, "read")).toBe(true);
    expect(hasPermission("user", resource, "write")).toBe(true);
  });
  it.each(["models", "audit", "settings", "users"] as const)("reserves %s for administrators", resource => {
    expect(hasPermission("user", resource)).toBe(false);
    expect(hasPermission("user", resource, "write")).toBe(false);
    expect(hasPermission("admin", resource)).toBe(true);
  });
  it.each(["guardrails", "policies", "playground", "routers", "endpoints"] as const)("prevents admin from configuring %s", resource => {
    expect(hasPermission("admin", resource, "write")).toBe(false);
  });
  it.each(["/guardrails", "/guardrails/id", "/playground", "/policy-library", "/integration/routers", "/integration/routers/id", "/integration/endpoints", "/logs", "/billing"])("reserves the %s workspace for users", path => {
    const permission = pagePermission(path)!;
    expect(hasPermission("admin", permission.resource, permission.action)).toBe(false);
    expect(hasPermission("user", permission.resource, permission.action)).toBe(true);
  });
  it.each(["admin", "user"])("allows %s to manage Runners without changing platform authority", role => {
    expect(hasPermission(role, "runners", "read")).toBe(true);
    expect(hasPermission(role, "runners", "write")).toBe(true);
    expect(hasPermission(role, "settings", "write")).toBe(role === "admin");
    for (const path of ["/settings", "/settings/health", "/settings/runner", "/settings/version", "/settings/runner/"]) {
      expect(pagePermission(path)).toEqual({ resource: "runners", action: "read" });
    }
  });
  it("lands each role in its own workspace", () => {
    expect(roleHome("admin")).toBe("/settings/providers");
    expect(roleHome("user")).toBe("/guardrails");
  });
  it.each([undefined, null, "", "member", "viewer", "user,admin"])("denies unknown role %s", role => {
    for (const resource of permissionResources) expect(hasPermission(role, resource)).toBe(false);
  });
  it("reserves runtime logs and captured content for users, with read-only access", () => {
    expect(hasPermission("user", "runtime")).toBe(true);
    expect(hasPermission("user", "runtime", "write")).toBe(false);
    expect(hasPermission("admin", "runtime")).toBe(false);
  });
  it.each(["/dashboard", "/dashboard/"])("protects the dashboard at %s with runtime read permission", path => {
    const permission = pagePermission(path)!;
    expect(permission).toEqual({ resource: "runtime", action: "read" });
    expect(hasPermission("user", permission.resource, permission.action)).toBe(true);
    for (const role of ["admin", "unknown", null]) {
      expect(hasPermission(role, permission.resource, permission.action)).toBe(false);
    }
  });
  it.each(["/settings/models", "/settings/models/", "/settings/guardrail-catalog", "/access", "/audit-log"])("protects direct page access to %s", path => {
    const permission = pagePermission(path)!;
    expect(hasPermission("user", permission.resource, permission.action)).toBe(false);
  });
  it("intersects token grants with the current role, including reads after demotion", () => {
    const grants = { models: "write", routers: "write", audit: "read", runtime: "read" } as const;
    expect(effectiveTokenPermissions(grants, "user")).toEqual({ routers: "write", runtime: "read" });
    expect(allowsTokenPermission(grants, "models", "read", "user")).toBe(false);
    expect(allowsTokenPermission(grants, "routers", "write", "user")).toBe(true);
    expect(effectiveTokenPermissions(grants, "admin")).toEqual({ models: "write", routers: "read", audit: "read" });
    expect(allowsTokenPermission(grants, "routers", "write", "admin")).toBe(false);
    expect(allowsTokenPermission({ routers: "read" }, "routers", "write", "user")).toBe(false);
    for (const module of tokenModules) expect(allowsTokenPermission({ [module]: "write" }, module, "write", "unknown")).toBe(false);
  });
});
