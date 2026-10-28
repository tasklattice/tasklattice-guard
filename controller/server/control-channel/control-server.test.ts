import { resolve } from "node:path";
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import type { ControllerMetrics } from "../metrics.js";
import type { ModelConfigurationService } from "../model-config/service.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import { RunnerControlServer } from "./control-server.js";
import { PLAN_COMPILER_VERSION, NEMO_COMPILER_VERSION } from "../domain/artifact-execution-contract.js";

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
  it("retries durable cancellation before new work, even with stale models, until cleanup is acknowledged", async () => {
    const cancel = { id: "cancel-stop", payload: { runId: "stop" }, createdAt: new Date() };
    const service = { ...serviceMock(),
      pendingOutbox: vi.fn(async (kind: string) => kind === "guardrail.validation_cancel_requested" ? [cancel] : []),
      markOutboxProcessed: vi.fn(), completeValidation: vi.fn(), rejectValidation: vi.fn(), markValidationRunning: vi.fn(),
    };
    const server = new RunnerControlServer(config, service as unknown as ControlPlaneService,
      metricsMock() as unknown as ControllerMetrics, { activeConfiguration: vi.fn().mockResolvedValue(activeConfiguration("revision-9", 9)) } as unknown as ModelConfigurationService);
    const stream = streamMock(), hello = registration("compiler-0"); hello.registration.compilerCapable = true;
    const connection = await handle(server, stream, hello, null);
    stream.write.mockClear();
    const dispatch = () => (server as unknown as { dispatchValidationRequests(): Promise<void> }).dispatchValidationRequests();
    await dispatch(); await dispatch();
    expect(stream.write).toHaveBeenCalledTimes(2);
    expect(stream.write).toHaveBeenLastCalledWith(expect.objectContaining({ validationCancelRequest: { runId: "stop" } }));
    expect(service.markValidationRunning).not.toHaveBeenCalled();
    await handle(server, stream, { validationResult: { runnerId: "compiler-0", runId: "stop", accepted: true,
      status: "VALIDATION_STATUS_CANCELLED" } }, connection);
    expect(service.markOutboxProcessed).toHaveBeenCalledWith("cancel-stop");
    expect(service.completeValidation).not.toHaveBeenCalled();
    expect(service.rejectValidation).not.toHaveBeenCalled();
  });

  it("does not dispatch a queued snapshot that was cancelled before the claim", async () => {
    const event = { id: "stop", createdAt: new Date(), payload: { runId: "stop" } };
    const service = { ...serviceMock(), pendingOutbox: vi.fn(async (kind: string) => kind === "guardrail.validation_requested" ? [event] : []),
      markValidationRunning: vi.fn().mockResolvedValue(false), deferOutbox: vi.fn() };
    const server = new RunnerControlServer(config, service as unknown as ControlPlaneService,
      metricsMock() as unknown as ControllerMetrics, { activeConfiguration: vi.fn().mockResolvedValue(null) } as unknown as ModelConfigurationService);
    const stream = streamMock(), hello = registration("compiler-0"); hello.registration.compilerCapable = true;
    await handle(server, stream, hello, null); stream.write.mockClear();
    await (server as unknown as { dispatchValidationRequests(): Promise<void> }).dispatchValidationRequests();
    expect(stream.write).not.toHaveBeenCalled();
    expect(service.deferOutbox).not.toHaveBeenCalled();
  });
  it.each(["guardrail.validation_requested", "policy.validation_requested"])("waits for applied model assignments before dispatching %s", async kind => {
    const event = { id: "model-job", createdAt: new Date(), payload: { runId: "model-run", testCases: [],
      plan: { guardrail_version: "20261026-030000.000Z", safety_level: "strict", output_delivery: "full_buffered" } } };
    const service = { ...serviceMock(), pendingOutbox: vi.fn(async (type: string) => type === kind ? [event] : []),
      markValidationRunning: vi.fn(), deferOutbox: vi.fn() };
    const models = { activeConfiguration: vi.fn().mockResolvedValue(activeConfiguration("revision-9", 9)), finalizeActivation: vi.fn() };
    const server = new RunnerControlServer(config, service as unknown as ControlPlaneService,
      metricsMock() as unknown as ControllerMetrics, models as unknown as ModelConfigurationService);
    const stream = streamMock(), hello = registration("compiler-0");
    hello.registration.compilerCapable = true;
    const connection = await handle(server, stream, hello, null);
    const dispatch = () => (server as unknown as { dispatchValidationRequests(): Promise<void> }).dispatchValidationRequests();
    stream.write.mockClear();
    await dispatch();
    expect(service.markValidationRunning).not.toHaveBeenCalled();
    expect(stream.write).not.toHaveBeenCalled();
    await handle(server, stream, desiredResult("compiler-0", true), connection);
    // A delayed acknowledgement cannot roll back the dependency identity.
    await handle(server, stream, { desiredStateResult: { runnerId: "compiler-0", accepted: true, generation: "8", modelRevisionId: "revision-8" } }, connection);
    await dispatch();
    expect(service.markValidationRunning).toHaveBeenCalledExactlyOnceWith("model-job");
    expect(stream.write).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ validationRequest: expect.objectContaining({ runId: "model-run" }) }));
  });

  it("waits for ordinal 0 even while ordinal 1 has synchronized models", async () => {
    const event = { id: "job", createdAt: new Date(), payload: { runId: "run", testCases: [], plan: { guardrail_version: "20261026-030000.000Z", safety_level: "strict", output_delivery: "full_buffered" } } };
    const service = { ...serviceMock(), pendingOutbox: vi.fn(async (kind: string) => kind === "guardrail.validation_requested" ? [event] : []),
      markValidationRunning: vi.fn(), deferOutbox: vi.fn() };
    const models = { activeConfiguration: vi.fn().mockResolvedValue(activeConfiguration("revision-9", 9)), finalizeActivation: vi.fn() };
    const server = new RunnerControlServer(config, service as unknown as ControlPlaneService,
      metricsMock() as unknown as ControllerMetrics, models as unknown as ModelConfigurationService);
    const streams = [streamMock(), streamMock()];
    for (const [index, stream] of streams.entries()) {
      const hello = registration(`compiler-${index}`); hello.registration.compilerCapable = true;
      const connection = await handle(server, stream, hello, null);
      if (index === 1) await handle(server, stream, desiredResult("compiler-1", true), connection);
      stream.write.mockClear();
    }
    await (server as unknown as { dispatchValidationRequests(): Promise<void> }).dispatchValidationRequests();
    expect(streams[0]!.write).not.toHaveBeenCalled();
    expect(streams[1]!.write).not.toHaveBeenCalled();
    expect(service.markValidationRunning).not.toHaveBeenCalled();
  });

  it("reports synchronization as pending and retries environment admission after the model ACK", async () => {
    const models = { activeConfiguration: vi.fn().mockResolvedValue(activeConfiguration("revision-9", 9)), finalizeActivation: vi.fn() };
    const server = new RunnerControlServer(config, serviceMock() as unknown as ControlPlaneService,
      metricsMock() as unknown as ControllerMetrics, models as unknown as ModelConfigurationService);
    const stream = streamMock();
    const connection = await handle(server, stream, registration("runner"), null);
    const artifact = { id: "artifact", generation: 1, checksum: "digest", signature: "signature", guardrailId: "guard", guardrailVersion: "20261026-030000.000Z",
      compilerVersion: NEMO_COMPILER_VERSION, nemoVersion: "test", runtimeProfile: "auto", plan: { compiler_version: PLAN_COMPILER_VERSION, guardrail_version: "20261026-030000.000Z", safety_level: "strict", output_delivery: "full_buffered" }, configYaml: "", colangContent: "", prompts: [], actionBindings: [], dependencyManifest: [] };
    stream.write.mockClear();
    expect(await server.checkArtifactAdmission(artifact)).toEqual([expect.objectContaining({ unavailable: true, admitted: false, reason: expect.stringContaining("still applying") })]);
    expect(stream.write).not.toHaveBeenCalled();
    await handle(server, stream, desiredResult("runner", true), connection);
    const checking = server.checkArtifactAdmission(artifact);
    await vi.waitFor(() => expect(stream.write).toHaveBeenCalledOnce());
    const { requestId } = stream.write.mock.calls[0]![0].artifactAdmissionRequest;
    await handle(server, stream, { artifactAdmissionResult: { requestId, runnerId: "runner", admitted: true, reason: "", nemoVersion: "test", modelRevisionId: "revision-9" } }, connection);
    expect(await checking).toEqual([expect.objectContaining({ unavailable: false, admitted: true, modelRevisionId: "revision-9" })]);
    await server.stop();
  });

  it("keeps a long test assigned across retry ticks, serializes dispatch and retries after disconnect", async () => {
    const event = { id: "job-1", createdAt: new Date(), payload: { runId: "run-1", testCases: [], plan: { guardrail_version: "20261012-030000.000Z", safety_level: "strict", output_delivery: "full_buffered" } } };
    const service = { ...serviceMock(), pendingOutbox: vi.fn(async (kind: string) => kind === "guardrail.validation_requested" ? [event] : []),
      markValidationRunning: vi.fn(), deferOutbox: vi.fn(), rejectValidation: vi.fn() };
    const server = new RunnerControlServer(config, service as unknown as ControlPlaneService,
      metricsMock() as unknown as ControllerMetrics, { activeConfiguration: vi.fn().mockResolvedValue(null) } as unknown as ModelConfigurationService);
    const dispatch = () => (server as unknown as { dispatchValidationRequests(): Promise<void> }).dispatchValidationRequests();
    const stream = streamMock();
    const hello = registration("compiler-0");
    hello.registration.compilerCapable = true;
    await handle(server, stream, hello, null);
    stream.write.mockClear();
    await Promise.all([dispatch(), dispatch(), dispatch()]);
    // The outbox still returns this event (as it would after the 30s deferral).
    await dispatch();
    expect(stream.write).toHaveBeenCalledOnce();
    expect(service.markValidationRunning).toHaveBeenCalledOnce();
    server.removeRunnerConnection("compiler-0", "boot-compiler-0");
    const replacement = streamMock();
    const connection = await handle(server, replacement, hello, null);
    replacement.write.mockClear();
    await dispatch();
    expect(replacement.write).toHaveBeenCalledOnce();
    await handle(server, replacement, { validationResult: { runnerId: "compiler-0", runId: "run-1", accepted: false, reason: "test failed" } }, connection);
    event.id = "job-2";
    event.payload.runId = "run-2";
    await dispatch();
    expect(replacement.write.mock.calls.filter(([message]) => message.validationRequest)).toHaveLength(2);
    expect(replacement.write).toHaveBeenCalledWith(expect.objectContaining({ validationReportAck: { runId: "run-1" } }));
  });

  it("keeps subsequent tests queued instead of moving them to ordinal 1", async () => {
    const events = ["run-1", "run-2"].map((runId, index) => ({
      id: runId, createdAt: new Date(index), payload: { runId, testCases: [],
        plan: { guardrail_version: "20261012-030000.000Z", safety_level: "strict", output_delivery: "full_buffered" } },
    }));
    const service = { ...serviceMock(),
      pendingOutbox: vi.fn(async (kind: string, limit: number, excludedRunIds: string[] = []) =>
        kind === "guardrail.validation_requested"
          ? events.filter(event => !excludedRunIds.includes(event.payload.runId)).slice(0, limit) : []),
      markValidationRunning: vi.fn(), deferOutbox: vi.fn(),
    };
    const server = new RunnerControlServer(config, service as unknown as ControlPlaneService,
      metricsMock() as unknown as ControllerMetrics, { activeConfiguration: vi.fn().mockResolvedValue(null) } as unknown as ModelConfigurationService);
    const dispatch = () => (server as unknown as { dispatchValidationRequests(): Promise<void> }).dispatchValidationRequests();
    const streams = [streamMock(), streamMock()];
    for (const [index, stream] of streams.entries()) {
      const hello = registration(`compiler-${index}`);
      hello.registration.compilerCapable = true;
      await handle(server, stream, hello, null);
      stream.write.mockClear();
    }
    await dispatch();
    // Model a long-running first job becoming available again after its retry delay.
    await dispatch();
    expect(streams[0]!.write).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      validationRequest: expect.objectContaining({ runId: "run-1" }),
    }));
    expect(streams[1]!.write).not.toHaveBeenCalled();
    expect(service.markValidationRunning).toHaveBeenCalledOnce();
  });

  it("accepts validation progress only from the registered compiler identity", async () => {
    const updateValidationProgress = vi.fn();
    const service = { ...serviceMock(), updateValidationProgress };
    const server = new RunnerControlServer(config, service as unknown as ControlPlaneService,
      metricsMock() as unknown as ControllerMetrics, { activeConfiguration: vi.fn().mockResolvedValue(null) } as unknown as ModelConfigurationService);
    const stream = streamMock();
    const hello = registration("compiler-0");
    hello.registration.compilerCapable = true;
    const connection = await handle(server, stream, hello, null);
    const progress = { runnerId: "compiler-0", runId: "run-1", phase: "VALIDATION_EXECUTION_PHASE_EXECUTING", completedCases: 3, passedCases: 2 };
    await handle(server, stream, { validationProgress: progress }, connection);
    expect(updateValidationProgress).toHaveBeenCalledWith("run-1", { phase: "executing", completedCases: 3, passedCases: 2 });
    await expect(handle(server, stream, { validationProgress: { ...progress, runnerId: "other" } }, connection)).rejects.toThrow("identity");
    expect(updateValidationProgress).toHaveBeenCalledOnce();
  });
  it("force removal releases the stream, ignores late messages and preserves a reconnected boot", async () => {
    const service = serviceMock();
    const models = { activeConfiguration: vi.fn().mockResolvedValue(null), finalizeActivation: vi.fn() };
    const metrics = metricsMock();
    const server = new RunnerControlServer(config, service as unknown as ControlPlaneService,
      metrics as unknown as ControllerMetrics, models as unknown as ModelConfigurationService);
    const connect = (stream: ReturnType<typeof streamMock>) => (server as unknown as { connect: (stream: unknown) => void }).connect(stream);
    const stream = streamMock();
    connect(stream);
    const hello = registration("compiler-0");
    hello.registration.compilerCapable = true;
    stream.emit("data", hello);
    await vi.waitFor(() => expect(stream.write).toHaveBeenCalledTimes(2));
    expect(server.hasDefaultCompiler()).toBe(true);

    server.removeRunnerConnection("compiler-0", "different-boot");
    expect(stream.end).not.toHaveBeenCalled();
    server.removeRunnerConnection("compiler-0", "boot-compiler-0");
    expect(stream.end).toHaveBeenCalledOnce();
    expect(server.hasDefaultCompiler()).toBe(false);

    const replacement = streamMock();
    connect(replacement);
    replacement.emit("data", hello);
    await vi.waitFor(() => expect(replacement.write).toHaveBeenCalledTimes(2));
    stream.emit("close");
    stream.emit("end");
    stream.emit("data", desiredResult("compiler-0", true));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(service.disconnectRunner).not.toHaveBeenCalled();
    expect(models.finalizeActivation).not.toHaveBeenCalled();
    expect(server.hasDefaultCompiler()).toBe(true);
    expect(replacement.end).not.toHaveBeenCalled();
    replacement.emit("close");
    replacement.emit("end");
    expect(service.disconnectRunner).toHaveBeenCalledOnce();
  });
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
    expect(await pending).toMatchObject({ passed: complete, cases: result.capabilityValidationResult.cases });
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
  return Object.assign(new EventEmitter(), {
    write: vi.fn(), end: vi.fn(),
    metadata: { get: () => [`Bearer ${config.runnerToken}`] },
  });
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

