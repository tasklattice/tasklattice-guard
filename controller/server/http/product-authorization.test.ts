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
  CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters",
  CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/controller-signing-key.pem",
  CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"),
  BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
});

// Explicit product surface inventory, independent of middleware implementation.
// Requests deliberately carry invalid bodies: authentication/authorization must
// reject them before parsing data, invoking a model or reaching a mutation.
const adminRoutes = [
  ["POST", "/model-providers"], ["PATCH", "/model-providers/provider"],
  ["POST", "/model-providers/discover"], ["POST", "/model-providers/register"],
  ["POST", "/model-providers/provider/validate"], ["POST", "/model-providers/provider/discover"],
  ["DELETE", "/model-providers/provider"], ["POST", "/models"],
  ["POST", "/models/model/validate"], ["POST", "/models/model/test-connection"],
  ["PUT", "/models/model/protocol"], ["DELETE", "/models/model"],
  ["PUT", "/model-configuration/draft"], ["PUT", "/model-configuration/draft/assignments/content_safety.input"],
  ["POST", "/model-configuration/draft/assignments/content_safety.input/validate"],
  ["POST", "/model-configuration/validate"], ["POST", "/model-configuration/revision/activate"],
  ["POST", "/model-configuration/rollback"],
  ["POST", "/policies"], ["PATCH", "/policies/policy"], ["DELETE", "/policies/policy"],
  ["POST", "/policies/policy/validate"], ["POST", "/policies/policy/validation-runs"],
  ["POST", "/policies/policy/publish"], ["POST", "/intent-analyses"],
  ["POST", "/compliance-document-analyses"],
  ["POST", "/playground/draft-previews/guard"], ["POST", "/playground/draft-interactions/guard"],
  ["POST", "/guardrail-plan-previews"], ["POST", "/guardrails"],
  ["PATCH", "/guardrails/guard"], ["POST", "/guardrails/guard/publish"],
  ["POST", "/guardrails/guard/rollback/20260906-010000.001Z"],
  ["PATCH", "/guardrails/guard/logging"], ["GET", "/guardrails/guard/deletion-impact"],
  ["DELETE", "/guardrails/guard"], ["POST", "/test-cases"], ["DELETE", "/test-cases/case"],
  ["PATCH", "/guardrails/guard/validation-scope"], ["POST", "/validation-runs"],
  ["POST", "/endpoints"], ["PATCH", "/endpoints/endpoint"],
  ["POST", "/endpoints/endpoint/credentials"], ["DELETE", "/endpoints/endpoint/credentials/credential"],
  ["GET", "/endpoints/endpoint/deletion-impact"], ["DELETE", "/endpoints/endpoint"],
  ["PATCH", "/runner-pools/pool"], ["DELETE", "/runner-instances/runner"],
  ["POST", "/routers"], ["PATCH", "/routers/router"],
  ["PUT", "/routers/router/draft"], ["POST", "/routers/router/publish"],
  ["POST", "/routers/router/rollback"], ["PUT", "/routers/router/endpoints"],
  ["POST", "/guardrails/guard/duplicate"], ["DELETE", "/routers/router"],
] as const;

function setup(role: string | null) {
  const getSession = vi.fn().mockResolvedValue(role === null ? null : { user: { id: "actor", role } });
  const unexpected = vi.fn(() => { throw new Error("Protected service was reached"); });
  const service = new Proxy({}, { get: () => unexpected });
  const app = createHttpApp({ config,
    auth: { api: { getSession }, handler: vi.fn() } as unknown as ControllerAuth,
    service: service as ControlPlaneService, runnerControl: service as RunnerControlServer,
    metrics: {} as ControllerMetrics,
  });
  return { app, getSession, unexpected };
}

describe.each([null, "user", "unknown-role"])("Product API authorization for role %s", (role) => {
  it.each(adminRoutes)("denies %s %s before protected work", async (method, path) => {
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

describe("Session freshness and read-only access", () => {
  it.each(["active", "demoted", "revoked", "expired"])("uses current authority for a %s session despite a still-valid signed cookie cache", async (state) => {
    const data: Record<string, Array<Record<string, unknown>>> = { user: [], session: [], account: [], verification: [] };
    const options = createAuth({ ...config, publicUrl: "http://localhost:8093", trustedOrigins: ["http://localhost:8093"] }, {} as ControllerDatabase).options;
    // Real Better Auth signing, cookie cache and session lookup. Only the DB
    // adapter changes; its login timestamp hook is unrelated to authorization.
    const auth = betterAuth({ ...options, database: memoryAdapter(data), databaseHooks: undefined });
    await auth.api.signUpEmail({ body: { name: "Authorization fixture", email: "authorization@guard.test", password: "synthetic-auth-password-2026" } });
    data.user![0]!.role = "admin";
    const signedIn = await auth.api.signInEmail({ body: { email: "authorization@guard.test", password: "synthetic-auth-password-2026" }, asResponse: true });
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    expect(cookie).toContain("tali-guard.session_data=");
    const headers = new Headers({ cookie, "content-type": "application/json" });
    expect((await auth.api.getSession({ headers }))?.user.role).toBe("admin");
    if (state === "demoted") data.user![0]!.role = "user";
    else if (state === "revoked") data.session!.splice(0);
    else if (state === "expired") for (const session of data.session!) session.expiresAt = new Date(0);
    // Establish the real stale-cache condition, rather than mocking a verdict.
    expect((await auth.api.getSession({ headers }))?.user.role).toBe("admin");
    const unexpected = vi.fn().mockResolvedValue({ status: "queued" });
    const app = createHttpApp({ config, auth: auth as unknown as ControllerAuth,
      service: { requestGuardrailPublish: unexpected } as unknown as ControlPlaneService,
      runnerControl: { hasDefaultCompiler: () => true } as RunnerControlServer, metrics: {} as ControllerMetrics });
    const response = await app.request("/api/v1/guardrails/guard/publish", { method: "POST", headers });
    expect(response.status).toBe(state === "active" ? 202 : state === "demoted" ? 403 : 401);
    if (state === "active") expect(unexpected).toHaveBeenCalledExactlyOnceWith({
      guardrailId: "guard", actorId: data.user![0]!.id, compilerAvailable: true,
    });
    else expect(unexpected).not.toHaveBeenCalled();
  });

  it("rechecks session expiry and role revocation on the next request", async () => {
    const { app, getSession, unexpected } = setup("admin");
    // Invalid admin input reaches schema validation, but never the service.
    const send = () => app.request("/api/v1/guardrails", { method: "POST",
      headers: { "content-type": "application/json" }, body: "{}" });
    expect((await send()).status).toBe(400);
    getSession.mockResolvedValueOnce(null);
    expect((await send()).status).toBe(401);
    getSession.mockResolvedValueOnce({ user: { id: "actor", role: "user" } });
    expect((await send()).status).toBe(403);
    expect(getSession).toHaveBeenCalledTimes(3);
    expect(unexpected).not.toHaveBeenCalled();
  });

  it("allows an authenticated user to inspect protection presets without write privileges", async () => {
    const { app, unexpected } = setup("user");
    const response = await app.request("/api/v1/protection-presets");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([
      "common-baseline", "banking-assistant", "securities-assistant", "internet-customer-support",
    ]));
    expect(unexpected).not.toHaveBeenCalled();
    expect((await setup(null).app.request("/api/v1/protection-presets")).status).toBe(401);
  });
});
