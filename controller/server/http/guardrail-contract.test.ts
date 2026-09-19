// @vitest-environment node
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ControllerAuth } from "../auth.js";
import { loadConfig } from "../config.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
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

const draftConfig = {
  allowedTopics: ["Order status"],
  restrictedTopics: [],
  policyBindings: [{
    policyId: "builtin-topic-safety",
    policyVersion: "1.0.0",
    action: "redirect",
    parameterValues: {},
    enabledRuleIds: ["model/topic-control"],
    ruleActions: {},
    enabledRails: ["input"],
    reasoningPolicy: null,
  }],
  safetyLevel: "balanced",
  outputDelivery: "full_buffered",
};

describe("Guardrail HTTP contract", () => {
  it("creates a Guardrail using only a name and Policy bindings", async () => {
    const createGuardrail = vi.fn().mockResolvedValue({ id: "guard-1", name: "Support", draftConfig });
    const response = await appWith(createGuardrail).request("/api/v1/guardrails", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Support", draftConfig, runtimeProfile: "auto" }),
    });

    expect(response.status).toBe(201);
    expect(createGuardrail.mock.calls[0]![0]).toMatchObject({ name: "Support", draftConfig });
    expect(createGuardrail.mock.calls[0]![0]).not.toHaveProperty("description");
  });

  it.each([
    { description: "Retired description" },
    { purpose: "Retired purpose" },
    { draftConfig: { ...draftConfig, purposeDetails: { tasks: "Retired identity" } } },
  ])("rejects removed business-purpose fields instead of keeping aliases: %j", async (retired) => {
    const createGuardrail = vi.fn();
    const response = await appWith(createGuardrail).request("/api/v1/guardrails", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Support", draftConfig, ...retired }),
    });
    expect(response.status).toBe(400);
    expect(createGuardrail).not.toHaveBeenCalled();
  });

  it("accepts denied topics and the selected mode", async () => {
    const createGuardrail = vi.fn().mockResolvedValue({ id: "created" });
    const response = await appWith(createGuardrail).request("/api/v1/guardrails", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Support",
        draftConfig: { ...draftConfig, restrictedTopics: ["Medical advice"], topicControlMode: "permissive" },
        runtimeProfile: "auto",
      }),
    });

    expect(response.status).toBe(201);
    expect(createGuardrail).toHaveBeenCalledWith(expect.objectContaining({ draftConfig: expect.objectContaining({ restrictedTopics: ["Medical advice"], topicControlMode: "permissive" }) }));
  });
});

function appWith(createGuardrail: ReturnType<typeof vi.fn>) {
  const auth = {
    api: { getSession: vi.fn().mockResolvedValue({ user: { id: "admin-1", role: "admin" } }) },
    handler: vi.fn(),
  } as unknown as ControllerAuth;
  return createHttpApp({
    config,
    auth,
    service: { createGuardrail } as unknown as ControlPlaneService,
    runnerControl: {} as RunnerControlServer,
    metrics: {} as ControllerMetrics,
  });
}
