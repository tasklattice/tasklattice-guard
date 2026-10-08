import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ControllerAuth } from "../auth.js";
import { loadConfig } from "../config.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import { createHttpApp } from "./app.js";

const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://test:test@localhost/test",
  CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/test-key.pem",
  CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"), BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters" });

function setup(signedIn = true) {
  const service = {
    listRunnerHeartbeats: vi.fn().mockResolvedValue([{ status: "syncing", lastHeartbeatAt: new Date() }]),
    defaultGuardrailReadiness: vi.fn().mockRejectedValue(new Error("No published Guardrail")),
  };
  const app = createHttpApp({ config,
    auth: { api: { getSession: vi.fn().mockResolvedValue(signedIn ? { user: { id: "reader", role: "user" } } : null) } } as unknown as ControllerAuth,
    service: service as unknown as ControlPlaneService,
    runnerControl: {} as RunnerControlServer, metrics: {} as ControllerMetrics,
  });
  return { app, service };
}

describe("GET /api/v1/system/health", () => {
  it("requires authentication", async () => {
    const { app, service } = setup(false);
    expect((await app.request("/api/v1/system/health")).status).toBe(401);
    expect(service.listRunnerHeartbeats).not.toHaveBeenCalled();
  });
  it("returns fresh component evidence without checking Guardrail publication or model configuration", async () => {
    const { app, service } = setup();
    const response = await app.request("/api/v1/system/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ status: "healthy", components: {
      controlPlane: { status: "healthy" }, dataPlane: { connectedRunners: 1, totalRunners: 1 },
    } });
    expect(service.defaultGuardrailReadiness).not.toHaveBeenCalled();
  });
  it("distinguishes a failed Controller store check from unknown Runner health", async () => {
    const { app, service } = setup();
    service.listRunnerHeartbeats.mockRejectedValue(new Error("Storage unavailable"));
    const response = await app.request("/api/v1/system/health");
    expect(await response.json()).toMatchObject({ status: "unhealthy", components: {
      controlPlane: { status: "unhealthy", reason: "storage_unavailable" }, dataPlane: { status: "unknown" },
    } });
  });
});
