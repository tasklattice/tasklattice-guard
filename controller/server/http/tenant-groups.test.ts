// @vitest-environment node
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Registry } from "prom-client";
import { loadConfig } from "../config.js";
import type { ControllerAuth } from "../auth.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
import type { AccessTokenService } from "../services/access-tokens.js";
import { TenantGroupService } from "../services/tenant-groups.js";
import { runWithTenantContext } from "../services/tenant-context.js";
import { createHttpApp } from "./app.js";

const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://unused:unused@localhost/unused",
  CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/test-key.pem",
  CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"), BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters" });
const routes = [
  ["GET", "/tenant-groups"], ["POST", "/tenant-groups"], ["PATCH", "/tenant-groups/team-a"], ["DELETE", "/tenant-groups/team-a"],
  ["GET", "/tenants"], ["PUT", "/tenants/tenantB/group"], ["POST", "/tenant-groups/team-a/pools"],
  ["PUT", "/runner-pools/pool-a/group"], ["PUT", "/runner-pools/pool-a/connectivity"],
] as const;

function setup(role: string | null = "admin", token?: { role: string; permissions: Record<string, string> }) {
  const groups = { list: vi.fn().mockResolvedValue({ items: [], tenants: [], pools: [] }), listTenants: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ id: "team-a", name: "Team A" }), update: vi.fn().mockResolvedValue({ id: "team-a" }),
    remove: vi.fn().mockResolvedValue(undefined), assignTenant: vi.fn().mockResolvedValue({ id: "tenantB", groupId: "team-a", generation: 2 }),
    createPool: vi.fn().mockResolvedValue({ id: "pool-a", groupId: "team-a", generation: 2 }),
    assignPool: vi.fn().mockResolvedValue({ id: "pool-a", groupId: "team-a", generation: 2 }),
    updateConnectivity: vi.fn().mockResolvedValue({ id: "pool-a", runtimeUrl: "http://pool-a:8091", publicUrl: null, generation: 2 }) };
  const accessTokens = { authenticate: vi.fn().mockResolvedValue(token ? {
    id: "token-actor", tenantId: "tenantB", tokenId: "token", ...token,
  } : null), recordRequest: vi.fn() };
  const app = createHttpApp({ config,
    auth: { api: { getSession: vi.fn().mockResolvedValue(role ? { user: { id: "admin-actor", role, tenantId: "tenantA" } } : null) } } as unknown as ControllerAuth,
    accessTokens: accessTokens as unknown as AccessTokenService,
    service: { tenantGroups: groups } as unknown as ControlPlaneService,
    runnerControl: {} as RunnerControlServer, metrics: { registry: new Registry() } as ControllerMetrics });
  return { app, groups, accessTokens };
}

