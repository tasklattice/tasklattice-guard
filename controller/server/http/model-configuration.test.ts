import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ControllerAuth } from "../auth.js";
import { loadConfig } from "../config.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
import type { ModelConfigurationService } from "../model-config/service.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import { createHttpApp } from "./app.js";

const config = loadConfig({
  NODE_ENV: "test",
  CONTROLLER_DATABASE_URL: "postgresql://controller:controller@localhost/controller",
  CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters",
  CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/controller-signing-key.pem",
  CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"),
  BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
});

const now = new Date("2026-09-01T00:00:00Z");
const assignments = {
  controlPlane: null,
  detectors: {
    content_safety: null,
    jailbreak_detection: null,
    topic_control: null,
    pii_detection: null,
    contextual_grounding: null,
    automated_reasoning: null,
  },
};
const revision = {
  id: "891d8aec-4447-4447-8447-891d8aec4447",
  revision: 1,
  state: "validated",
  generation: null,
  assignments,
  validationReport: { valid: true, checkedAt: now.toISOString(), checks: [], contractCoverage: [], policies: [] },
  failureReason: null,
  validatedAt: now,
  activatedAt: null,
  createdAt: now,
  updatedAt: now,
};
const view = { providers: [], models: [], draft: revision, active: null, activating: null, failed: null };

