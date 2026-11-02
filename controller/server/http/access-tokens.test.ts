// @vitest-environment node
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
import { tokenRoutePermissions, requiredTokenPermission } from "./token-permissions.js";
import { currentTenantId } from "../services/tenant-context.js";
import { allowsTokenPermission } from "../../shared/access-tokens.js";
const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://controller:controller@localhost/controller",
  CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/controller-signing-key.pem",
  CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"), BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters" });
function setup(identity: TokenIdentity | null = { id: "owner", role: "admin", tenantId: "tenantA", tokenId: "token", permissions: { routers: "read" } }) {
  const getSession = vi.fn().mockResolvedValue({ user: { id: "session-owner", role: "admin", tenantId: "tenantA" } });
  const accessTokens = { authenticate: vi.fn().mockResolvedValue(identity), recordRequest: vi.fn(), list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ secret: "one-time-secret" }), revoke: vi.fn() };
  const createRouter = vi.fn().mockResolvedValue({ id: "new" });
  const updateRunnerPool = vi.fn().mockResolvedValue({ id: "pool" });
  const app = createHttpApp({ config, auth: { api: { getSession } } as unknown as ControllerAuth,
    accessTokens: accessTokens as unknown as AccessTokenService,
    service: { trafficRouting: { list: async () => [], create: createRouter }, listGuardrails: vi.fn(async () => [{ tenantId: currentTenantId() }]),
      queryRuntimeEvents: async () => ({ items: [], count: 0 }),
      querySecurityEvents: async () => ({ items: [], count: 0, nextCursor: null }),
      getRuntimeEvent: async (_id: string, includeContent: boolean) => ({ id: "event", metadata: includeContent ? { contentBefore: [{ text: "Captured tenant request" }] } : {} }),
      listAuditEvents: async () => ({ items: [] }), updateRunnerPool,
    } as unknown as ControlPlaneService,
    runnerControl: {} as RunnerControlServer, metrics: {} as ControllerMetrics });
  const request = (method: string, path: string, authorization: string | null = "Bearer test", body?: unknown, extra: Record<string,string> = {}) => app.request(`/api/v1${path}`, {
    method, headers: { cookie: "valid-session", ...(authorization === null ? {} : { authorization }), "content-type": "application/json", ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { request, accessTokens, getSession, createRouter, updateRunnerPool };
}
describe("Access token HTTP authority", () => {
  it.each(["admin"])("allows %s Runner writes only with the matching token grant", async role => {
    const targets = { desiredReplicas: 2, safeRpsPerRunner: 50, maxConcurrencyPerRunner: 64 };
    const writable = setup({ id: "owner", role, tenantId: "tenantA", tokenId: "token", permissions: { runners: "write" } });
    expect((await writable.request("PATCH", "/runner-pools/pool", "Bearer test", targets)).status).toBe(200);
    expect(writable.updateRunnerPool).toHaveBeenCalledExactlyOnceWith({ id: "pool", actorId: "owner", ...targets });
    expect(writable.accessTokens.recordRequest).toHaveBeenCalledWith(expect.objectContaining({ tokenId: "token" }), "PATCH", "/api/v1/runner-pools/:id", 200);
    const readOnly = setup({ id: "owner", role, tenantId: "tenantA", tokenId: "token", permissions: { runners: "read" } });
    expect((await readOnly.request("PATCH", "/runner-pools/pool", "Bearer test", targets)).status).toBe(403);
    expect(readOnly.updateRunnerPool).not.toHaveBeenCalled();
  });
  it("does not let a tenant token mutate shared Runner pools", async () => {
    const { request, updateRunnerPool } = setup({ id: "owner", role: "user", tenantId: "tenantA", tokenId: "token", permissions: { runners: "write" } });
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
    const { request } = setup({ id: "owner", role: "user", tenantId: "tenantA", tokenId: "token", permissions: { runners: "write" } });
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
  it("fails closed for user PATs with no persisted tenant despite tenant headers", async () => {
    const { request, accessTokens } = setup({ id: "owner", role: "user", tenantId: "", tokenId: "token", permissions: { routers: "write" } });
    expect((await request("GET", "/account/identity", "Bearer test", undefined, { "x-tenant-id": "tenantB" })).status).toBe(401);
    expect((await request("GET", "/routers")).status).toBe(401);
    expect(accessTokens.recordRequest).not.toHaveBeenCalled();
  });
  it("uses tenant user context and global metadata context for platform tokens", async () => {
    const tenant = setup({ id: "owner", role: "user", tenantId: "tenantB", tokenId: "token", permissions: { guardrails: "read" } });
    expect(await (await tenant.request("GET", "/guardrails")).json()).toMatchObject({ items: [{ tenantId: "tenantB" }] });
    const platform = setup({ id: "owner", role: "admin", tenantId: "tenantB", tokenId: "token", permissions: { guardrails: "read" } });
    expect(await (await platform.request("GET", "/guardrails")).json()).toMatchObject({ items: [{ tenantId: null }] });
    expect(await (await platform.request("GET", "/account/identity")).json()).toMatchObject({ tenantId: null, role: "admin" });
  });
  it("allows module reads, denies writes and other modules", async () => {
    const { request, createRouter } = setup();
    expect((await request("GET", "/routers")).status).toBe(200);
    expect((await request("GET", "/guardrails")).status).toBe(403);
    expect((await request("POST", "/routers", "Bearer test", {})).status).toBe(403);
    expect(createRouter).not.toHaveBeenCalled();
  });
  it.each(["user"])("forwards a %s token mutation with the owner and token attribution", async role => {
    const { request, accessTokens, createRouter } = setup({ id: "owner", role, tenantId: "tenantA", tokenId: "token", permissions: { routers: "write" } });
    const draft = { routes: [{ id: "fallback", name: "Fallback", kind: "fallback", enabled: true, selector: { expression: { combinator: "and", conditions: [] } }, targets: [{ id: "target", guardrailId: "guard", guardrailVersion: "1", weightBps: 10000 }] }] };
    expect((await request("POST", "/routers", "Bearer test", { name: "Automation", draft })).status).toBe(201);
    expect(createRouter.mock.calls[0]?.[3]).toBe("owner");
    expect(accessTokens.recordRequest).toHaveBeenCalledWith(expect.objectContaining({ tokenId: "token" }), "POST", "/api/v1/routers", 201);
  });
  it("denies administrator business mutations even when an old token grants write", async () => {
    const { request, createRouter } = setup({ id: "owner", role: "admin", tenantId: "tenantA", tokenId: "token", permissions: { routers: "write" } });
    expect((await request("POST", "/routers", "Bearer test", {})).status).toBe(403);
    expect(createRouter).not.toHaveBeenCalled();
    expect(await (await request("GET", "/account/identity")).json()).toMatchObject({ effectivePermissions: { routers: "read" } });
  });
  it("retains business and Model authority after a role change, but blocks platform grants", async () => {
    const { request } = setup({ id: "owner", role: "user", tenantId: "tenantA", tokenId: "token", permissions: { routers: "write", models: "write", settings: "write" } });
    expect((await request("GET", "/routers")).status).toBe(200);
    expect((await request("POST", "/routers", "Bearer test", {})).status).toBe(400);
    expect((await request("GET", "/models")).status).toBe(503);
    expect((await request("PUT", "/models/id/pricing", "Bearer test", {})).status).toBe(403);
  });
  it("lets a tenant runtime token read captured content but rejects an old audit grant", async () => {
    const { request } = setup({ id: "owner", role: "user", tenantId: "tenantA", tokenId: "token", permissions: { runtime: "read", audit: "read" } });
    expect((await request("GET", "/telemetry/events")).status).toBe(200);
    expect((await request("GET", "/telemetry/security-events?guardrailId=guard")).status).toBe(200);
    expect(await (await request("GET", "/telemetry/events/event?includeContent=true")).json()).toMatchObject({ metadata: { contentBefore: [{ text: "Captured tenant request" }] } });
    expect((await request("GET", "/audit-events")).status).toBe(403);
    expect(await (await request("GET", "/account/identity")).json()).toMatchObject({ effectivePermissions: { runtime: "read" } });
  });
  it("lets platform tokens read audit records but rejects old tenant runtime grants", async () => {
    const { request } = setup({ id: "owner", role: "admin", tenantId: "tenantA", tokenId: "token", permissions: { runtime: "read", audit: "read" } });
    expect((await request("GET", "/audit-events")).status).toBe(200);
    for (const path of ["/telemetry/events", "/telemetry/security-events?guardrailId=guard", "/telemetry/events/event?includeContent=true", "/telemetry/metrics"]) {
      expect((await request("GET", path)).status).toBe(403);
    }
    expect(await (await request("GET", "/account/identity")).json()).toMatchObject({ effectivePermissions: { audit: "read" } });
  });
  it.each([["GET", "/account/access-tokens"], ["POST", "/account/access-tokens"], ["DELETE", "/account/access-tokens/another"],
    ["GET", "/account/tenants"], ["GET", "/account/shareable-resources"], ["GET", "/account/shares"],
    ["POST", "/account/shares"], ["DELETE", "/account/shares/another"],
  ])("tokens cannot manage account credentials or sharing: %s %s", async (method, path) => {
    const { request, accessTokens } = setup();
    expect((await request(method!, path!, "Bearer test", method === "POST" ? {} : undefined)).status).toBe(403);
    expect(accessTokens.create).not.toHaveBeenCalled(); expect(accessTokens.list).not.toHaveBeenCalled(); expect(accessTokens.revoke).not.toHaveBeenCalled();
  });
  it("uses the session owner for token management and prevents response caching", async () => {
    const { request, accessTokens } = setup();
    const response = await request("POST", "/account/access-tokens", null, { name: "CI" });
    expect(response.status).toBe(201); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(accessTokens.create).toHaveBeenCalledWith("session-owner", { name: "CI" });
    await request("DELETE", "/account/access-tokens/id", null);
    expect(accessTokens.revoke).toHaveBeenCalledWith("session-owner", "id");
  });
  it("rejects cross-site issuance before the service", async () => {
    const { request, accessTokens } = setup();
    expect((await request("POST", "/account/access-tokens", null, {}, { origin: "https://untrusted.example" })).status).toBe(403);
    expect(accessTokens.create).not.toHaveBeenCalled();
  });
  it("covers every authenticated product route explicitly and denies unknown operations", () => {
    const source = readFileSync(new URL("./app.ts", import.meta.url), "utf8");
    for (const [, method, path] of source.matchAll(/app\.(get|post|put|patch|delete)\(["'](\/api\/v1\/[^"']+)["'], authenticated/g)) {
      if (path!.startsWith("/api/v1/account/") || path === "/api/v1/account/identity") continue;
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
