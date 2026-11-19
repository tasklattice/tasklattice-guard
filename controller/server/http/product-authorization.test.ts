import { runnerAuthEnv } from "../../test/runner-auth-fixture.js";
import { guardrailProfiles } from "../../shared/guardrail-profiles.js";
// @vitest-environment node
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuth } from "../auth.js";
import type { ControllerAuth } from "../auth.js";
import type { ControllerDatabase } from "../db/client.js";
import { loadConfig } from "../config.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import { createHttpApp } from "./app.js";

const config = loadConfig({
  NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://controller:controller@localhost/controller",
  ...runnerAuthEnv("runner-token-that-is-at-least-32-characters"),
  CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/controller-signing-key.pem",
  CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"),
  BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
});

// Explicit product surface inventory, independent of middleware implementation.
// Requests deliberately carry invalid bodies: authentication/authorization must
// reject them before parsing data, invoking a model or reaching a mutation.
const protectedRoutes = [
  ["POST", "/model-providers"], ["PATCH", "/model-providers/provider"],
  ["POST", "/model-provider-discoveries"], ["POST", "/model-provider-registrations"],
  ["POST", "/model-providers/provider/connection-tests"], ["POST", "/model-providers/provider/model-discoveries"],
  ["DELETE", "/model-providers/provider"], ["POST", "/models"],
  ["POST", "/models/model/capability-tests"], ["POST", "/models/model/connection-tests"],
  ["PUT", "/models/model/protocol"], ["DELETE", "/models/model"],
  ["PUT", "/model-configuration/draft"], ["PUT", "/model-configuration/draft/assignments/content_safety.input"],
  ["POST", "/model-configuration/draft/assignments/content_safety.input/validations"],
  ["POST", "/model-configuration/draft/validations"], ["POST", "/model-configuration/apply"],
  ["POST", "/policies"], ["PATCH", "/policies/policy"], ["DELETE", "/policies/policy"],
  ["POST", "/policies/policy/test-runs"],
  ["POST", "/policies/policy/publish"], ["POST", "/authoring/intent-analyses"],
  ["POST", "/authoring/document-analyses"],
  ["POST", "/playground/guardrails/guard/draft-previews"], ["POST", "/playground/guardrails/guard/draft-interactions"],
  ["POST", "/authoring/plan-previews"], ["POST", "/guardrails"],
  ["PATCH", "/guardrails/guard"], ["POST", "/guardrails/guard/publish"],
  ["PATCH", "/guardrails/guard/protection-mode"], ["PATCH", "/guardrails/guard/logging"], ["GET", "/guardrails/guard/deletion-impact"],
  ["DELETE", "/guardrails/guard"], ["POST", "/guardrails/guard/test-cases"], ["DELETE", "/guardrails/guard/test-cases/case"],
  ["PATCH", "/guardrails/guard/test-scope"], ["POST", "/guardrails/guard/test-runs"],
  ["POST", "/endpoints"], ["PATCH", "/endpoints/endpoint"],
  ["POST", "/endpoints/endpoint/credentials"], ["DELETE", "/endpoints/endpoint/credentials/credential"],
  ["GET", "/endpoints/endpoint/deletion-impact"], ["DELETE", "/endpoints/endpoint"],
  ["PATCH", "/runner-pools/pool"], ["DELETE", "/runner-instances/runner"],
  ["POST", "/routers"],
  ["PUT", "/routers/router/draft"], ["POST", "/routers/router/publication-preview"], ["POST", "/routers/router/change-requests"],
  ["POST", "/routers/router/change-requests/change/approve"], ["POST", "/routers/router/change-requests/change/emergency-apply"],
  ["POST", "/routers/router/change-requests/change/reject"], ["POST", "/routers/router/change-requests/change/withdraw"],
  ["POST", "/routers/router/change-requests/change/revert"], ["PUT", "/routers/router/endpoints"],
  ["PATCH", "/guardrails/guardrail-default"], ["DELETE", "/guardrails/guardrail-default"],
  ["POST", "/guardrails/guardrail-default/publish"], ["POST", "/guardrails/guardrail-default/test-runs"],
  ["POST", "/guardrails/guardrail-default/versions/version/release"],
  ["DELETE", "/guardrails/guardrail-default/versions/version"],
  ["POST", "/guardrails/guard/duplicate"], ["DELETE", "/routers/router"],
] as const;

const platformRoutes = [
  ...protectedRoutes.filter(([, path]) => /^\/(model-provider|model-configuration)/.test(path)),
  ["GET", "/model-pricing"], ["GET", "/model-pricing/catalog?q=model"],
  ["PUT", "/models/model/pricing"],
  ["GET", "/audit-events"],
  ["PATCH", "/runner-pools/pool"], ["DELETE", "/runner-instances/runner"],
] as const;

