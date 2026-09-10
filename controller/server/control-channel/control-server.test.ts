import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import type { ControllerMetrics } from "../metrics.js";
import type { ModelConfigurationService } from "../model-config/service.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import { RunnerControlServer } from "./control-server.js";

const config = loadConfig({
  NODE_ENV: "test",
  CONTROLLER_DATABASE_URL: "postgresql://controller:controller@localhost/controller",
  CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters",
  CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/controller-signing-key.pem",
  CONTROLLER_PROTO_PATH: resolve("../proto/tasklattice/guard/control/v1/runner_control.proto"),
  BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
});

const assignments = {
  controlPlane: "control-model",
  bindings: {
    "content_safety.input": "safety-model",
    "content_safety.output": null,
    "jailbreak.input": null,
    "topic_control.input": null,
    "pii_semantic.input": null,
    "pii_semantic.output": null,
    "contextual_grounding.output": null,
    "automated_reasoning.output": null,
  },
};

const activeConfiguration = (revisionId: string, revision: number) => ({
  revisionId,
  revision,
  generation: 9,
  assignments,
  models: [{
    id: "safety-model",
    providerId: "provider-1",
    providerName: "Mock provider",
    baseUrl: "https://models.mock/v1",
    skipTlsVerify: true,
    credentialRef: "provider-1",
    model: "Qwen/Qwen3Guard-Gen-8B",
    profile: "tali.qwen3guard.v1" as const,
    timeoutSeconds: 20,
    maxTokens: 128,
  }, {
    id: "control-model",
    providerId: "provider-deepseek",
    providerName: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    skipTlsVerify: false,
    credentialRef: "provider-deepseek",
    model: "deepseek-v4-flash",
    profile: "generic-chat" as const,
    timeoutSeconds: 20,
    maxTokens: 512,
  }],
});