describe("Model configuration HTTP routes", () => {
  it("only lets administrators configure a registered model protocol", async () => {
    const input = { profile: "tali.qwen3guard.v1", timeoutSeconds: 20, maxTokens: 512 };
    const models = { configureModel: vi.fn().mockResolvedValue({ id: "model-1", status: "pending", ...input }) };
    const options = { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input) };
    expect((await appWith("user", models).request("/api/v1/models/model-1/protocol", options)).status).toBe(403);
    expect(models.configureModel).not.toHaveBeenCalled();
    expect((await appWith("admin", models).request("/api/v1/models/model-1/protocol", options)).status).toBe(200);
    expect(models.configureModel).toHaveBeenCalledWith("model-1", input, "admin-1");
  });
  it("protects draft discovery and registration with administrator authorization", async () => {
    const models = { discoverProviderDraft: vi.fn(), registerProviderModels: vi.fn() };
    const app = appWith("user", models);
    for (const action of ["discover", "register"]) {
      const response = await app.request(`/api/v1/model-providers/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(response.status).toBe(403);
    }
    expect(models.discoverProviderDraft).not.toHaveBeenCalled();
    expect(models.registerProviderModels).not.toHaveBeenCalled();
  });

  it("passes reviewed registration data to the service as the authenticated administrator", async () => {
    const connection = { name: "DeepSeek", kind: "deepseek", baseUrl: "https://api.deepseek.com/v1", apiKey: "test-key" };
    const selection = { name: "DeepSeek Chat", model: "deepseek-chat", profile: "generic-chat", timeoutSeconds: 20, maxTokens: 512 };
    const models = { discoverProviderDraft: vi.fn().mockResolvedValue({ models: [] }), registerProviderModels: vi.fn().mockResolvedValue({ models: [], failures: [] }) };
    const app = appWith("admin", models);
    const discovery = await app.request("/api/v1/model-providers/discover", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(connection) });
    expect(discovery.status).toBe(200);
    expect(models.discoverProviderDraft).toHaveBeenCalledWith({ ...connection, skipTlsVerify: false });
    const result = await app.request("/api/v1/model-providers/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ connection, models: [selection] }) });
    expect(result.status).toBe(201);
    expect(models.registerProviderModels).toHaveBeenCalledWith({ connection: { ...connection, skipTlsVerify: false }, models: [selection] }, "admin-1");
  });
  it("lets authenticated members read the safe configuration projection", async () => {
    const models = { view: vi.fn().mockResolvedValue(view) };
    const app = appWith("user", models);
    const response = await app.request("/api/v1/model-configuration");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ draft: { revision: 1 }, providers: [] });
  });

  it("requires an administrator to create Providers", async () => {
    const app = appWith("user", { createProvider: vi.fn() });
    const response = await app.request("/api/v1/model-providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Private gateway", kind: "vllm", baseUrl: "http://models.internal/v1", apiKey: "secret" }),
    });
    expect(response.status).toBe(403);
  });

  it("routes model-call checks separately from capability validation", async () => {
    const models = { testModelConnection: vi.fn().mockResolvedValue({ connectionStatus: "validated", status: "pending" }), revalidateModel: vi.fn() };
    const response = await appWith("admin", models).request("/api/v1/models/model-1/test-connection", { method: "POST" });
    expect(response.status).toBe(200);
    expect(models.testModelConnection).toHaveBeenCalledWith("model-1", "admin-1");
    expect(models.revalidateModel).not.toHaveBeenCalled();
    expect((await appWith("user", models).request("/api/v1/models/model-1/test-connection", { method: "POST" })).status).toBe(403);
    expect(models.testModelConnection).toHaveBeenCalledOnce();
  });

  it("discovers Models from stored Provider credentials", async () => {
    const providerId = "2da89935-e001-4a43-a47b-95f419666bb0";
    const models = {
      discoverProviderModels: vi.fn().mockResolvedValue({
        providerId,
        providerName: "NVIDIA API Catalog",
        models: [{ id: "nvidia/llama-3.1-nemotron-safety-guard-8b-v3", name: "nvidia/llama-3.1-nemotron-safety-guard-8b-v3" }],
      }),
    };
    const app = appWith("admin", models);

    const response = await app.request(`/api/v1/model-providers/${providerId}/discover`, { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ providerId, models: [{ id: "nvidia/llama-3.1-nemotron-safety-guard-8b-v3" }] });
    expect(models.discoverProviderModels).toHaveBeenCalledWith(providerId);
  });

  it("returns a conflict when Runner rejects an activation", async () => {
    const failed = { ...revision, state: "failed", failureReason: "Provider prewarm failed." };
    const models = {
      beginActivation: vi.fn().mockResolvedValue({ ...revision, state: "activating", generation: 9 }),
      finalizeActivation: vi.fn(),
      view: vi.fn().mockResolvedValue({ ...view, failed }),
    };
    const app = appWith("admin", models, {
      distributeDesiredState: vi.fn().mockResolvedValue({ desiredGeneration: 9, distributionStatus: "syncing" }),
    });
    const response = await app.request(`/api/v1/model-configuration/${revision.id}/activate`, { method: "POST" });
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).toContain("Provider prewarm failed");
  });

  it("saves and validates a draft as the authenticated administrator", async () => {
    const models = {
      updateDraft: vi.fn().mockResolvedValue({ ...revision, state: "draft" }),
      validateDraft: vi.fn().mockResolvedValue(revision),
    };
    const app = appWith("admin", models);
    const saved = await app.request("/api/v1/model-configuration/draft", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(assignments),
    });
    const validated = await app.request("/api/v1/model-configuration/validate", {
      method: "POST",
    });

    expect(saved.status).toBe(200);
    expect(validated.status).toBe(200);
    expect(models.updateDraft).toHaveBeenCalledWith(assignments, "admin-1");
    expect(models.validateDraft).toHaveBeenCalledWith("admin-1");
  });

  it("finalizes an activation only after Runner distribution reports ready", async () => {
    const activeView = { ...view, draft: { ...revision, state: "draft" }, active: { ...revision, state: "active" } };
    const models = {
      beginActivation: vi.fn().mockResolvedValue({ ...revision, state: "activating", generation: 9 }),
      finalizeActivation: vi.fn(),
      view: vi.fn().mockResolvedValue(activeView),
    };
    const app = appWith("admin", models, {
      distributeDesiredState: vi.fn().mockResolvedValue({ desiredGeneration: 9, distributionStatus: "ready" }),
    });

    const response = await app.request(`/api/v1/model-configuration/${revision.id}/activate`, { method: "POST" });

    expect(response.status).toBe(200);
    expect(models.finalizeActivation).toHaveBeenCalledWith(revision.id);
  });

  it("leases only allow-listed credentials to an authenticated Runner", async () => {
    const providerId = "2da89935-e001-4a43-a47b-95f419666bb0";
    const models = {
      resolveCredentials: vi.fn().mockResolvedValue({ [providerId]: "leased-secret" }),
    };
    const app = appWith("admin", models);
    const anonymous = await app.request("/api/internal/v1/model-credentials/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refs: [providerId, "33dcc196-94f6-42ac-b104-0c975b3be5ef"] }),
    });
    const runner = await app.request("/api/internal/v1/model-credentials/resolve", {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.runnerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ refs: [providerId, "33dcc196-94f6-42ac-b104-0c975b3be5ef"] }),
    });

    expect(anonymous.status).toBe(401);
    expect(runner.status).toBe(200);
    expect(await runner.json()).toEqual({ credentials: { [providerId]: "leased-secret" } });
    expect(models.resolveCredentials).toHaveBeenCalledWith([
      providerId,
      "33dcc196-94f6-42ac-b104-0c975b3be5ef",
    ]);
  });
});

function appWith(
  role: "admin" | "user",
  models: Partial<ModelConfigurationService>,
  runnerControl: Partial<RunnerControlServer> = {},
) {
  const auth = {
    api: { getSession: vi.fn().mockResolvedValue({ user: { id: `${role}-1`, role } }) },
    handler: vi.fn(),
  } as unknown as ControllerAuth;
  return createHttpApp({
    config,
    auth,
    service: {} as ControlPlaneService,
    runnerControl: {
      distributionStatus: vi.fn().mockResolvedValue({ desiredGeneration: 8, distributionStatus: "ready" }),
      ...runnerControl,
    } as RunnerControlServer,
    metrics: {} as ControllerMetrics,
    models: models as ModelConfigurationService,
  });
}