it("sends protection modes before a failing model rollout and rejects foreign acknowledgements", async () => {
  const service = { ...serviceMock(), protectionModes: {
    desiredState: vi.fn().mockResolvedValue({ generation: 9, modes: { g: "bypass" } }), recordResult: vi.fn(),
  } };
  const models = { activeConfiguration: vi.fn().mockResolvedValue(null) };
  const server = new RunnerControlServer(config, service as unknown as ControlPlaneService, metricsMock() as unknown as ControllerMetrics, models as unknown as ModelConfigurationService);
  const stream = streamMock();
  const hello = registration("runner-mode");
  hello.registration.labels = { "tasklattice.protection-modes": "1" };
  const connection = await handle(server, stream, hello, null);
  stream.write.mockClear();
  service.protectionModes.desiredState.mockResolvedValue({ generation: 10, modes: { g: "bypass" } });
  models.activeConfiguration.mockRejectedValue(new Error("models unavailable"));
  await server.distributeProtectionModes();
  expect(stream.write.mock.calls.map(([m]) => m.protectionState).filter(Boolean)).toEqual([{ generation: "10", modes: { g: "bypass" } }]);
  await handle(server, stream, { protectionResult: { runnerId: "runner-mode", generation: "9", accepted: true, reason: "" } }, connection);
  expect(service.protectionModes.recordResult).toHaveBeenCalledWith({ runnerId: "runner-mode", bootId: "boot-runner-mode", generation: 9, accepted: true, reason: "" });
  for (const result of [{ runnerId: "other", generation: "9" }, { runnerId: "runner-mode", generation: "11" }]) {
    await expect(handle(server, stream, { protectionResult: { ...result, accepted: true } }, connection)).rejects.toThrow("does not match");
  }
});