describe("Runner model-configuration convergence", () => {
  it.each([true, false])("accepts Rail evidence only from the assigned Runner with both verdicts (complete=%s)", async (complete) => {
    const models = { activeConfiguration: vi.fn().mockResolvedValue(null) };
    const server = new RunnerControlServer(config, serviceMock() as unknown as ControlPlaneService,
      metricsMock() as unknown as ControllerMetrics, models as unknown as ModelConfigurationService);
    const stream = streamMock();
    const hello = registration("compiler");
    hello.registration.compilerCapable = true;
    const connection = await handle(server, stream, hello, null);
    const otherStream = streamMock();
    const other = await handle(server, otherStream, registration("other"), null);
    const pending = server.validateRail({ requestId: "rail-test", bindingId: "content_safety.input" });
    const settled = vi.fn();
    void pending.then(settled);
    expect(stream.write).toHaveBeenCalledWith(expect.objectContaining({
      capabilityValidationRequest: expect.objectContaining({ requestId: "rail-test" }),
    }));
    const result = { capabilityValidationResult: {
      requestId: "rail-test", passed: true, runtimeProfile: "llmrails-v1", message: "samples", latencyMs: 10,
      cases: [{ expectedDecision: "allow", actualDecision: "allow", passed: true },
        { expectedDecision: complete ? "block" : "allow", actualDecision: complete ? "block" : "allow", passed: true }],
    } };
    await handle(server, otherStream, result, other);
    expect(settled).not.toHaveBeenCalled();
    await handle(server, stream, result, connection);
    expect((await pending).passed).toBe(complete);
    await server.stop();
  });

  it("finalizes only after every connected Runner ACKs the same revision", async () => {
    const service = serviceMock();
    const models = {
      activeConfiguration: vi.fn().mockResolvedValue(activeConfiguration("revision-9", 9)),
      finalizeActivation: vi.fn(),
      failActivation: vi.fn(),
    };
    const server = new RunnerControlServer(
      config,
      service as unknown as ControlPlaneService,
      metricsMock() as unknown as ControllerMetrics,
      models as unknown as ModelConfigurationService,
    );
    const firstStream = streamMock();
    const secondStream = streamMock();
    const first = await handle(server, firstStream, registration("runner-0"), null);
    const second = await handle(server, secondStream, registration("runner-1"), null);

    const dispatched = firstStream.write.mock.calls
      .map(([message]) => message.desiredState?.modelConfiguration)
      .find(Boolean);
    expect(dispatched?.runtimes).toEqual([
      expect.objectContaining({ id: "safety-model", skipTlsVerify: true }),
    ]);
    expect(dispatched?.runtimes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "control-model" }),
    ]));

    await handle(server, firstStream, desiredResult("runner-0", true), first);
    expect(models.finalizeActivation).not.toHaveBeenCalled();

    await handle(server, secondStream, desiredResult("runner-1", true), second);
    expect(models.finalizeActivation).toHaveBeenCalledOnce();
    expect(models.finalizeActivation).toHaveBeenCalledWith("revision-9");
    expect(models.failActivation).not.toHaveBeenCalled();
  });

  it("NACKs the candidate and immediately reconciles the old active revision", async () => {
    let rejected = false;
    const service = serviceMock();
    const models = {
      activeConfiguration: vi.fn(async () => activeConfiguration(
        rejected ? "revision-8" : "revision-9",
        rejected ? 8 : 9,
      )),
      finalizeActivation: vi.fn(),
      failActivation: vi.fn(async () => { rejected = true; }),
    };
    const server = new RunnerControlServer(
      config,
      service as unknown as ControlPlaneService,
      metricsMock() as unknown as ControllerMetrics,
      models as unknown as ModelConfigurationService,
    );
    const stream = streamMock();
    const connection = await handle(server, stream, registration("runner-0"), null);

    await handle(server, stream, desiredResult("runner-0", false, "provider prewarm failed"), connection);

    expect(models.failActivation).toHaveBeenCalledWith(
      "revision-9",
      "provider prewarm failed",
    );
    expect(models.finalizeActivation).not.toHaveBeenCalled();
    const desiredWrites = stream.write.mock.calls
      .map(([message]) => message.desiredState)
      .filter(Boolean);
    expect(desiredWrites.at(-1)?.modelConfiguration?.revisionId).toBe("revision-8");
  });
});

function serviceMock() {
  return {
    registerRunner: vi.fn().mockResolvedValue(9),
    desiredStateForPool: vi.fn().mockResolvedValue({
      generation: 9,
      artifacts: [],
      disabledGuardrailIds: [],
      disabledEndpointIds: [],
      routers: [],
      endpoints: [],
      guardrailLoggingLevels: {},
    }),
    desiredGeneration: vi.fn().mockResolvedValue(9),
    disconnectRunner: vi.fn(),
  };
}

function metricsMock() {
  return {
    observeControlMessage: vi.fn(),
    controlConnection: vi.fn(),
    observeReconcile: vi.fn(),
    observeArtifactResult: vi.fn(),
    observeJob: vi.fn(),
    observeHeartbeat: vi.fn(),
  };
}

function streamMock() {
  return { write: vi.fn(), end: vi.fn() };
}

function registration(runnerId: string) {
  return {
    registration: {
      runnerId,
      bootId: `boot-${runnerId}`,
      poolId: "default",
      runnerVersion: "test",
      nemoVersion: "test",
      maxConcurrency: 4,
      compilerCapable: false,
      labels: {},
      appliedGeneration: "0",
    },
  };
}

function desiredResult(runnerId: string, accepted: boolean, reason = "") {
  return {
    desiredStateResult: {
      runnerId,
      generation: "9",
      accepted,
      reason,
      modelRevisionId: "revision-9",
    },
  };
}

async function handle(
  server: RunnerControlServer,
  stream: ReturnType<typeof streamMock>,
  message: Record<string, unknown>,
  current: unknown,
) {
  return (server as unknown as {
    handleMessage: (
      stream: unknown,
      message: Record<string, unknown>,
      current: unknown,
    ) => Promise<unknown>;
  }).handleMessage(stream, message, current);
}
