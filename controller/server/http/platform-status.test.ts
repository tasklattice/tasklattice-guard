import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Registry } from "prom-client";
import type { PlatformStatusSnapshot } from "../../shared/platform-status.js";
import type { ControllerAuth } from "../auth.js";
import { loadConfig } from "../config.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
import type { ModelConfigurationService } from "../model-config/service.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import { createHttpApp } from "./app.js";

async function snapshot({ instances = [{ status: "ready", appliedGeneration: 7, lastHeartbeatAt: new Date() }],
  required = [] as string[], modelReason = "configured", capacity = instances.length } = {}) {
  const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://test:test@localhost/test",
    CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/test-key.pem",
    CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"), BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters" });
  const app = createHttpApp({ config, auth: { handler: vi.fn(), api: {} } as unknown as ControllerAuth,
    service: { desiredGeneration: vi.fn().mockResolvedValue(7),
      requiredPlatformModelBindings: vi.fn().mockResolvedValue(required),
      listRunnerPoolsWithCapacity: vi.fn().mockResolvedValue([{ isDefault: true, desiredReplicas: 1, instances,
        capacity: { readyRunners: capacity, status: "ready" } }]),
    } as unknown as ControlPlaneService,
    models: { modelHealth: vi.fn().mockResolvedValue({ status: modelReason === "configured" ? "healthy" : "unavailable", reason: modelReason, bindings: [] }), statusSummary: vi.fn().mockResolvedValue({
      controlPlane: { status: "unconfigured", provider: null, model: null },
      dataPlane: { status: required.length ? "configured" : "unconfigured", provider: "Runner", models: required.map((id) => ({ id, model: "registered-model" })) },
    }) } as unknown as ModelConfigurationService,
    runnerControl: {} as RunnerControlServer, metrics: { registry: new Registry() } as ControllerMetrics,
  });
  const response = await app.request("/api/v1/system/status");
  return { code: response.status, body: await response.json() as PlatformStatusSnapshot };
}

describe("Health endpoint evidence", () => {
  it("is healthy without a global baseline or configured models", async () => {
    const { code, body } = await snapshot();
    expect(code).toBe(200);
    expect(body.status).toBe("healthy");
    expect(body.components).not.toHaveProperty("basicProtection");
    expect(body.components.runtimeModels.status).toBe("unconfigured");
  });
  it("reports missing runners independently of Guardrails", async () => {
    const { code, body } = await snapshot({ instances: [] });
    expect(code).toBe(503);
    expect(body.reasons).toContain("no_connected_runners");
    expect(body.reasons).not.toContain("all_required_components_ready");
  });
  it("rejects stale heartbeat evidence before the offline sweeper runs", async () => {
    const { code, body } = await snapshot({ instances: [{ status: "ready", appliedGeneration: 7, lastHeartbeatAt: new Date(0) }] });
    expect(code).toBe(503);
    expect(body.components.runnerFleet.servingRunners).toBe(0);
    expect(body.reasons).toContain("runner_heartbeat_stale");
  });
  it("shows initialization until the current generation is loaded", async () => {
    const { code, body } = await snapshot({ instances: [{ status: "ready", appliedGeneration: 6, lastHeartbeatAt: new Date() }] });
    expect(code).toBe(503);
    expect(body.status).toBe("initializing");
    expect(body.reasons).toContain("runner_configuration_syncing");
  });
  it.each([["configuration_required", "required_model_bindings_missing"], ["validation_required", "model_validation_required"]])(
    "reports %s for models required by routed protections", async (modelReason, reason) => {
      const { code, body } = await snapshot({ required: ["content_safety.input"], modelReason });
      expect(code).toBe(503);
      expect(body.reasons).toContain(reason);
      expect(body.reasons).not.toContain("all_required_components_ready");
    });
});
