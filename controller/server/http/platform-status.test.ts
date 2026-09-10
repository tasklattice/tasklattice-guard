import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Registry } from "prom-client";
import type { BasicProtectionSnapshot, PlatformStatusSnapshot } from "../../shared/platform-status.js";
import type { ControllerAuth } from "../auth.js";
import { loadConfig } from "../config.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
import type { ModelConfigurationService } from "../model-config/service.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import { createHttpApp } from "./app.js";

const configured: BasicProtectionSnapshot = {
  status: "ready", guardrailStatus: "active", routerStatus: "active", activeVersion: "published-v1", modelIndependent: true,
  coverage: { policyCount: 2, inputChecks: 2, outputChecks: 1, requiredModelBindings: [], hasUnknownDependencies: false },
  draft: { revision: 2, activeRevision: 1, validationStatus: "failed", validationFailureReason: "New draft failed" },
};

async function snapshot({ protection = configured, instances = [{ status: "ready", appliedGeneration: 7, lastHeartbeatAt: new Date() }],
  bindings = [] as string[], capacity = instances.length } = {}) {
  const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://test:test@localhost/test",
    CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/test-key.pem",
    CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"), BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters" });
  const app = createHttpApp({ config, auth: { handler: vi.fn(), api: {} } as unknown as ControllerAuth,
    service: { desiredGeneration: vi.fn().mockResolvedValue(7), defaultGuardrailReadiness: vi.fn().mockResolvedValue(protection),
      listRunnerPoolsWithCapacity: vi.fn().mockResolvedValue([{ isDefault: true, desiredReplicas: 1, instances,
        capacity: { readyRunners: capacity, status: "ready" } }]),
    } as unknown as ControlPlaneService,
    models: { statusSummary: vi.fn().mockResolvedValue({
      controlPlane: { status: "unconfigured", provider: null, model: null },
      dataPlane: { status: bindings.length ? "configured" : "unconfigured", provider: "Runner", models: bindings.map((id) => ({ id, model: "registered-model" })) },
    }) } as unknown as ModelConfigurationService,
    runnerControl: {} as RunnerControlServer, metrics: { registry: new Registry() } as ControllerMetrics,
  });
  const response = await app.request("/api/v1/system/status");
  return { code: response.status, body: await response.json() as PlatformStatusSnapshot };
}

describe("Health endpoint evidence", () => {
  it("keeps a local active release ready with no models and a failed unpublished draft", async () => {
    const { code, body } = await snapshot();
    expect(code).toBe(200);
    expect(body.status).toBe("healthy");
    expect(body.components.basicProtection).toMatchObject({ status: "ready", draft: { validationStatus: "failed", activeRevision: 1 } });
    expect(body.components.runtimeModels.status).toBe("unconfigured");
  });
  it("does not claim basic protection if the configured router has no Runner", async () => {
    const { code, body } = await snapshot({ instances: [] });
    expect(code).toBe(503);
    expect(body.components.basicProtection).toMatchObject({ status: "unavailable", routerStatus: "active" });
    expect(body.reasons).toContain("no_connected_runners");
    expect(body.reasons).not.toContain("all_required_components_ready");
  });
  it("rejects stale heartbeat evidence even before the offline sweeper runs", async () => {
    const { code, body } = await snapshot({ instances: [{ status: "ready", appliedGeneration: 7, lastHeartbeatAt: new Date(0) }] });
    expect(code).toBe(503);
    expect(body.components.basicProtection.status).toBe("unavailable");
    expect(body.components.runnerFleet.servingRunners).toBe(0);
    expect(body.reasons).toContain("runner_heartbeat_stale");
  });
  it("shows initialization when persisted ready Runners have not loaded the current generation", async () => {
    const { code, body } = await snapshot({ instances: [{ status: "ready", appliedGeneration: 6, lastHeartbeatAt: new Date() }] });
    expect(code).toBe(503);
    expect(body.status).toBe("initializing");
    expect(body.components.basicProtection.status).toBe("initializing");
  });
  it("requires the correct Input or Output model binding, not just any configured model", async () => {
    const protection = { ...configured, modelIndependent: false, coverage: { ...configured.coverage!, requiredModelBindings: ["content_safety.output" as const] } };
    const missing = await snapshot({ protection, bindings: ["content_safety.input"] });
    expect(missing.code).toBe(503);
    expect(missing.body.components.basicProtection.status).toBe("unavailable");
    expect(missing.body.reasons).toContain("default_model_bindings_missing");
    const ready = await snapshot({ protection, bindings: ["content_safety.output"] });
    expect(ready.code).toBe(200);
    expect(ready.body.components.basicProtection.status).toBe("ready");
    // Assignment + Runner readiness is not a live model-call probe.
    expect(ready.body.components.runtimeModels.status).toBe("configured");
  });
  it("keeps unknown custom dependencies visible without calling a loaded release model-free", async () => {
    const { code, body } = await snapshot({ protection: { ...configured, modelIndependent: null,
      coverage: { ...configured.coverage!, hasUnknownDependencies: true } } });
    expect(code).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.reasons).toContain("default_dependencies_unknown");
    expect(body.components.basicProtection.modelIndependent).toBeNull();
  });
});