function setup(role: string | null) {
  const getSession = vi.fn().mockResolvedValue(role === null ? null : { session: { id: "fixture-session", activeProjectId: "projectA" }, user: { id: "actor", role, projectId: "projectA" } });
  const unexpected = vi.fn(() => { throw new Error("Protected service was reached"); });
  const service = new Proxy({}, { get: (_, key) => key === "listGuardrailProfiles" ? async () => guardrailProfiles : unexpected });
  const app = createHttpApp({ config,
    auth: { api: { getSession }, handler: vi.fn() } as unknown as ControllerAuth,
    service: service as ControlPlaneService, runnerControl: service as RunnerControlServer,
    metrics: {} as ControllerMetrics,
  });
  return { app, getSession, unexpected };
}

describe.each([null, "unknown-role"])("Product API authorization for role %s", (role) => {
  it.each(protectedRoutes)("denies %s %s before protected work", async (method, path) => {
    const { app, unexpected } = setup(role);
    const response = await app.request(`/api/v1${path}`, {
      method, headers: { "content-type": "application/json", "x-role": "admin", "x-user-id": "admin" },
      ...(method === "GET" ? {} : { body: "not-json" }),
    });
    expect(response.status).toBe(role === null ? 401 : 403);
    expect(await response.json()).toMatchObject({ error: { code: role === null ? "unauthenticated" : "forbidden" } });
    expect(unexpected).not.toHaveBeenCalled();
  });
});

describe("User platform boundary", () => {
  it.each(["/system/health", "/system/version", "/runner-pools"])("allows project operational reads at %s", async path => {
    const app = createHttpApp({ config,
      auth: { api: { getSession: vi.fn().mockResolvedValue({ session: { id: "fixture-session", activeProjectId: "projectA" }, user: { id: "actor", role: "user", projectId: "projectA" } }) } } as unknown as ControllerAuth,
      service: { listRunnerHeartbeats: vi.fn().mockResolvedValue([]), listRunnerPoolsWithCapacity: vi.fn().mockResolvedValue([]),
        runners: { list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }) } } as unknown as ControlPlaneService,
      runnerControl: {} as RunnerControlServer, metrics: {} as ControllerMetrics });
    expect((await app.request(`/api/v1${path}`)).status).toBe(200);
  });
  it.each(platformRoutes)("denies %s %s before reading settings or parsing a write", async (method, path) => {
    const { app, unexpected } = setup("user");
    const response = await app.request(`/api/v1${path}`, { method, headers: { "content-type": "application/json" }, ...(method === "GET" ? {} : { body: "not-json" }) });
    expect(response.status).toBe(403);
    expect(unexpected).not.toHaveBeenCalled();
  });

  it.each(["user"])("lets %s create Guardrail drafts with its own actor identity", async role => {
    const createGuardrail = vi.fn().mockResolvedValue({ id: "new-guard" });
    const app = createHttpApp({ config,
      auth: { api: { getSession: vi.fn().mockResolvedValue({ session: { id: "fixture-session", activeProjectId: "projectA" }, user: { id: "actor", role, projectId: "projectA" } }) } } as unknown as ControllerAuth,
      service: { createGuardrail } as unknown as ControlPlaneService,
      runnerControl: {} as RunnerControlServer, metrics: {} as ControllerMetrics });
    const response = await app.request("/api/v1/guardrails", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "User guardrail", draftConfig: { policyBindings: [{ policyId: "policy", policyVersion: "v1" }] } }) });
    expect(response.status).toBe(201);
    expect(createGuardrail).toHaveBeenCalledWith(expect.objectContaining({ name: "User guardrail", actorId: "actor" }));
  });
});

describe("Administrator business boundary", () => {
  it.each([
    "/telemetry/events", "/telemetry/events/event?includeContent=true",
    "/telemetry/endpoint-activity", "/telemetry/metrics",
  ])("denies project runtime data at %s before protected work", async path => {
    const { app, unexpected } = setup("admin");
    expect((await app.request(`/api/v1${path}`)).status).toBe(403);
    expect(unexpected).not.toHaveBeenCalled();
  });
  it.each(protectedRoutes.filter(([method, path]) => method !== "GET" && !/^\/(model|runner)/.test(path)))("denies %s %s before protected work", async (method, path) => {
    const { app, unexpected } = setup("admin");
    const response = await app.request(`/api/v1${path}`, { method, headers: { "content-type": "application/json" }, body: "not-json" });
    expect(response.status).toBe(403);
    expect(unexpected).not.toHaveBeenCalled();
  });
});

