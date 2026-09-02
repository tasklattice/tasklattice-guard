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
  control_plane: null,
  safety_evaluator: "safety-model",
  jailbreak_evaluator: null,
  topic_policy_judge: null,
  grounding_judge: null,
  automated_reasoning: null,
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
    baseUrl: "http://models.mock/v1",
    credentialRef: "provider-1",
    model: "Qwen/Qwen3Guard-Gen-8B",
    profile: "tali.qwen3guard.v1" as const,
    timeoutSeconds: 20,
    maxTokens: 128,
  }],
});

describe("Runner model-configuration convergence", () => {
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
      disabledIntegrationIds: [],
      deployments: [],
      integrations: [],
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