it("compiles independently of tests, correlates the Runner boot, and recovers from disconnect", async () => {
  const service = { ...serviceMock(), setArtifactCompiler: vi.fn() };
  const server = new RunnerControlServer(config, service as unknown as ControlPlaneService,
    metricsMock() as unknown as ControllerMetrics, { activeConfiguration: vi.fn().mockResolvedValue(null) } as unknown as ModelConfigurationService);
  expect(service.setArtifactCompiler).toHaveBeenCalledOnce();
  const request = { guardrailId: "guard", guardrailVersion: "20261026-010000.000Z", runtimeProfile: "auto", plan: { guardrail_id: "guard", guardrail_version: "20261026-010000.000Z", safety_level: "strict", output_delivery: "full_buffered" } };
  await expect(server.compileArtifact(request)).rejects.toMatchObject({ code: "guardrail_compiler_unavailable" });
  const stream = streamMock(), hello = registration("offline");
  hello.registration.compilerCapable = true;
  const oldConnection = await handle(server, stream, hello, null);
  await expect(server.compileArtifact(request)).rejects.toMatchObject({ code: "guardrail_compiler_unavailable" });
  server.removeRunnerConnection("offline", "boot-offline");
  hello.registration.bootId = "upgraded";
  hello.registration.labels = { "tasklattice.offline-compilation": "1" };
  const connection = await handle(server, stream, hello, null);
  const pending = server.compileArtifact(request);
  const command = stream.write.mock.calls.at(-1)![0].artifactCompilationRequest;
  expect(command).toMatchObject({ guardrailId: "guard", guardrailVersion: "20261026-010000.000Z" });
  const failure = { artifactCompilationResult: { compileId: command.compileId, runnerId: "offline", error: "Invalid plan" } };
  await handle(server, stream, failure, oldConnection);
  await handle(server, stream, { artifactCompilationResult: { ...failure.artifactCompilationResult, runnerId: "foreign" } }, connection);
  const rejected = expect(pending).rejects.toMatchObject({ code: "guardrail_compilation_failed", message: "Invalid plan" });
  await handle(server, stream, failure, connection);
  await rejected;
  const interrupted = expect(server.compileArtifact(request)).rejects.toMatchObject({ code: "guardrail_compilation_failed" });
  server.removeRunnerConnection("offline", "upgraded");
  await interrupted;
  expect((server as any).compilations.size).toBe(0);
});

