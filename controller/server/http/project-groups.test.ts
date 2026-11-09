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
import { ProjectGroupService } from "../services/project-groups.js";
import { runWithProjectContext } from "../services/project-context.js";
import { createHttpApp } from "./app.js";

const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://unused:unused@localhost/unused",
  CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/test-key.pem",
  CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"), BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters" });
const routes = [
  ["GET", "/project-groups"], ["POST", "/project-groups"], ["PATCH", "/project-groups/team-a"], ["DELETE", "/project-groups/team-a"],
  ["GET", "/projects"], ["PUT", "/projects/projectB/group"], ["POST", "/project-groups/team-a/pools"],
  ["PUT", "/runner-pools/pool-a/connectivity"], ["GET", "/projects/projectB/runner"], ["PUT", "/projects/projectB/runner"],
] as const;

function setup(role: string | null = "admin", token?: { role: string; permissions: Record<string, string> }) {
  const groups = { projectRunner: vi.fn().mockResolvedValue({projectId:"projectB",pool:null}), configureProjectRunner: vi.fn().mockResolvedValue({projectId:"projectB",pool:{id:"test-project-b"}}), list: vi.fn().mockResolvedValue({items:[],nextCursor:null}), listProjects: vi.fn().mockResolvedValue({items:[],nextCursor:null}),
    create: vi.fn().mockResolvedValue({ id: "team-a", name: "Team A" }), update: vi.fn().mockResolvedValue({ id: "team-a" }),
    remove: vi.fn().mockResolvedValue(undefined), assignProject: vi.fn().mockResolvedValue({ id: "projectB", groupId: "team-a", generation: 2 }),
    createPool: vi.fn().mockResolvedValue({ id: "pool-a", groupId: "team-a", generation: 2 }),
    updateConnectivity: vi.fn().mockResolvedValue({ id: "pool-a", runtimeUrl: "http://pool-a:8091", publicUrl: null, generation: 2 }) };
  const accessTokens = { authenticate: vi.fn().mockResolvedValue(token ? {
    id: "token-actor", projectId: "projectB", tokenId: "token", ...token,
  } : null), recordRequest: vi.fn() };
  const app = createHttpApp({ config,
    auth: { api: { getSession: vi.fn().mockResolvedValue(role ? { session: { id: "fixture-session", activeProjectId: "projectA" }, user: { id: "admin-actor", role, projectId: "projectA" } } : null) } } as unknown as ControllerAuth,
    projects: { list: groups.listProjects, membership: async () => ({access: "write"}), runnerInitialized: async () => true } as never,
    accessTokens: accessTokens as unknown as AccessTokenService,
    service: { projectGroups: groups } as unknown as ControlPlaneService,
    runnerControl: {} as RunnerControlServer, metrics: { registry: new Registry() } as ControllerMetrics });
  return { app, groups, accessTokens };
}