describe("platform Tenant Group administration", () => {
  it.each([null, "user", "unsupported"])("denies %s before reading allocations or parsing mutations", async role => {
    const { app, groups } = setup(role);
    for (const [method, path] of routes) {
      const response = await app.request(`/api/v1${path}`, { method,
        ...(method === "GET" ? {} : { headers: { "content-type": "application/json" }, body: "not-json" }) });
      expect(response.status).toBe(role ? 403 : 401);
    }
    for (const fn of Object.values(groups)) expect(fn).not.toHaveBeenCalled();
  });

  it("lists platform groups and membership independently of the administrator's tenant field", async () => {
    const { app, groups } = setup();
    expect(await (await app.request("/api/v1/tenant-groups")).json()).toEqual({ items: [], tenants: [], pools: [] });
    expect(await (await app.request("/api/v1/tenants")).json()).toEqual({ items: [] });
    expect(groups.list).toHaveBeenCalledOnce(); expect(groups.listTenants).toHaveBeenCalledOnce();
  });

  it("forwards explicit group creation and stale-assignment protection with the authenticated actor", async () => {
    const { app, groups } = setup();
    const send = (path: string, method: string, body: unknown) => app.request(`/api/v1${path}`, {
      method, headers: { "content-type": "application/json", "x-user-id": "foreign" }, body: JSON.stringify(body) });
    expect((await send("/tenant-groups", "POST", { id: "team-a", name: " Team A " })).status).toBe(201);
    expect(groups.create).toHaveBeenCalledExactlyOnceWith({ id: "team-a", name: "Team A" }, "admin-actor");
    const assignment = { groupId: "team-a", expectedGroupId: "default" };
    expect((await send("/tenants/tenantB/group", "PUT", assignment)).status).toBe(200);
    expect(groups.assignTenant).toHaveBeenCalledExactlyOnceWith("tenantB", assignment, "admin-actor");
    expect((await send("/runner-pools/pool-a/group", "PUT", assignment)).status).toBe(200);
    expect(groups.assignPool).toHaveBeenCalledExactlyOnceWith("pool-a", assignment, "admin-actor");
    expect((await send("/tenant-groups/team-a", "PATCH", { name: "Renamed" })).status).toBe(200);
    expect(groups.update).toHaveBeenCalledExactlyOnceWith("team-a", { name: "Renamed" }, "admin-actor");
    expect((await app.request("/api/v1/tenant-groups/team-a", { method: "DELETE" })).status).toBe(204);
    expect(groups.remove).toHaveBeenCalledExactlyOnceWith("team-a", "admin-actor");
  });

  it("requires an explicit pool runtime origin and normalizes admin-configured connectivity", async () => {
    const { app, groups } = setup();
    const send = (path: string, body: unknown, method = "POST") => app.request(`/api/v1${path}`, {
      method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    for (const runtimeUrl of [undefined, "file:///etc/passwd", "http://user:secret@pool-a:8091", "http://pool-a:8091/path", "http://pool-a:8091?secret=1", "http://pool-a:8091#section"])
      expect((await send("/tenant-groups/team-a/pools", { id: "pool-a", name: "Pool A", runtimeUrl })).status).toBe(400);
    expect(groups.createPool).not.toHaveBeenCalled();
    expect((await send("/tenant-groups/team-a/pools", { id: "pool-a", name: "Pool A", runtimeUrl: "http://pool-a:8091/" })).status).toBe(201);
    expect(groups.createPool).toHaveBeenCalledExactlyOnceWith("team-a", { id: "pool-a", name: "Pool A", runtimeUrl: "http://pool-a:8091" }, "admin-actor");
    expect((await send("/runner-pools/pool-a/connectivity", { runtimeUrl: "https://pool-a:8091/", publicUrl: null }, "PUT")).status).toBe(200);
    expect(groups.updateConnectivity).toHaveBeenCalledExactlyOnceWith("pool-a", { runtimeUrl: "https://pool-a:8091", publicUrl: null }, "admin-actor");
  });

  it("rejects missing expectedGroupId and caller-supplied ownership or role fields", async () => {
    const { app, groups } = setup();
    for (const body of [{ groupId: "team-a" }, { groupId: "team-a", expectedGroupId: "default", tenantId: "tenantA" },
      { groupId: "team-a", expectedGroupId: "default", role: "admin" }]) {
      expect((await app.request("/api/v1/tenants/tenantB/group", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status).toBe(400);
    }
    expect(groups.assignTenant).not.toHaveBeenCalled();
  });

  it("intersects PAT scopes with platform role for allocation mutations", async () => {
    for (const token of [{ role: "user", permissions: { settings: "write" } }, { role: "admin", permissions: { settings: "read" } }]) {
      const { app, groups } = setup("admin", token);
      expect((await app.request("/api/v1/tenant-groups", { method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify({ name: "Group" }) })).status).toBe(403);
      expect(groups.create).not.toHaveBeenCalled();
    }
    const { app, groups, accessTokens } = setup("user", { role: "admin", permissions: { settings: "write" } });
    expect((await app.request("/api/v1/tenant-groups", { method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify({ name: "Group" }) })).status).toBe(201);
    expect(groups.create).toHaveBeenCalledExactlyOnceWith({ name: "Group" }, "token-actor");
    expect(accessTokens.recordRequest).toHaveBeenCalledOnce();
  });

  it("also enforces platform authority in the service before any database work", async () => {
    const service = new TenantGroupService({} as ConstructorParameters<typeof TenantGroupService>[0]);
    const calls = [() => service.list(), () => service.listTenants(), () => service.create({}, "actor"),
      () => service.update("default", {}, "actor"), () => service.remove("default", "actor"),
      () => service.assignTenant("tenantB", {}, "actor"), () => service.assignPool("default", {}, "actor"),
      () => service.createPool("default", {}, "actor"), () => service.updateConnectivity("default", {}, "actor")];
    for (const call of calls) await expect(runWithTenantContext({ role: "user", tenantId: "tenantB" }, call)).rejects.toMatchObject({ status: 403, code: "forbidden" });
  });
});