it("rejects old artifacts before load checks and desired-state dispatch without capability negotiation", async () => {
  const artifact = { id: "old-artifact", generation: 10, checksum: "digest", signature: "signature", guardrailId: "guard", guardrailVersion: "20261026-010000.000Z",
    compilerVersion: "tasklattice-nemo-config-v27-staged-checks", nemoVersion: "test", runtimeProfile: "auto",
    plan: { compiler_version: "tasklattice-controller-plan-v15" }, configYaml: "", colangContent: "", prompts: [], actionBindings: [], dependencyManifest: [] };
  const service = { ...serviceMock(), desiredStateForPool: vi.fn().mockResolvedValue({ generation: 10, artifacts: [artifact],
    disabledGuardrailIds: [], disabledEndpointIds: [], endpoints: [], guardrailLoggingLevels: {} }),
    trafficRouting: { reportRolloutFailure: vi.fn() } };
  const server = new RunnerControlServer(config, service as unknown as ControlPlaneService, metricsMock() as unknown as ControllerMetrics,
    { activeConfiguration: vi.fn().mockResolvedValue(null) } as unknown as ModelConfigurationService);
  const stream = streamMock();
  await handle(server, stream, registration("runner"), null);
  expect(stream.write.mock.calls.some(([message]) => message.desiredState)).toBe(false);
  expect(service.trafficRouting.reportRolloutFailure).toHaveBeenCalledWith(10, "runner", expect.stringContaining("artifact_recompile_required"));
  stream.write.mockClear();
  expect(await server.checkArtifactAdmission(artifact)).toEqual([expect.objectContaining({ admitted: false, unavailable: false,
    reason: expect.stringContaining("Recompile and publish a new Guardrail version") })]);
  expect(stream.write).not.toHaveBeenCalled();
  await server.stop();
});