describe("platform Project Group administration", () => {
  it.each([null, "user", "unsupported"])("denies %s before reading allocations or parsing mutations", async role => {
    const { app, groups } = setup(role);
    for (const [method, path] of routes) {
      const response = await app.request(`/api/v1${path}`, { method,
        ...(method === "GET" ? {} : { headers: { "content-type": "application/json" }, body: "not-json" }) });
      expect(response.status).toBe(role ? 403 : 401);
    }
    for (const fn of Object.values(groups)) expect(fn).not.toHaveBeenCalled();
  });

  it("lists platform groups and membership independently of the administrator's project field", async () => {
    const { app, groups } = setup();
    expect(await (await app.request("/api/v1/project-groups")).json()).toEqual({items:[],nextCursor:null});
    expect(await (await app.request("/api/v1/projects")).json()).toEqual({items:[],nextCursor:null});
    expect(groups.list).toHaveBeenCalledOnce(); expect(groups.listProjects).toHaveBeenCalledOnce();
  });

  it("forwards explicit group creation and stale-assignment protection with the authenticated actor", async () => {
    const { app, groups } = setup();
    const send = (path: string, method: string, body: unknown) => app.request(`/api/v1${path}`, {
      method, headers: { "content-type": "application/json", "x-user-id": "foreign" }, body: JSON.stringify(body) });
    expect((await send("/project-groups", "POST", { id: "team-a", name: " Team A " })).status).toBe(201);
    expect(groups.create).toHaveBeenCalledExactlyOnceWith({ id: "team-a", name: "Team A" }, "admin-actor");
    const assignment = { groupId: "team-a", expectedGroupId: "default" };
    expect((await send("/projects/projectB/group", "PUT", assignment)).status).toBe(200);
    expect(groups.assignProject).toHaveBeenCalledExactlyOnceWith("projectB", assignment, "admin-actor");
    expect((await send("/runner-pools/pool-a/group", "PUT", assignment)).status).toBe(404);
    expect((await send("/project-groups/team-a", "PATCH", { name: "Renamed" })).status).toBe(200);
    expect(groups.update).toHaveBeenCalledExactlyOnceWith("team-a", { name: "Renamed" }, "admin-actor");
    expect((await app.request("/api/v1/project-groups/team-a", { method: "DELETE" })).status).toBe(204);
    expect(groups.remove).toHaveBeenCalledExactlyOnceWith("team-a", "admin-actor");
  });

  it("requires an explicit pool runtime origin and normalizes admin-configured connectivity", async () => {
    const { app, groups } = setup();
    const send = (path: string, body: unknown, method = "POST") => app.request(`/api/v1${path}`, {
      method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    for (const runtimeUrl of [undefined, "file:///etc/passwd", "http://user:secret@pool-a:8091", "http://pool-a:8091/path", "http://pool-a:8091?secret=1", "http://pool-a:8091#section"])
      expect((await send("/project-groups/team-a/pools", { projectId: "projectA", runtimeUrl })).status).toBe(400);
    expect(groups.createPool).not.toHaveBeenCalled();
    expect((await send("/project-groups/team-a/pools", { projectId: "projectA", runtimeUrl: "http://pool-a:8091/" })).status).toBe(201);
    expect(groups.createPool).toHaveBeenCalledExactlyOnceWith("team-a", { projectId: "projectA", runtimeUrl: "http://pool-a:8091" }, "admin-actor");
    expect((await send("/runner-pools/pool-a/connectivity", { runtimeUrl: "https://pool-a:8091/", publicUrl: null }, "PUT")).status).toBe(200);
    expect(groups.updateConnectivity).toHaveBeenCalledExactlyOnceWith("pool-a", { runtimeUrl: "https://pool-a:8091", publicUrl: null }, "admin-actor");
  });

  it("validates and forwards project-centric allocation with both stale-state checks", async () => {
    const {app, groups} = setup();
    expect((await app.request("/api/v1/projects/projectB/runner")).status).toBe(200);
    const body = {mode:"dedicated",expectedGroupId:"default",expectedPoolId:"default",runtimeUrl:"http://runner-test-project-b:8091/",publicUrl:null};
    const send = (input:unknown) => app.request("/api/v1/projects/projectB/runner",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(input)});
    expect((await send({...body,expectedPoolId:undefined})).status).toBe(400);
    expect((await send({...body,runtimeUrl:"http://runner/path"})).status).toBe(400);
    expect(groups.configureProjectRunner).not.toHaveBeenCalled();
    expect((await send(body)).status).toBe(200);
    expect(groups.configureProjectRunner).toHaveBeenCalledWith("projectB",{...body,runtimeUrl:"http://runner-test-project-b:8091"},"admin-actor");
  });

  it("rejects missing expectedGroupId and caller-supplied ownership or role fields", async () => {
    const { app, groups } = setup();
    for (const body of [{ groupId: "team-a" }, { groupId: "team-a", expectedGroupId: "default", projectId: "projectA" },
      { groupId: "team-a", expectedGroupId: "default", role: "admin" }]) {
      expect((await app.request("/api/v1/projects/projectB/group", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status).toBe(400);
    }
    expect(groups.assignProject).not.toHaveBeenCalled();
  });

  it("intersects PAT scopes with platform role for allocation mutations", async () => {
    for (const token of [{ role: "user", permissions: { projectGroups: "write" } }, { role: "admin", permissions: { projectGroups: "read" } }]) {
      const { app, groups } = setup("admin", token);
      expect((await app.request("/api/v1/project-groups", { method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify({ name: "Group" }) })).status).toBe(403);
      expect(groups.create).not.toHaveBeenCalled();
    }
    const { app, groups, accessTokens } = setup("user", { role: "admin", permissions: { projectGroups: "write" } });
    expect((await app.request("/api/v1/project-groups", { method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify({ name: "Group" }) })).status).toBe(201);
    expect(groups.create).toHaveBeenCalledExactlyOnceWith({ name: "Group" }, "token-actor");
    expect(accessTokens.recordRequest).toHaveBeenCalledOnce();
  });

  it("also enforces platform authority in the service before any database work", async () => {
    const service = new ProjectGroupService({} as ConstructorParameters<typeof ProjectGroupService>[0]);
    const calls = [() => service.projectRunner("projectB"), () => service.configureProjectRunner("projectB", {}, "actor"), () => service.list({q:"",limit:25}), () => service.get("default"), () => service.pools("default",{q:"",limit:25}), () => service.create({}, "actor"),
      () => service.update("default", {}, "actor"), () => service.remove("default", "actor"),
      () => service.assignProject("projectB", {}, "actor"),
      () => service.createPool("default", {}, "actor"), () => service.updateConnectivity("default", {}, "actor")];
    for (const call of calls) await expect(runWithProjectContext({ role: "user", projectId: "projectB" }, call)).rejects.toMatchObject({ status: 403, code: "forbidden" });
  });
});
