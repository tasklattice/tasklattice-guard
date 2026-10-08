// @vitest-environment node
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ControllerAuth } from "../auth.js";
import { loadConfig } from "../config.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import { createHttpApp } from "./app.js";

const version = "20261007-010000.000Z";
const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://controller:controller@localhost/controller",
  CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/controller-signing-key.pem",
  CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"), BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters" });
function setup() {
  const markGuardrailVersionLatest = vi.fn().mockResolvedValue({ guardrailId: "guard-1", version, status: "ready", artifactId: "artifact-1" });
  const distributeDesiredState = vi.fn();
  const app = createHttpApp({ config,
    auth: { api: { getSession: vi.fn().mockResolvedValue({ user: { id: "admin-1", role: "admin" } }) }, handler: vi.fn() } as unknown as ControllerAuth,
    service: { markGuardrailVersionLatest } as unknown as ControlPlaneService,
    runnerControl: { distributeDesiredState } as unknown as RunnerControlServer, metrics: {} as ControllerMetrics });
  return { app, markGuardrailVersionLatest, distributeDesiredState };
}
describe("Mark active HTTP contract", () => {
  it("selects an exact existing version via PUT active-version", async () => {
    const { app, markGuardrailVersionLatest, distributeDesiredState } = setup();
    const response = await app.request("/api/v1/guardrails/guard-1/latest-version", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ version }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ version, artifactId: "artifact-1" });
    expect(markGuardrailVersionLatest).toHaveBeenCalledExactlyOnceWith({ guardrailId: "guard-1", version, actorId: "admin-1" });
    expect(distributeDesiredState).toHaveBeenCalledTimes(1);
  });
  it("rejects an invalid version without changing the active pointer", async () => {
    const { app, markGuardrailVersionLatest } = setup();
    const response = await app.request("/api/v1/guardrails/guard-1/latest-version", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: "latest" }) });
    expect(response.status).toBe(400);
    expect(markGuardrailVersionLatest).not.toHaveBeenCalled();
  });
  it("removes the old Guardrail rollback endpoint", async () => {
    const { app, markGuardrailVersionLatest } = setup();
    const response = await app.request("/api/v1/guardrails/guard-1/rollback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version }) });
    expect(response.status).toBe(404);
    expect(markGuardrailVersionLatest).not.toHaveBeenCalled();
  });
});
