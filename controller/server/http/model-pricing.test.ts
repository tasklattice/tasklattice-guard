import { runnerAuthEnv } from "../../test/runner-auth-fixture.js";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ControllerAuth } from "../auth.js";
import { loadConfig } from "../config.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import { createHttpApp } from "./app.js";
const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://controller:controller@localhost/controller", ...runnerAuthEnv("runner-token-that-is-at-least-32-characters"), CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/signing-key.pem", CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"), BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters" });
const pricing = { view: vi.fn().mockResolvedValue({ models: [] }), guardrailUsage: vi.fn().mockResolvedValue({ calls: 0 }), configure: vi.fn().mockResolvedValue({}) };
const app = (role: string) => createHttpApp({ config, auth: { api: { getSession: async () => ({ session: { id: "fixture-session", activeProjectId: "projectA" }, user: { id: "actor", role, projectId: "projectA" } }) }, handler: vi.fn() } as unknown as ControllerAuth, service: { pricing } as unknown as ControlPlaneService, runnerControl: {} as RunnerControlServer, metrics: {} as ControllerMetrics });
describe("model price and usage permissions", () => {
  it("lets users read Guardrail usage while reserving platform pricing for administrators", async () => {
    expect((await app("user").request("/api/v1/model-pricing")).status).toBe(403);
    expect((await app("user").request("/api/v1/guardrails/g/usage-costs?window=7d&source=testing")).status).toBe(200);
    expect(pricing.guardrailUsage).toHaveBeenCalledWith("g", { window: "7d", source: "testing" });
    const options = { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "manual", rates: { unit: "free", currency: "USD" } }) };
    expect((await app("user").request("/api/v1/models/m/pricing", options)).status).toBe(403);
    expect(pricing.configure).not.toHaveBeenCalled();
    expect((await app("admin").request("/api/v1/models/m/pricing", options)).status).toBe(200);
    expect(pricing.configure).toHaveBeenCalledWith("m", { mode: "manual", catalogKey: null, rates: { unit: "free", currency: "USD" } }, "actor");
  });
  it("rejects unknown periods and malformed manual prices", async () => {
    expect((await app("user").request("/api/v1/guardrails/g/usage-costs?window=year")).status).toBe(400);
    const response = await app("admin").request("/api/v1/models/m/pricing", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "manual", rates: { unit: "token", input: -1, output: 2, currency: "USD" } }) });
    expect(response.status).toBe(400);
    expect((await app("admin").request("/api/v1/models/m/pricing", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "manual", rates: { unit: "free", currency: "CNY" } }) })).status).toBe(400);
  });
});