it("dispatches compilation, tests, load checks and rollout without view capability negotiation", async () => {
  const plan = { guardrail_version: "20261026-010000.000Z", compiler_version: "tasklattice-controller-plan-v16-explicit-views",
    safety_level: "strict", output_delivery: "full_buffered" };
  const artifact = { id: "new-artifact", generation: 10, checksum: "digest", signature: "signature", guardrailId: "guard", guardrailVersion: plan.guardrail_version,
    compilerVersion: NEMO_COMPILER_VERSION, nemoVersion: "test", runtimeProfile: "auto", plan, configYaml: "", colangContent: "", prompts: [], actionBindings: [], dependencyManifest: [] };
  const event = { id: "new-test", createdAt: new Date(), payload: { runId: "new-run", testCases: [], plan } };
  const desired = { generation: 10, artifacts: [artifact], disabledGuardrailIds: [], disabledEndpointIds: [], routers: [], endpoints: [], guardrailLoggingLevels: {} };
  const service = { ...serviceMock(), desiredStateForPool: vi.fn().mockResolvedValue(desired),
    trafficRouting: { reportRolloutFailure: vi.fn() },
    pendingOutbox: vi.fn(async (kind: string) => kind === "guardrail.validation_requested" ? [event] : []),
    markValidationRunning: vi.fn(), deferOutbox: vi.fn() };
  const server = new RunnerControlServer(config, service as unknown as ControlPlaneService,
    metricsMock() as unknown as ControllerMetrics, { activeConfiguration: vi.fn().mockResolvedValue(null) } as unknown as ModelConfigurationService);
  const stream = streamMock();
  const hello = registration("runner-0"); hello.registration.compilerCapable = true;
  hello.registration.labels = { "tasklattice.offline-compilation": "1" };
  const connection = await handle(server, stream, hello, null);
  expect(stream.write.mock.calls.some(([message]) => message.desiredState?.artifacts[0]?.artifactId === "new-artifact")).toBe(true);
  stream.write.mockClear();
  const dispatch = () => (server as unknown as { dispatchValidationRequests(): Promise<void> }).dispatchValidationRequests();
  await dispatch();
  expect(stream.write.mock.calls.some(([message]) => message.validationRequest?.runId === "new-run")).toBe(true);
  const pending = server.compileArtifact({ guardrailId: "guard", guardrailVersion: plan.guardrail_version, runtimeProfile: "auto", plan });
  const compile = stream.write.mock.calls.at(-1)![0].artifactCompilationRequest;
  const failed = expect(pending).rejects.toMatchObject({ code: "guardrail_compilation_failed" });
  await handle(server, stream, { artifactCompilationResult: { compileId: compile.compileId, runnerId: "runner-0", error: "Synthetic compile rejection" } }, connection);
  await failed;
  const checking = server.checkArtifactAdmission(artifact);
  await vi.waitFor(() => expect(stream.write.mock.calls.at(-1)![0].artifactAdmissionRequest).toBeDefined());
  const load = stream.write.mock.calls.at(-1)![0].artifactAdmissionRequest;
  await handle(server, stream, { artifactAdmissionResult: { requestId: load.requestId, runnerId: "runner-0", admitted: true, reason: "", nemoVersion: "test", modelRevisionId: "" } }, connection);
  expect(await checking).toEqual([expect.objectContaining({ admitted: true, runnerId: "runner-0" })]);
  await server.stop();
});