describe("Dashboard runtime authority", () => {
  const paths = ["/telemetry/metrics?window=7d", "/telemetry/events?limit=50"];

  it.each([null, "unknown-role", "admin"])("rejects role %s before reading dashboard data, despite spoofed headers", async role => {
    const { app, unexpected } = setup(role);
    for (const path of paths) {
      const response = await app.request(`/api/v1${path}`, { headers: { "x-role": "user", "x-user-id": "project-user" } });
      expect(response.status).toBe(role === null ? 401 : 403);
      expect(unexpected).not.toHaveBeenCalled();
    }
  });

  it("serves scoped metrics and events to the user and revokes both on a role change", async () => {
    const getSession = vi.fn().mockResolvedValue({ session: { id: "fixture-session", activeProjectId: "projectA" }, user: { id: "project-user", role: "user", projectId: "projectA" } });
    const metrics = { total_decisions: 7 };
    const events = { items: [{ id: "project-event", guardrailId: "project-guardrail" }] };
    const runtimeMetrics = vi.fn().mockResolvedValue(metrics);
    const queryRuntimeEvents = vi.fn().mockResolvedValue(events);
    const app = createHttpApp({ config,
      auth: { api: { getSession } } as unknown as ControllerAuth,
      service: { runtimeMetrics, queryRuntimeEvents } as unknown as ControlPlaneService,
      runnerControl: {} as RunnerControlServer, metrics: {} as ControllerMetrics });
    for (const [index, path] of paths.entries()) {
      const response = await app.request(`/api/v1${path}&guardrailId=project-guardrail`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(index === 0 ? metrics : events);
    }
    expect(runtimeMetrics).toHaveBeenCalledExactlyOnceWith({ window: "7d", guardrailId: "project-guardrail" });
    expect(queryRuntimeEvents).toHaveBeenCalledExactlyOnceWith({ limit: 50, guardrailId: "project-guardrail" });
    getSession.mockResolvedValue({ user: { id: "project-user", role: "admin" } });
    for (const path of paths) expect((await app.request(`/api/v1${path}`)).status).toBe(403);
    expect(runtimeMetrics).toHaveBeenCalledOnce();
    expect(queryRuntimeEvents).toHaveBeenCalledOnce();
  });
});

describe("Role changes revoke business authority", () => {
  it("blocks a former user on the next request after becoming an administrator", async () => {
    const { app, getSession, unexpected } = setup("user");
    const send = () => app.request("/api/v1/guardrails", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect((await send()).status).toBe(400);
    getSession.mockResolvedValueOnce({ session: { id: "fixture-session", activeProjectId: "projectA" }, user: { id: "actor", role: "admin", projectId: "projectA" } });
    expect((await send()).status).toBe(403);
    expect(unexpected).not.toHaveBeenCalled();
    expect(getSession).toHaveBeenLastCalledWith(expect.objectContaining({ query: { disableCookieCache: true } }));
  });
});

describe("Session freshness and read-only access", () => {
  it("rejects public signup before a visitor can acquire business access", async () => {
    const data: Record<string, Array<Record<string, unknown>>> = { user: [], session: [], account: [], verification: [] };
    const options = createAuth({ ...config, publicUrl: "http://localhost:8093", trustedOrigins: ["http://localhost:8093"] }, {} as ControllerDatabase).options;
    const auth = betterAuth({ ...options, database: memoryAdapter(data), databaseHooks: undefined });
    const unexpected = vi.fn(() => { throw new Error("Protected service was reached"); });
    const service = new Proxy({}, { get: () => unexpected });
    const app = createHttpApp({ config, auth, service: service as ControlPlaneService,
      runnerControl: service as RunnerControlServer, metrics: {} as ControllerMetrics });
    const signup = await app.request("/api/auth/sign-up/email", {
      method: "POST", headers: { origin: "http://localhost:8093", "content-type": "application/json" },
      body: JSON.stringify({ name: "Visitor", email: "visitor@guard.test", password: "synthetic-auth-password-2026" }),
    });
    expect(signup.status).toBe(404);
    expect(data.user).toHaveLength(0);
    expect((await app.request("/api/v1/policies")).status).toBe(401);
    expect(unexpected).not.toHaveBeenCalled();
  });

  it("does not accept a client-supplied project or role on Better Auth profile updates", async () => {
    const data: Record<string, Array<Record<string, unknown>>> = { user: [], session: [], account: [], verification: [] };
    const options = createAuth({ ...config, publicUrl: "http://localhost:8093", trustedOrigins: ["http://localhost:8093"] }, {} as ControllerDatabase).options;
    const auth = betterAuth({ ...options, database: memoryAdapter(data), databaseHooks: undefined });
    await auth.api.createUser({ body: { name: "Project fixture", email: "project@users.guard.invalid", password: "synthetic-auth-password-2026", data: { username: "project" } } });
    const signedIn = await auth.api.signInEmail({ body: { email: "project@users.guard.invalid", password: "synthetic-auth-password-2026", data: { username: "project" } }, asResponse: true });
    const cookie = signedIn.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    await auth.handler(new Request("http://localhost:8093/api/auth/update-user", {
      method: "POST",
      headers: { cookie, origin: "http://localhost:8093", "content-type": "application/json" },
      body: JSON.stringify({ name: "Updated fixture", projectId: "projectB", role: "admin" }),
    }));
    expect((await auth.api.getSession({ headers: new Headers({ cookie }), query: { disableCookieCache: true } }))?.user.projectId).toBeUndefined();
    expect(data.user![0]!.projectId).toBeUndefined();
    expect(data.user![0]!.role).toBe("user");
  });

  it.each(["active", "demoted", "revoked", "expired"])("uses current authority for a %s session with database-backed sessions", async (state) => {
    const data: Record<string, Array<Record<string, unknown>>> = { user: [], session: [], account: [], verification: [] };
    const options = createAuth({ ...config, publicUrl: "http://localhost:8093", trustedOrigins: ["http://localhost:8093"] }, {} as ControllerDatabase).options;
    // Real Better Auth signing and session lookup. Only the DB
    // adapter changes; its login timestamp hook is unrelated to authorization.
    const auth = betterAuth({ ...options, database: memoryAdapter(data), databaseHooks: undefined });
    await auth.api.createUser({ body: { name: "Authorization fixture", email: "authorization@users.guard.invalid", password: "synthetic-auth-password-2026", data: { username: "authorization" } } });
    data.user![0]!.role = "admin";
    const signedIn = await auth.api.signInUsername({ body: { username: "authorization", password: "synthetic-auth-password-2026" }, asResponse: true });
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    expect(cookie).toContain("tali-guard.session_token=");
    expect(cookie).not.toContain("tali-guard.session_data=");
    const headers = new Headers({ cookie, "content-type": "application/json" });
    expect((await auth.api.getSession({ headers }))?.user.role).toBe("admin");
    expect((await auth.api.getSession({ headers }))?.user.projectId).toBeUndefined();
    if (state === "demoted") data.user![0]!.role = "user";
    else if (state === "revoked") data.session!.splice(0);
    else if (state === "expired") for (const session of data.session!) session.expiresAt = new Date(0);
    expect((await auth.api.getSession({ headers }))?.user.role).toBe(state === "active" ? "admin" : state === "demoted" ? "user" : undefined);
    const unexpected = vi.fn().mockResolvedValue({ status: "queued" });
    const app = createHttpApp({ config, auth: auth as unknown as ControllerAuth,
      service: { pricing: { view: unexpected } } as unknown as ControlPlaneService,
      runnerControl: { distributeDesiredState: vi.fn() } as unknown as RunnerControlServer, metrics: {} as ControllerMetrics });
    const response = await app.request("/api/v1/model-pricing", { headers });
    expect(response.status).toBe(state === "active" ? 200 : state === "demoted" ? 403 : 401);
    if (state === "active") expect(unexpected).toHaveBeenCalledExactlyOnceWith();
    else expect(unexpected).not.toHaveBeenCalled();
    // Better Auth's global account endpoints must apply the same live-session
    // boundary even when its signed cookie cache still claims admin authority.
    const users = await app.request("/api/auth/admin/list-users", { headers });
    expect(users.status).toBe(state === "active" ? 200 : 403);
    if (state === "active") expect(await users.json()).toMatchObject({ users: [{ email: "authorization@users.guard.invalid" }] });
  });

  it("rechecks session expiry and role revocation on the next request", async () => {
    const { app, getSession, unexpected } = setup("admin");
    // Invalid admin input reaches schema validation, but never the service.
    const send = () => app.request("/api/v1/models/model/pricing", { method: "PUT",
      headers: { "content-type": "application/json" }, body: "{}" });
    expect((await send()).status).toBe(400);
    getSession.mockResolvedValueOnce(null);
    expect((await send()).status).toBe(401);
    getSession.mockResolvedValueOnce({ session: { id: "fixture-session", activeProjectId: "projectA" }, user: { id: "actor", role: "user", projectId: "projectA" } });
    expect((await send()).status).toBe(403);
    expect(getSession).toHaveBeenCalledTimes(3);
    expect(unexpected).not.toHaveBeenCalled();
  });

  it("allows an authenticated user to inspect Guardrail Profiles without write privileges", async () => {
    const { app, unexpected } = setup("user");
    const response = await app.request("/api/v1/guardrail-profiles");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items.map((item: { id: string }) => item.id)).toEqual([
      "default", "full-feature", "sg-bank", "cn-financial-services", "cn-internet",
    ]);
    expect(unexpected).not.toHaveBeenCalled();
    expect((await setup(null).app.request("/api/v1/guardrail-profiles")).status).toBe(401);
  });
});
