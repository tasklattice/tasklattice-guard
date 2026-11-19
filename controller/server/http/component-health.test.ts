import { runnerAuthEnv } from "../../test/runner-auth-fixture.js";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ControllerAuth } from "../auth.js";
import { loadConfig } from "../config.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import type { ModelConfigurationService } from "../model-config/service.js";
import { createHttpApp } from "./app.js";

const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://test:test@localhost/test",
  ...runnerAuthEnv("runner-token-that-is-at-least-32-characters"), CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/test-key.pem",
  CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"), BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters" });

function setup(signedIn = true) {
  const service = {
    requiredPlatformModelBindings: vi.fn().mockResolvedValue(["jailbreak.input", "content_safety.input", "content_safety.output"]),
    listRunnerHeartbeats: vi.fn().mockResolvedValue([{ status: "syncing", lastHeartbeatAt: new Date() }]),
    defaultGuardrailReadiness: vi.fn().mockRejectedValue(new Error("No published Guardrail")),
  };
  const models = { modelHealth: vi.fn().mockResolvedValue({ status: "unhealthy", reason: "configuration_required",
    bindings: [{ id: "jailbreak.input", status: "missing" }] }) };
  const app = createHttpApp({ config, models: models as unknown as ModelConfigurationService,
    auth: { api: { getSession: vi.fn().mockResolvedValue(signedIn ? { session: { id: "fixture-session", activeProjectId: "projectA" }, user: { id: "reader", role: "admin", projectId: "projectA" } } : null) } } as unknown as ControllerAuth,
    service: service as unknown as ControlPlaneService,
    runnerControl: {} as RunnerControlServer, metrics: {} as ControllerMetrics,
  });
  return { app, service, models };
}

describe("GET /api/v1/system/health", () => {
  it("requires authentication", async () => {
    const { app, service } = setup(false);
    expect((await app.request("/api/v1/system/health")).status).toBe(401);
    expect(service.listRunnerHeartbeats).not.toHaveBeenCalled();
  });
  it("marks the platform unhealthy when required models are missing", async () => {
    const { app, service } = setup();
    const response = await app.request("/api/v1/system/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ status: "unhealthy", components: {
      controlPlane: { status: "healthy" }, dataPlane: { connectedRunners: 1, totalRunners: 1 }, models: { status: "unhealthy", reason: "configuration_required" },
    } });
    expect(service.defaultGuardrailReadiness).not.toHaveBeenCalled();
  });
  it("keeps failed active model tests visible without changing Guardrail state", async () => {
    const { app, service, models } = setup();
    models.modelHealth.mockResolvedValue({ status: "unhealthy", reason: "validation_required", bindings: [{ id: "jailbreak.input", status: "failed" }] });
    expect(await (await app.request("/api/v1/system/health")).json()).toMatchObject({ status: "unhealthy", components: {
      controlPlane: { status: "healthy" }, dataPlane: { status: "healthy" }, models: { reason: "validation_required" },
    } });
    expect(service.defaultGuardrailReadiness).not.toHaveBeenCalled();
    models.modelHealth.mockResolvedValue({ status: "healthy", reason: "configured", bindings: [] });
    expect(await (await app.request("/api/v1/system/health")).json()).toMatchObject({ status: "healthy" });
  });
  it("keeps a local platform healthy with no required or configured models", async () => {
    const { app, service, models } = setup();
    service.requiredPlatformModelBindings.mockResolvedValue([]);
    models.modelHealth.mockResolvedValue({ status: "healthy", reason: "not_required", bindings: [] });
    expect(await (await app.request("/api/v1/system/health")).json()).toMatchObject({ status: "healthy",
      components: { models: { reason: "not_required", bindings: [] } } });
    expect(models.modelHealth).toHaveBeenCalledWith([]);
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
