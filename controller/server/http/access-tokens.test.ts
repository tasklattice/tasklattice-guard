// @vitest-environment node
import { runnerAuthEnv } from "../../test/runner-auth-fixture.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import type { ControllerAuth } from "../auth.js";
import type { AccessTokenService, TokenIdentity } from "../services/access-tokens.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
import { createHttpApp } from "./app.js";
import { tokenRoutePermissions, requiredTokenPermission, adminProjectScope } from "./token-permissions.js";
import { currentProjectId } from "../services/project-context.js";
import { NotFoundError } from "../domain/errors.js";
import type { ModelConfigurationService } from "../model-config/service.js";
import type { ProjectService } from "../services/projects.js";
import { allowsTokenPermission } from "../../shared/access-tokens.js";
const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://controller:controller@localhost/controller",
  ...runnerAuthEnv("runner-token-that-is-at-least-32-characters"), CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/controller-signing-key.pem",
  CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"), BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters" });
function setup(identity: TokenIdentity | null = { id: "owner", role: "admin", projectId: "projectA", tokenId: "token", permissions: { routers: "read" } }) {
  const getSession = vi.fn().mockResolvedValue({ session: { id: "fixture-session", activeProjectId: "projectA" }, user: { id: "session-owner", role: "admin", projectId: "projectA" } });
  const accessTokens = { authenticate: vi.fn().mockResolvedValue(identity), recordRequest: vi.fn(), list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ secret: "one-time-secret" }), revoke: vi.fn() };
  const createRouter = vi.fn().mockResolvedValue({ id: "new" });
  const updateRunnerPool = vi.fn().mockResolvedValue({ id: "pool" });
  const projects = { requireExists: vi.fn(async (id: string) => { if (!["projectA", "projectB"].includes(id)) throw new NotFoundError("Project", id); }),
    list: vi.fn(async () => ({ items: [{ id: "projectA" }], nextCursor: null })),
    create: vi.fn(async () => ({ id: "new-project" })), members: vi.fn(async () => ({ items: [], nextCursor: null })),
    memberCandidates: vi.fn(async () => ({ items: [], nextCursor: null })), setMember: vi.fn(),
  };
  const app = createHttpApp({ config, auth: { api: { getSession } } as unknown as ControllerAuth,
    accessTokens: accessTokens as unknown as AccessTokenService, projects: projects as unknown as ProjectService,
    models: { view: vi.fn(async () => ({ models: [{ projectId: currentProjectId() }] })), createModel: vi.fn(async () => ({ projectId: currentProjectId() })) } as unknown as ModelConfigurationService,
    service: { trafficRouting: { list: async () => [], create: createRouter }, listGuardrails: vi.fn(async () => [{ projectId: currentProjectId() }]),
      queryRuntimeEvents: async () => ({ items: [], count: 0 }),
      querySecurityEvents: async () => ({ items: [], count: 0, nextCursor: null }),
      getRuntimeEvent: async (_id: string, includeContent: boolean) => ({ id: "event", metadata: includeContent ? { contentBefore: [{ text: "Captured project request" }] } : {} }),
      listAuditEvents: async () => ({ items: [] }), updateRunnerPool,
    } as unknown as ControlPlaneService,
    runnerControl: {} as RunnerControlServer, metrics: {} as ControllerMetrics });
  const request = (method: string, path: string, authorization: string | null = "Bearer test", body?: unknown, extra: Record<string,string> = {}) => app.request(`/api/v1${path}`, {
    method, headers: { cookie: "valid-session", ...(authorization === null ? {} : { authorization }), "content-type": "application/json", "x-project-id": "projectA", ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { app, projects, request, accessTokens, getSession, createRouter, updateRunnerPool };
}
describe("Access token HTTP authority", () => {
  it.each(["admin"])("allows %s Runner writes only with the matching token grant", async role => {
    const targets = { desiredReplicas: 2, safeRpsPerRunner: 50, maxConcurrencyPerRunner: 64 };
    const writable = setup({ id: "owner", role, projectId: "projectA", tokenId: "token", permissions: { runners: "write" } });
    expect((await writable.request("PATCH", "/runner-pools/pool", "Bearer test", targets)).status).toBe(200);
    expect(writable.updateRunnerPool).toHaveBeenCalledExactlyOnceWith({ id: "pool", actorId: "owner", ...targets });
    expect(writable.accessTokens.recordRequest).toHaveBeenCalledWith(expect.objectContaining({ tokenId: "token" }), "PATCH", "/api/v1/runner-pools/:id", 200);
    const readOnly = setup({ id: "owner", role, projectId: "projectA", tokenId: "token", permissions: { runners: "read" } });
    expect((await readOnly.request("PATCH", "/runner-pools/pool", "Bearer test", targets)).status).toBe(403);
    expect(readOnly.updateRunnerPool).not.toHaveBeenCalled();
  });
  it("does not let a project token mutate shared Runner pools", async () => {
    const { request, updateRunnerPool } = setup({ id: "owner", role: "user", projectId: "projectA", tokenId: "token", permissions: { runners: "write" } });
    expect((await request("PATCH", "/runner-pools/pool", "Bearer test", {})).status).toBe(403);
    expect(updateRunnerPool).not.toHaveBeenCalled();
  });
  it.each([
    ["POST", "/guardrails/guardrail-default/test-runs"],
    ["POST", "/guardrails/guardrail-default/publish"],
    ["POST", "/guardrails/guardrail-default/versions/v1/test-runs"],
    ["POST", "/guardrails/guardrail-default/versions/v1/release"],
    ["POST", "/guardrails/guardrail-default/versions/v1/environment-check"],
    ["DELETE", "/guardrails/guardrail-default/versions/v1"],
  ])("does not grant a user token platform maintenance through runners:write: %s %s", async (method, path) => {
    const { request } = setup({ id: "owner", role: "user", projectId: "projectA", tokenId: "token", permissions: { runners: "write" } });
    expect((await request(method!, path!, "Bearer test", {})).status).toBe(403);
  });
  it("uses token identity instead of a concurrent browser session and reports its scopes", async () => {
    const { request, getSession } = setup();
    expect(await (await request("GET", "/account/identity")).json()).toMatchObject({ userId: "owner", tokenId: "token", permissions: { routers: "read" } });
    expect(getSession).not.toHaveBeenCalled();
  });
  it.each(["Bearer invalid", "Basic test", "Bearer", "Bearer test extra"])("never falls back to cookies for %s", async header => {
    const { request, getSession } = setup(null);
    expect((await request("GET", "/routers", header)).status).toBe(401);
    expect(getSession).not.toHaveBeenCalled();
  });
  it("fails closed for user PATs with no persisted project despite project headers", async () => {
    const { request, accessTokens } = setup({ id: "owner", role: "user", projectId: "", tokenId: "token", permissions: { routers: "write" } });
    expect((await request("GET", "/account/identity", "Bearer test", undefined, { "x-project-id": "projectB" })).status).toBe(401);
    expect((await request("GET", "/routers")).status).toBe(401);
    expect(accessTokens.recordRequest).not.toHaveBeenCalled();
  });
  it("uses persisted user scope and explicitly selected project scope for administrators", async () => {
    const project = setup({ id: "owner", role: "user", projectId: "projectB", tokenId: "token", permissions: { guardrails: "read" } });
    expect(await (await project.request("GET", "/guardrails")).json()).toMatchObject({ items: [{ projectId: "projectB" }] });
    const platform = setup({ id: "owner", role: "admin", projectId: "projectB", tokenId: "token", permissions: { guardrails: "read" } });
    expect(await (await platform.request("GET", "/guardrails")).json()).toMatchObject({ items: [{ projectId: "projectA" }] });
    expect(await (await platform.request("GET", "/account/identity")).json()).toMatchObject({ projectId: null, role: "admin" });
  });
  it("allows module reads, denies writes and other modules", async () => {
    const { request, createRouter } = setup();
    expect((await request("GET", "/routers")).status).toBe(200);
    expect((await request("GET", "/guardrails")).status).toBe(403);
    expect((await request("POST", "/routers", "Bearer test", {})).status).toBe(403);
    expect(createRouter).not.toHaveBeenCalled();
  });
  it.each(["user"])("forwards a %s token mutation with the owner and token attribution", async role => {
    const { request, accessTokens, createRouter } = setup({ id: "owner", role, projectId: "projectA", tokenId: "token", permissions: { routers: "write" } });
    const draft = { routes: [{ id: "fallback", name: "Fallback", kind: "fallback", enabled: true, selector: { expression: { combinator: "and", conditions: [] } }, targets: [{ id: "target", guardrailId: "guard", guardrailVersion: "1", weightBps: 10000 }] }] };
    expect((await request("POST", "/routers", "Bearer test", { name: "Automation", draft })).status).toBe(201);
    expect(createRouter.mock.calls[0]?.[3]).toBe("owner");
    expect(accessTokens.recordRequest).toHaveBeenCalledWith(expect.objectContaining({ tokenId: "token" }), "POST", "/api/v1/routers", 201);
  });
  it("denies administrator business mutations even when an old token grants write", async () => {
    const { request, createRouter } = setup({ id: "owner", role: "admin", projectId: "projectA", tokenId: "token", permissions: { routers: "write" } });
    expect((await request("POST", "/routers", "Bearer test", {})).status).toBe(403);
    expect(createRouter).not.toHaveBeenCalled();
    expect(await (await request("GET", "/account/identity")).json()).toMatchObject({ effectivePermissions: { routers: "read" } });
  });
  it("retains business and Model authority after a role change, but blocks platform grants", async () => {
    const { request } = setup({ id: "owner", role: "user", projectId: "projectA", tokenId: "token", permissions: { routers: "write", models: "write", modelPricing: "write" } });
    expect((await request("GET", "/routers")).status).toBe(200);
    expect((await request("POST", "/routers", "Bearer test", {})).status).toBe(400);
    expect((await request("GET", "/models")).status).toBe(200);
    expect((await request("PUT", "/models/id/pricing", "Bearer test", {})).status).toBe(403);
  });
  it("lets a project runtime token read captured content but rejects an old audit grant", async () => {
    const { request } = setup({ id: "owner", role: "user", projectId: "projectA", tokenId: "token", permissions: { runtime: "read", audit: "read" } });
    expect((await request("GET", "/telemetry/events")).status).toBe(200);
    expect((await request("GET", "/telemetry/security-events?guardrailId=guard")).status).toBe(200);
    expect(await (await request("GET", "/telemetry/events/event?includeContent=true")).json()).toMatchObject({ metadata: { contentBefore: [{ text: "Captured project request" }] } });
    expect((await request("GET", "/audit-events")).status).toBe(403);
    expect(await (await request("GET", "/account/identity")).json()).toMatchObject({ effectivePermissions: { runtime: "read" } });
  });
  it("lets platform tokens read audit records but rejects old project runtime grants", async () => {
    const { request } = setup({ id: "owner", role: "admin", projectId: "projectA", tokenId: "token", permissions: { runtime: "read", audit: "read" } });
    expect((await request("GET", "/audit-events")).status).toBe(200);
    for (const path of ["/telemetry/events", "/telemetry/security-events?guardrailId=guard", "/telemetry/events/event?includeContent=true", "/telemetry/metrics"]) {
      expect((await request("GET", path)).status).toBe(403);
    }
    expect(await (await request("GET", "/account/identity")).json()).toMatchObject({ effectivePermissions: { audit: "read" } });
  });
  it.each([["GET", "/account/access-tokens"], ["POST", "/account/access-tokens"], ["DELETE", "/account/access-tokens/another"],
    ["GET", "/account/projects"],
  ])("tokens cannot manage account credentials: %s %s", async (method, path) => {
    const { request, accessTokens } = setup();
    expect((await request(method!, path!, "Bearer test", method === "POST" ? {} : undefined)).status).toBe(403);
    expect(accessTokens.create).not.toHaveBeenCalled(); expect(accessTokens.list).not.toHaveBeenCalled(); expect(accessTokens.revoke).not.toHaveBeenCalled();
  });
  it.each(tokenRoutePermissions.filter(([method, path]) => adminProjectScope(method, path) === "required"))(
    "requires a project on every administrator business read: %s %s", async (method, template, module) => {
      const { app, projects } = setup({ id: "owner", role: "admin", projectId: null, tokenId: "token", permissions: { [module]: "read" } });
      const path = template.replace(/:[^/]+/g, "fixture");
      const response = await app.request(path, { method, headers: { authorization: "Bearer test" } });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "project_required" } });
      expect(projects.requireExists).not.toHaveBeenCalled();
    });
  it("validates project selection and never treats a query parameter as authority", async () => {
    const { app, projects, request } = setup({ id: "owner", role: "admin", projectId: null, tokenId: "token", permissions: { guardrails: "read" } });
    for (const id of ["bad/project", "a".repeat(129)]) {
      expect((await request("GET", "/guardrails", "Bearer test", undefined, { "x-project-id": id })).status).toBe(400);
    }
    expect(projects.requireExists).not.toHaveBeenCalled();
    expect((await request("GET", "/guardrails", "Bearer test", undefined, { "x-project-id": "missing" })).status).toBe(404);
    expect((await request("GET", "/guardrails?projectId=projectB")).status).toBe(400);
    expect(await (await request("GET", "/guardrails", "Bearer test", undefined, { "x-project-id": "projectB" })).json())
      .toMatchObject({ items: [{ projectId: "projectB" }] });
    // Browser administrators obey the same read boundary.
    expect((await app.request("/api/v1/guardrails")).status).toBe(400);
    expect(await (await request("GET", "/guardrails", null)).json()).toMatchObject({ items: [{ projectId: "projectA" }] });
  });
  it.each(tokenRoutePermissions.filter(([, , module, access]) => access === "write" && ["guardrails", "routers", "endpoints", "policies", "playground"].includes(module)))(
    "never permits administrator business writes: %s %s", async (method, template, module) => {
      const { request } = setup({ id: "owner", role: "admin", projectId: null, tokenId: "token", permissions: { [module]: "write" } });
      expect((await request(method, template.replace("/api/v1", "").replace(/:[^/]+/g, "fixture"), "Bearer test", {})).status).toBe(403);
    });
  it("allows project directory and membership reads with projects:read but denies writes", async () => {
    const { request, projects } = setup({ id: "owner", role: "admin", projectId: null, tokenId: "token", permissions: { projects: "read" } });
    for (const path of ["/projects", "/projects/projectA/members", "/projects/projectA/member-candidates", "/project-groups/default/projects"])
      expect((await request("GET", path)).status).toBe(200);
    expect((await request("POST", "/projects", "Bearer test", { name: "new-project" })).status).toBe(403);
    for (const method of ["PUT", "DELETE"]) expect((await request(method, "/projects/projectA/members/member")).status).toBe(403);
    expect(projects.create).not.toHaveBeenCalled(); expect(projects.setMember).not.toHaveBeenCalled();
  });
  it("allows administrator project mutations with projects:write and records token attribution", async () => {
    const { request, projects, accessTokens } = setup({ id: "owner", role: "admin", projectId: null, tokenId: "token", permissions: { projects: "write" } });
    expect((await request("POST", "/projects", "Bearer test", { name: "new-project" })).status).toBe(201);
    expect(projects.create).toHaveBeenCalledWith("owner", { name: "new-project" });
    for (const method of ["PUT", "DELETE"]) expect((await request(method, "/projects/projectA/members/member")).status).toBe(204);
    expect(projects.setMember.mock.calls).toEqual([["owner", "projectA", "member", true], ["owner", "projectA", "member", false]]);
    expect(accessTokens.recordRequest).toHaveBeenCalledWith(expect.objectContaining({ tokenId: "token" }), "POST", "/api/v1/projects", 201);
    expect((await request("GET", "/users")).status).toBe(403);
  });
  it("separates platform Models from explicitly selected project Models and denies project writes", async () => {
    const { app, request } = setup({ id: "owner", role: "admin", projectId: null, tokenId: "token", permissions: { models: "write", modelConfiguration: "read" } });
    const platform = await app.request("/api/v1/models", { headers: { authorization: "Bearer test" } });
    expect(await platform.json()).toEqual([{ projectId: null }]);
    expect(await (await request("GET", "/models")).json()).toEqual([{ projectId: "projectA" }]);
    expect(await (await request("GET", "/model-configuration")).json()).toEqual({ models: [{ projectId: "projectA" }] });
    expect((await request("POST", "/models", "Bearer test", {})).status).toBe(403);
    for (const path of ["/models/id/protocol", "/models/id/runtime-settings"])
      expect((await request("PUT", path, "Bearer test", {})).status).toBe(403);
  });
  it("preserves platform-only configuration reads after splitting entity grants", async () => {
    const { request } = setup({ id: "owner", role: "user", projectId: "projectA", tokenId: "token", permissions: { modelConfiguration: "read" } });
    for (const path of ["/project-groups/default/model-configuration", "/model-configuration/draft/assignments/control-plane/candidate-validations/id"])
      expect((await request("GET", path)).status).toBe(403);
  });
  it("retains browser Origin checks for project management", async () => {
    const { request, projects } = setup();
    expect((await request("POST", "/projects", null, { name: "new-project" }, { origin: "https://untrusted.example" })).status).toBe(403);
    expect(projects.create).not.toHaveBeenCalled();
  });
  it.each(["providers", "modelConfiguration", "modelPricing", "projectGroups", "runners"] as const)(
    "does not grant project management through %s", async module => {
      const { request } = setup({ id: "owner", role: "admin", projectId: null, tokenId: "token", permissions: { [module]: "write" } });
      expect((await request("GET", "/projects")).status).toBe(403);
      expect((await request("POST", "/projects", "Bearer test", {})).status).toBe(403);
    });
  it("does not let project users acquire project management even with a forged grant", async () => {
    const { request, projects } = setup({ id: "owner", role: "user", projectId: "projectA", tokenId: "token", permissions: { projects: "write" } });
    expect((await request("POST", "/projects", "Bearer test", {})).status).toBe(403);
    expect((await request("GET", "/projects")).status).toBe(403);
    expect(projects.list).not.toHaveBeenCalled(); expect(projects.create).not.toHaveBeenCalled();
  });
  it("does not translate retired settings or unrelated grants into new entity grants", async () => {
    const { request } = setup({ id: "owner", role: "admin", projectId: null, tokenId: "token",
      permissions: { settings: "write" } as unknown as TokenIdentity["permissions"] });
    for (const path of ["/projects", "/project-groups", "/model-providers", "/model-configuration", "/model-pricing", "/runner-pools"])
      expect((await request("GET", path)).status).toBe(403);
    expect(await (await request("GET", "/account/identity")).json()).toMatchObject({ effectivePermissions: {} });
  });
  it("uses the session owner for token management and prevents response caching", async () => {
    const { request, accessTokens } = setup();
    const response = await request("POST", "/account/access-tokens", null, { name: "CI" });
    expect(response.status).toBe(201); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(accessTokens.create).toHaveBeenCalledWith("session-owner", { name: "CI" }, null);
    await request("DELETE", "/account/access-tokens/id", null);
    expect(accessTokens.revoke).toHaveBeenCalledWith("session-owner", "id");
  });
  it("accepts account mutations from the configured public origin", async () => {
    const { request } = setup();
    expect((await request("POST", "/account/access-tokens", null, { name: "CI" }, {origin: new URL(config.publicUrl).origin, "sec-fetch-site": "same-origin"})).status).toBe(201);
  });
  it("rejects cross-site issuance before the service", async () => {
    const { request, accessTokens } = setup();
    expect((await request("POST", "/account/access-tokens", null, {}, { origin: "https://untrusted.example" })).status).toBe(403);
    expect(accessTokens.create).not.toHaveBeenCalled();
  });
  it("covers every authenticated product route explicitly and denies unknown operations", () => {
    const source = readFileSync(new URL("./app.ts", import.meta.url), "utf8");
    for (const [, method, path, sessionOnly] of source.matchAll(/app\.(get|post|put|patch|delete)\(["'](\/api\/v1\/[^"']+)["'], authenticated(, (?:browserSession|accountSession))?/g)) {
      if (sessionOnly || path!.startsWith("/api/v1/account/")) {
        expect(requiredTokenPermission(method!.toUpperCase(), path!)).toBeUndefined();
        continue;
      }
      expect(tokenRoutePermissions.some(([verb, template]) => verb === method!.toUpperCase() && template === path), path).toBe(true);
    }
    expect(requiredTokenPermission("POST", "/api/v1/future-admin-operation")).toBeUndefined();
    expect(requiredTokenPermission("GET", "/api/v1/routers/id/unknown")).toBeUndefined();
    expect(requiredTokenPermission("PATCH", "/api/v1/routers/id")).toBeUndefined();
  });
  it.each(tokenRoutePermissions.filter(([, , , access]) => access === "write"))("rejects read-only authority for %s %s", (_verb, _path, module) => {
    expect(allowsTokenPermission({ [module]: "read" }, module, "write", "admin")).toBe(false);
  });
});
