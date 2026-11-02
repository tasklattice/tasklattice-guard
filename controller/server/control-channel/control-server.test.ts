import { resolve } from "node:path";
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import type { ControllerMetrics } from "../metrics.js";
import type { ModelConfigurationService } from "../model-config/service.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import type { RunnerLeaseLedger } from "../services/runner-lease-ledger.js";
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
  it("uses the selected pool's group Models and keeps its ACK/NACK out of global activation", async () => {
    const service = serviceMock();
    const scoped = activeConfiguration("tenant-group-model:grant-a", 1);
    const models = { configurationForPool: vi.fn().mockResolvedValue(scoped), activeConfiguration: vi.fn(),
      finalizeActivation: vi.fn(), failActivation: vi.fn() };
    const server = new RunnerControlServer(config, service as unknown as ControlPlaneService,
      metricsMock() as unknown as ControllerMetrics, models as unknown as ModelConfigurationService);
    const stream = streamMock(), hello = registration("scoped-models");
    hello.registration.labels = { "tasklattice.snapshot-ack": "1" };
    const connection = await handle(server, stream, hello, null);
    const sent = () => stream.write.mock.calls.map(([message]) => message.desiredState).filter(Boolean).at(-1);
    expect(sent().modelConfiguration.revisionId).toBe(scoped.revisionId);
    expect(models.activeConfiguration).not.toHaveBeenCalled();
    await handle(server, stream, { desiredStateResult: { ...desiredResult("scoped-models", true).desiredStateResult,
      modelRevisionId: scoped.revisionId, snapshotNonce: sent().snapshotNonce } }, connection);
    expect(models.finalizeActivation).not.toHaveBeenCalled();
    // Dispatch another exact challenge before testing a negative acknowledgement.
    (connection as { lastReconcileGeneration: number }).lastReconcileGeneration = -1;
    await (server as unknown as { reconcile(connection: unknown): Promise<void> }).reconcile(connection);
    await handle(server, stream, { desiredStateResult: { ...desiredResult("scoped-models", false, "group prewarm failed").desiredStateResult,
      modelRevisionId: scoped.revisionId, snapshotNonce: sent().snapshotNonce } }, connection);
    expect(models.failActivation).not.toHaveBeenCalled();
  });

  it("refuses group Models on a Runner without challenged snapshot acknowledgement", async () => {
    const models = { configurationForPool: vi.fn().mockResolvedValue(activeConfiguration("tenant-group-model:grant-a", 1)), activeConfiguration: vi.fn() };
    const server = new RunnerControlServer(config, serviceMock() as unknown as ControlPlaneService,
      metricsMock() as unknown as ControllerMetrics, models as unknown as ModelConfigurationService);
    const stream = streamMock();
    await expect(handle(server, stream, registration("old-scoped-models"), null)).rejects.toThrow("challenged snapshot");
    expect(stream.write.mock.calls.some(([message]) => message.desiredState)).toBe(false);
    expect(models.activeConfiguration).not.toHaveBeenCalled();
  });

  it("resolves models inside the desired-state transaction and treats an explicit null as authoritative", async () => {
    const service = serviceMock(), transaction = { identity: "same-allocation-snapshot" };
    const base = await service.desiredStateForPool();
    service.desiredStateForPool.mockImplementation(async (_pool?: unknown, resolver?: unknown) => ({ ...base,
      runtimeModelConfiguration: await (resolver as (tx: unknown) => Promise<null>)(transaction) }));
    const models = { configurationForPool: vi.fn().mockResolvedValue(null), activeConfiguration: vi.fn().mockResolvedValue(activeConfiguration("forbidden-global", 9)) };
    const server = new RunnerControlServer(config, service as unknown as ControlPlaneService,
      metricsMock() as unknown as ControllerMetrics, models as unknown as ModelConfigurationService);
    const stream = streamMock();
    await handle(server, stream, registration("empty-scoped-models"), null);
    expect(models.configurationForPool).toHaveBeenCalledWith("default", true, transaction);
    expect(models.activeConfiguration).not.toHaveBeenCalled();
    expect(stream.write.mock.calls.map(([message]) => message.desiredState).find(Boolean).modelConfiguration).toBeNull();
  });

  it("sends only the allocation epoch durably recorded with the challenged snapshot", async () => {
    const service = serviceMock();
    service.runnerControlSessions.dispatchedAllocation.mockResolvedValue({ epoch: 7, groupId: "group-a" });
    service.desiredStateForPool.mockResolvedValue({ ...await service.desiredStateForPool(), groupId: "group-a", allocationEpoch: 7 });
    const server = new RunnerControlServer(config, service as unknown as ControlPlaneService,
      metricsMock() as unknown as ControllerMetrics, { activeConfiguration: vi.fn().mockResolvedValue(null) } as unknown as ModelConfigurationService);
    const stream = streamMock();
    const hello = registration("epoch-bound");
    hello.registration.labels = { "tasklattice.snapshot-ack": "1" };
    await handle(server, stream, hello, null);
    const sent = stream.write.mock.calls.map(([message]) => message.desiredState).find(Boolean);
    expect(sent.allocationEpoch).toBe("7");
    expect(sent.allocationGroupId).toBe("group-a");
    expect(service.runnerControlSessions.dispatchedAllocation).toHaveBeenCalledWith(expect.objectContaining({ nonce: sent.snapshotNonce }));

    const unavailable = streamMock();
    service.runnerControlSessions.dispatchedAllocation.mockResolvedValue(null);
    const other = registration("epoch-unavailable");
    other.registration.labels = { "tasklattice.snapshot-ack": "1" };
    await handle(server, unavailable, other, null);
    expect(unavailable.write.mock.calls.some(([message]) => message.desiredState)).toBe(false);
  });

  it("does not send private admission or validation work to a durably replaced stream", async () => {
    const event = { id: "job-private", createdAt: new Date(), aggregateId: "guard-private", kind: "guardrail.validation_requested",
      payload: { runId: "run-private", testCases: [], plan: { guardrail_version: "20261012-030000.000Z", safety_level: "strict", output_delivery: "full_buffered" } } };
    const service = { ...serviceMock(), pendingOutbox: vi.fn(async (kind: string) => kind === event.kind ? [event] : []),
      markValidationRunning: vi.fn(), deferOutbox: vi.fn() };
    const server = new RunnerControlServer(config, service as unknown as ControlPlaneService,
      metricsMock() as unknown as ControllerMetrics, { activeConfiguration: vi.fn().mockResolvedValue(null) } as unknown as ModelConfigurationService);
    const stream = streamMock();
    const hello = registration("stale-compiler");
    hello.registration.compilerCapable = true;
    await handle(server, stream, hello, null);
    stream.write.mockClear();
    service.runnerControlSessions.isCurrent.mockResolvedValue(false);
    expect(await server.checkArtifactAdmission({ guardrailVersion: "20261012-030000.000Z",
      plan: { guardrail_version: "20261012-030000.000Z", safety_level: "strict", output_delivery: "full_buffered" } } as never)).toEqual([]);
    expect(await server.validateRail({ requestId: "private-rail", bindingId: "content_safety.input" })).toMatchObject({ passed: false });
    await (server as unknown as { dispatchValidationRequests(): Promise<void> }).dispatchValidationRequests();
    expect(stream.write).not.toHaveBeenCalled();
    expect(service.markValidationRunning).not.toHaveBeenCalled();
    expect(service.deferOutbox).not.toHaveBeenCalled();
  });

  it("skips a stale compiler and rechecks the selected session after async validation bookkeeping", async () => {
    const event = { id: "job-current", createdAt: new Date(), payload: { runId: "run-current", testCases: [],
      plan: { guardrail_version: "20261012-030000.000Z", safety_level: "strict", output_delivery: "full_buffered" } } };
    const service = { ...serviceMock(), pendingOutbox: vi.fn(async (kind: string) => kind === "guardrail.validation_requested" ? [event] : []),
      markValidationRunning: vi.fn(), deferOutbox: vi.fn() };
    const server = new RunnerControlServer(config, service as unknown as ControlPlaneService,
      metricsMock() as unknown as ControllerMetrics, { activeConfiguration: vi.fn().mockResolvedValue(null) } as unknown as ModelConfigurationService);
    const stale = streamMock(), current = streamMock();
    for (const [id, stream] of [["stale", stale], ["current", current]] as const) {
      const hello = registration(id);
      hello.registration.compilerCapable = true;
      await handle(server, stream, hello, null);
      stream.write.mockClear();
    }
    service.runnerControlSessions.isCurrent.mockImplementation(async identity => identity.runnerId === "current");
    service.deferOutbox.mockImplementation(async () => { service.runnerControlSessions.isCurrent.mockResolvedValue(false); });
    const dispatch = () => (server as unknown as { dispatchValidationRequests(): Promise<void> }).dispatchValidationRequests();
    await dispatch();
    expect(stale.write).not.toHaveBeenCalled();
    expect(current.write).not.toHaveBeenCalled();
    // A missed dispatch is retryable; it must not leave this run marked busy.
    service.deferOutbox.mockResolvedValue(undefined);
    service.runnerControlSessions.isCurrent.mockImplementation(async identity => identity.runnerId === "current");
    await dispatch();
    expect(stale.write).not.toHaveBeenCalled();
    expect(current.write).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      validationRequest: expect.objectContaining({ runId: "run-current" }),
    }));
  });

  it("ignores ACK and grant traffic after durable session ownership was replaced on another Controller", async () => {
    const service = serviceMock();
    const models = { activeConfiguration: vi.fn().mockResolvedValue(activeConfiguration("revision-9", 9)), finalizeActivation: vi.fn() };
    const ledger = { issueSnapshotBound: vi.fn() };
    const server = new RunnerControlServer({ ...config, experimentalRunnerLeaseGrants: true }, service as unknown as ControlPlaneService,
      metricsMock() as unknown as ControllerMetrics, models as unknown as ModelConfigurationService, ledger as unknown as RunnerLeaseLedger);
    const stream = streamMock();
    const hello = registration("replaced-durable");
    hello.registration.labels = { "tasklattice.snapshot-ack": "1", "tasklattice.lease-probe": "1" };
    const connection = await handle(server, stream, hello, null, "default");
    const sent = stream.write.mock.calls.map(([message]) => message.desiredState).find(Boolean);
    service.runnerControlSessions.isCurrent.mockResolvedValue(false);
    stream.write.mockClear();
    await handle(server, stream, { desiredStateResult: { ...desiredResult("replaced-durable", true).desiredStateResult, snapshotNonce: sent.snapshotNonce } }, connection);
    await handle(server, stream, { servingLeaseRequest: { runnerId: "replaced-durable", bootId: "boot-replaced-durable", nonce: "lease", epoch: "0", generation: "9", snapshotNonce: sent.snapshotNonce } }, connection);
    await (server as unknown as { reconcile(connection: unknown): Promise<void> }).reconcile(connection);
    expect(service.runnerControlSessions.acknowledged).not.toHaveBeenCalled();
    expect(ledger.issueSnapshotBound).not.toHaveBeenCalled();
    expect(stream.write).not.toHaveBeenCalled();
    expect(models.finalizeActivation).not.toHaveBeenCalled();
  });

  it("closes a registered durable session when the stream ended during registration", async () => {
    let finish!: (generation: number) => void;
    const service = serviceMock();
    service.registerRunner.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const server = new RunnerControlServer(config, service as unknown as ControlPlaneService, metricsMock() as unknown as ControllerMetrics,
      { activeConfiguration: vi.fn().mockResolvedValue(null) } as unknown as ModelConfigurationService);
    const stream = streamMock();
    stream.on("error", () => {});
    (server as unknown as { connect(stream: unknown): void }).connect(stream);
    stream.emit("data", registration("short-lived"));
    await vi.waitFor(() => expect(service.registerRunner).toHaveBeenCalledOnce());
    stream.emit("end");
    finish(9);
    await vi.waitFor(() => expect(service.disconnectRunner).toHaveBeenCalledWith("short-lived", "boot-short-lived", expect.any(String)));
    expect((server as unknown as { connections: Map<string, unknown> }).connections.size).toBe(0);
  });

  it.each(["send", "snapshot"])("cleans up committed registration when initial %s fails", async failure => {
    const service = serviceMock();
    const server = new RunnerControlServer(config, service as unknown as ControlPlaneService,
      metricsMock() as unknown as ControllerMetrics, { activeConfiguration: vi.fn().mockResolvedValue(null) } as unknown as ModelConfigurationService);
    const stream = streamMock();
    if (failure === "send") stream.write.mockImplementationOnce(() => { throw new Error("initial send failed"); });
    else service.desiredStateForPool.mockRejectedValueOnce(new Error("initial snapshot failed"));
    await expect(handle(server, stream, registration("failed-registration"), null)).rejects.toThrow(/initial/);
    expect(service.disconnectRunner).toHaveBeenCalledWith("failed-registration", "boot-failed-registration", expect.any(String));
    expect((server as unknown as { connections: Map<string, unknown> }).connections.size).toBe(0);
  });

  it("fails startup if experimental grants lack a durable ledger", () => {
    expect(() => new RunnerControlServer({ ...config, experimentalRunnerLeaseGrants: true }, serviceMock() as unknown as ControlPlaneService,
      metricsMock() as unknown as ControllerMetrics, { activeConfiguration: vi.fn() } as unknown as ModelConfigurationService))
      .toThrow(/durable grant ledger/);
  });
  it("grants only pool-authenticated, negotiated and exactly acknowledged snapshots", async () => {
    const experimental = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://localhost/test",
      CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/key",
      CONTROLLER_PROTO_PATH: config.protoPath, BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
      CONTROLLER_RUNNER_POOL_TOKENS_JSON: JSON.stringify({ default: "pool-secret-with-at-least-32-characters" }),
      CONTROLLER_EXPERIMENTAL_RUNNER_LEASE_GRANTS: "true" });
    const ledger = { issueSnapshotBound: vi.fn().mockResolvedValue({}) };
    const models = { activeConfiguration: vi.fn().mockResolvedValue(activeConfiguration("revision-9", 9)), finalizeActivation: vi.fn() };
    const server = new RunnerControlServer(experimental, serviceMock() as unknown as ControlPlaneService,
      metricsMock() as unknown as ControllerMetrics, models as unknown as ModelConfigurationService, ledger as unknown as RunnerLeaseLedger);
    const stream = streamMock();
    const hello = registration("lease-runner");
    hello.registration.labels = { "tasklattice.snapshot-ack": "1", "tasklattice.lease-probe": "1" };
    const connection = await handle(server, stream, hello, null, "default");
    const sent = stream.write.mock.calls.map(([message]) => message.desiredState).find(Boolean);
    const lease = { runnerId: "lease-runner", bootId: "boot-lease-runner", nonce: "one", epoch: "0", generation: "9", snapshotNonce: sent.snapshotNonce };
    await handle(server, stream, { servingLeaseRequest: lease }, connection);
    expect(ledger.issueSnapshotBound).not.toHaveBeenCalled();
    await handle(server, stream, { desiredStateResult: { ...desiredResult("lease-runner", true).desiredStateResult, snapshotNonce: sent.snapshotNonce } }, connection);
    for (const bad of [{ ...lease, bootId: "wrong" }, { ...lease, generation: "10" }, { ...lease, snapshotNonce: "wrong" }]) {
      await handle(server, stream, { servingLeaseRequest: bad }, connection);
    }
    expect(ledger.issueSnapshotBound).not.toHaveBeenCalled();
    await handle(server, stream, { servingLeaseRequest: lease }, connection);
    expect(ledger.issueSnapshotBound).toHaveBeenCalledWith(expect.objectContaining({ poolId: "default", runnerId: lease.runnerId,
      bootId: lease.bootId, snapshotNonce: sent.snapshotNonce, modelRevisionId: "revision-9" }));
    expect(stream.write.mock.calls.map(([message]) => message.servingLeaseResponse).filter(Boolean).at(-1)).toMatchObject({ granted: true, nonce: "one" });
  });

  it("does not reply with a persisted grant if its snapshot or connection changes while issuing", async () => {
    const experimental = { ...config, experimentalRunnerLeaseGrants: true };
    let finish!: () => void;
    const ledger = { issueSnapshotBound: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })) };
    const service = serviceMock();
    const models = { activeConfiguration: vi.fn().mockResolvedValue(activeConfiguration("revision-9", 9)), finalizeActivation: vi.fn() };
    const server = new RunnerControlServer(experimental, service as unknown as ControlPlaneService,
      metricsMock() as unknown as ControllerMetrics, models as unknown as ModelConfigurationService, ledger as unknown as RunnerLeaseLedger);
    const stream = streamMock();
    const hello = registration("lease-runner");
    hello.registration.labels = { "tasklattice.snapshot-ack": "1", "tasklattice.lease-probe": "1" };
    const connection = await handle(server, stream, hello, null, "default");
    const sent = stream.write.mock.calls.map(([message]) => message.desiredState).find(Boolean);
    await handle(server, stream, { desiredStateResult: { ...desiredResult("lease-runner", true).desiredStateResult, snapshotNonce: sent.snapshotNonce } }, connection);
    const pending = handle(server, stream, { servingLeaseRequest: { runnerId: "lease-runner", bootId: "boot-lease-runner", nonce: "one",
      epoch: "0", generation: "9", snapshotNonce: sent.snapshotNonce } }, connection);
    await vi.waitFor(() => expect(ledger.issueSnapshotBound).toHaveBeenCalledOnce());
    service.desiredStateForPool.mockResolvedValue({ generation: 10, groupId: "default", allocationEpoch: 0, artifacts: [], disabledGuardrailIds: [],
      disabledEndpointIds: [], endpoints: [], routers: [], guardrailLoggingLevels: {} } as never);
    await (server as unknown as { reconcile(connection: unknown): Promise<void> }).reconcile(connection);
    finish();
    await pending;
    expect(stream.write.mock.calls.map(([message]) => message.servingLeaseResponse).filter(Boolean)).toEqual([]);
  });

  it("rejects grants when the flag, pool authentication, or capability is absent", async () => {
    for (const [enabled, poolAuthenticated, capable] of [[false, true, true], [true, false, true], [true, true, false]] as const) {
      const ledger = { issueSnapshotBound: vi.fn() };
      const models = { activeConfiguration: vi.fn().mockResolvedValue(activeConfiguration("revision-9", 9)), finalizeActivation: vi.fn() };
      const server = new RunnerControlServer({ ...config, experimentalRunnerLeaseGrants: enabled }, serviceMock() as unknown as ControlPlaneService,
        metricsMock() as unknown as ControllerMetrics, models as unknown as ModelConfigurationService, ledger as unknown as RunnerLeaseLedger);
      const stream = streamMock();
      const hello = registration("lease-runner");
      hello.registration.labels = { "tasklattice.snapshot-ack": "1", ...(capable ? { "tasklattice.lease-probe": "1" } : {}) };
      const connection = await handle(server, stream, hello, null, poolAuthenticated ? "default" : undefined);
      const sent = stream.write.mock.calls.map(([message]) => message.desiredState).find(Boolean);
      await handle(server, stream, { desiredStateResult: { ...desiredResult("lease-runner", true).desiredStateResult, snapshotNonce: sent.snapshotNonce } }, connection);
      await handle(server, stream, { servingLeaseRequest: { runnerId: "lease-runner", bootId: "boot-lease-runner", nonce: "one",
        epoch: "0", generation: "9", snapshotNonce: sent.snapshotNonce } }, connection);
      expect(ledger.issueSnapshotBound).not.toHaveBeenCalled();
      expect(stream.write.mock.calls.map(([message]) => message.servingLeaseResponse).filter(Boolean).at(-1)).toMatchObject({ granted: false });
    }
  });

  it("does not reply on a replaced stream after a durable grant completes", async () => {
    let finish!: () => void;
    const ledger = { issueSnapshotBound: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })) };
    const models = { activeConfiguration: vi.fn().mockResolvedValue(activeConfiguration("revision-9", 9)), finalizeActivation: vi.fn() };
    const server = new RunnerControlServer({ ...config, experimentalRunnerLeaseGrants: true }, serviceMock() as unknown as ControlPlaneService,
      metricsMock() as unknown as ControllerMetrics, models as unknown as ModelConfigurationService, ledger as unknown as RunnerLeaseLedger);
    const oldStream = streamMock(), replacement = streamMock(), hello = registration("lease-runner");
    hello.registration.labels = { "tasklattice.snapshot-ack": "1", "tasklattice.lease-probe": "1" };
    const old = await handle(server, oldStream, hello, null, "default");
    const sent = oldStream.write.mock.calls.map(([message]) => message.desiredState).find(Boolean);
    await handle(server, oldStream, { desiredStateResult: { ...desiredResult("lease-runner", true).desiredStateResult, snapshotNonce: sent.snapshotNonce } }, old);
    const pending = handle(server, oldStream, { servingLeaseRequest: { runnerId: "lease-runner", bootId: "boot-lease-runner", nonce: "one",
      epoch: "0", generation: "9", snapshotNonce: sent.snapshotNonce } }, old);
    await handle(server, replacement, hello, null, "default");
    finish();
    await pending;
    expect(oldStream.write.mock.calls.map(([message]) => message.servingLeaseResponse).filter(Boolean)).toEqual([]);
  });
  it("accepts only the exact challenged snapshot ACK on the current capable stream", async () => {
    const service = serviceMock();
    const models = { activeConfiguration: vi.fn().mockResolvedValue(activeConfiguration("revision-9", 9)),
      finalizeActivation: vi.fn(), failActivation: vi.fn() };
    const server = new RunnerControlServer(config, service as unknown as ControlPlaneService,
      metricsMock() as unknown as ControllerMetrics, models as unknown as ModelConfigurationService);
    const stream = streamMock();
    const hello = registration("capable");
    hello.registration.labels = { "tasklattice.snapshot-ack": "1" };
    const connection = await handle(server, stream, hello, null) as { verifiedSnapshot: unknown; appliedGeneration: number };
    const sent = stream.write.mock.calls.map(([message]) => message.desiredState).find(Boolean);
    expect(sent.snapshotNonce).toBeTruthy();
    const result = desiredResult("capable", true);
    for (const forged of [
      { ...result.desiredStateResult, snapshotNonce: "wrong" },
      { ...result.desiredStateResult, snapshotNonce: sent.snapshotNonce, generation: "10" },
      { ...result.desiredStateResult, snapshotNonce: sent.snapshotNonce, modelRevisionId: "other" },
      { ...result.desiredStateResult, snapshotNonce: "wrong", accepted: false },
      { ...result.desiredStateResult },
    ]) {
      await handle(server, stream, { desiredStateResult: forged }, connection);
      expect(connection.verifiedSnapshot).toBeNull();
      expect(models.finalizeActivation).not.toHaveBeenCalled();
      expect(models.failActivation).not.toHaveBeenCalled();
    }
    await handle(server, stream, { desiredStateResult: { ...result.desiredStateResult, snapshotNonce: sent.snapshotNonce } }, connection);
    expect(connection.verifiedSnapshot).toEqual({ nonce: sent.snapshotNonce, generation: 9, modelRevisionId: "revision-9" });
    expect(models.finalizeActivation).toHaveBeenCalledOnce();
    await handle(server, stream, { desiredStateResult: { ...result.desiredStateResult, snapshotNonce: sent.snapshotNonce } }, connection);
    expect(models.finalizeActivation).toHaveBeenCalledOnce();
  });

  it("does not mark a challenged NACK as an applied snapshot", async () => {
    const service = serviceMock();
    const models = { activeConfiguration: vi.fn().mockResolvedValue(activeConfiguration("revision-9", 9)),
      finalizeActivation: vi.fn(), failActivation: vi.fn() };
    const server = new RunnerControlServer(config, service as unknown as ControlPlaneService,
      metricsMock() as unknown as ControllerMetrics, models as unknown as ModelConfigurationService);
    const stream = streamMock();
    const hello = registration("capable-nack");
    hello.registration.labels = { "tasklattice.snapshot-ack": "1" };
    const connection = await handle(server, stream, hello, null) as { verifiedSnapshot: unknown };
    const sent = stream.write.mock.calls.map(([message]) => message.desiredState).find(Boolean);
    await handle(server, stream, { desiredStateResult: { ...desiredResult("capable-nack", false, "rejected").desiredStateResult,
      snapshotNonce: sent.snapshotNonce } }, connection);
    expect(connection.verifiedSnapshot).toBeNull();
    expect(models.failActivation).toHaveBeenCalledOnce();
    expect(models.finalizeActivation).not.toHaveBeenCalled();
  });

  it("ignores stale and replaced-stream snapshot acknowledgements", async () => {
    const service = serviceMock();
    const models = { activeConfiguration: vi.fn().mockResolvedValue(activeConfiguration("revision-9", 9)),
      finalizeActivation: vi.fn(), failActivation: vi.fn() };
    const server = new RunnerControlServer(config, service as unknown as ControlPlaneService,
      metricsMock() as unknown as ControllerMetrics, models as unknown as ModelConfigurationService);
    const stream = streamMock();
    const hello = registration("capable");
    hello.registration.labels = { "tasklattice.snapshot-ack": "1" };
    const old = await handle(server, stream, hello, null) as { verifiedSnapshot: unknown };
    const first = stream.write.mock.calls.map(([message]) => message.desiredState).find(Boolean);
    service.desiredStateForPool.mockResolvedValue({ generation: 10, groupId: "default", allocationEpoch: 0, artifacts: [], disabledGuardrailIds: [],
      disabledEndpointIds: [], endpoints: [], routers: [], guardrailLoggingLevels: {} } as never);
    await (server as unknown as { reconcile(connection: unknown): Promise<void> }).reconcile(old);
    const second = stream.write.mock.calls.map(([message]) => message.desiredState).filter(Boolean).at(-1);
    expect(second.snapshotNonce).not.toBe(first.snapshotNonce);
    await handle(server, stream, { desiredStateResult: { ...desiredResult("capable", true).desiredStateResult,
      snapshotNonce: first.snapshotNonce } }, old);
    expect(old.verifiedSnapshot).toBeNull();
    const replacement = streamMock();
    const fresh = await handle(server, replacement, hello, null) as { verifiedSnapshot: unknown };
    await handle(server, stream, { desiredStateResult: { ...desiredResult("capable", true).desiredStateResult,
      snapshotNonce: second.snapshotNonce, generation: "10" } }, old);
    expect(old.verifiedSnapshot).toBeNull();
    expect(fresh.verifiedSnapshot).toBeNull();
    expect(models.finalizeActivation).not.toHaveBeenCalled();
  });

  it("sends the Controller-assigned Endpoint owner with desired state", async () => {
    const service = serviceMock();
    service.desiredStateForPool.mockResolvedValue({ generation: 9, groupId: "default", allocationEpoch: 0, artifacts: [], disabledGuardrailIds: [],
      disabledEndpointIds: [], routers: [], guardrailLoggingLevels: {}, endpoints: [{ endpointId: "endpoint-a",
        tenantId: "tenantA", adapter: "litellm-generic-guardrail", trafficRouterId: null,
        verification: { credentials: [] }, scanFlagOnlyDefault: true }] } as never);
    const server = new RunnerControlServer(config, service as unknown as ControlPlaneService,
      metricsMock() as unknown as ControllerMetrics, { activeConfiguration: vi.fn().mockResolvedValue(null) } as unknown as ModelConfigurationService);
    const stream = streamMock();
    await handle(server, stream, registration("runner-owner"), null);
    const desired = stream.write.mock.calls.map(([message]) => message.desiredState).find(Boolean);
    expect(desired?.endpoints).toEqual([expect.objectContaining({ endpointId: "endpoint-a", tenantId: "tenantA" })]);
  });
  it("dispatches each tenant's validation only to a compiler in its allocated group", async () => {
    const jobs = ["a", "b"].map((group, index) => ({ id: `job-${group}`, kind: "guardrail.validation_requested", aggregateId: `guard-${group}`,
      createdAt: new Date(index), payload: { runId: `run-${group}`, testCases: [],
        plan: { guardrail_version: "20261012-030000.000Z", safety_level: "strict", output_delivery: "full_buffered" } } }));
    const groupRouting = { poolsForValidation: vi.fn(async (_kind: string, id: string) => [id === "guard-a" ? "pool-a" : "pool-b"]) };
    const service = { ...serviceMock(), groupRouting,
      pendingOutbox: vi.fn(async (kind: string, _limit: number, excluded: string[] = []) =>
        kind === "guardrail.validation_requested" ? jobs.filter(job => !excluded.includes(job.payload.runId)) : []),
      markValidationRunning: vi.fn(), deferOutbox: vi.fn() };
    const server = new RunnerControlServer(config, service as unknown as ControlPlaneService,
      metricsMock() as unknown as ControllerMetrics, { activeConfiguration: vi.fn().mockResolvedValue(null) } as unknown as ModelConfigurationService);
    const streams = [streamMock(), streamMock()];
    for (const [index, stream] of streams.entries()) {
      const hello = registration(`compiler-${index}`);
      hello.registration.poolId = index ? "pool-b" : "pool-a";
      hello.registration.compilerCapable = true;
      await handle(server, stream, hello, null);
      stream.write.mockClear();
    }
    const dispatch = () => (server as unknown as { dispatchValidationRequests(): Promise<void> }).dispatchValidationRequests();
    await dispatch(); await dispatch();
    expect(streams[0]!.write).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ validationRequest: expect.objectContaining({ runId: "run-a" }) }));
    expect(streams[1]!.write).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ validationRequest: expect.objectContaining({ runId: "run-b" }) }));
    expect(server.hasCompilerForPools(["pool-b"])).toBe(true);
    expect(server.hasCompilerForPools(["missing"])).toBe(false);
  });
  it("keeps a long test assigned across retry ticks, serializes dispatch and retries after disconnect", async () => {
    const event = { id: "job-1", createdAt: new Date(), payload: { runId: "run-1", testCases: [], plan: { guardrail_version: "20261012-030000.000Z", safety_level: "strict", output_delivery: "full_buffered" } } };
    const service = { ...serviceMock(), pendingOutbox: vi.fn(async (kind: string) => kind === "guardrail.validation_requested" ? [event] : []),
      markValidationRunning: vi.fn(), deferOutbox: vi.fn(), rejectValidation: vi.fn() };
    const server = new RunnerControlServer(config, service as unknown as ControlPlaneService,
      metricsMock() as unknown as ControllerMetrics, { activeConfiguration: vi.fn().mockResolvedValue(null) } as unknown as ModelConfigurationService);
    const dispatch = () => (server as unknown as { dispatchValidationRequests(): Promise<void> }).dispatchValidationRequests();
    const stream = streamMock();
    const hello = registration("compiler");
    hello.registration.compilerCapable = true;
    await handle(server, stream, hello, null);
    stream.write.mockClear();
    await Promise.all([dispatch(), dispatch(), dispatch()]);
    // The outbox still returns this event (as it would after the 30s deferral).
    await dispatch();
    expect(stream.write).toHaveBeenCalledOnce();
    expect(service.markValidationRunning).toHaveBeenCalledOnce();
    server.removeRunnerConnection("compiler", "boot-compiler");
    const replacement = streamMock();
    const connection = await handle(server, replacement, hello, null);
    replacement.write.mockClear();
    await dispatch();
    expect(replacement.write).toHaveBeenCalledOnce();
    await handle(server, replacement, { validationResult: { runnerId: "compiler", runId: "run-1", accepted: false, reason: "test failed" } }, connection);
    event.id = "job-2";
    event.payload.runId = "run-2";
    await dispatch();
    expect(replacement.write).toHaveBeenCalledTimes(2);
  });

  it("dispatches the next queued job to an idle compiler while an older job is still running", async () => {
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
    expect(streams[1]!.write).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      validationRequest: expect.objectContaining({ runId: "run-2" }),
    }));
  });

  it("accepts validation progress only from the registered compiler identity", async () => {
    const updateValidationProgress = vi.fn();
    const event = { id: "job-1", createdAt: new Date(), payload: { runId: "run-1", testCases: [],
      plan: { guardrail_version: "20261012-030000.000Z", safety_level: "strict", output_delivery: "full_buffered" } } };
    const service = { ...serviceMock(), updateValidationProgress,
      pendingOutbox: vi.fn(async (kind: string) => kind === "guardrail.validation_requested" ? [event] : []),
      markValidationRunning: vi.fn(), deferOutbox: vi.fn() };
    const server = new RunnerControlServer(config, service as unknown as ControlPlaneService,
      metricsMock() as unknown as ControllerMetrics, { activeConfiguration: vi.fn().mockResolvedValue(null) } as unknown as ModelConfigurationService);
    const stream = streamMock();
    const hello = registration("compiler");
    hello.registration.compilerCapable = true;
    const connection = await handle(server, stream, hello, null);
    await (server as unknown as { dispatchValidationRequests(): Promise<void> }).dispatchValidationRequests();
    const progress = { runnerId: "compiler", runId: "run-1", phase: "VALIDATION_EXECUTION_PHASE_EXECUTING", completedCases: 3, passedCases: 2 };
    await handle(server, stream, { validationProgress: progress }, connection);
    expect(updateValidationProgress).toHaveBeenCalledWith("run-1", { phase: "executing", completedCases: 3, passedCases: 2 });
    await expect(handle(server, stream, { validationProgress: { ...progress, runnerId: "other" } }, connection)).rejects.toThrow("identity");
    expect(updateValidationProgress).toHaveBeenCalledOnce();
  });

  it("ignores guessed or completed validation IDs and rejects results from another pool's compiler", async () => {
    const event = { id: "job-owned", kind: "guardrail.validation_requested", aggregateId: "guard-a", createdAt: new Date(),
      payload: { runId: "run-owned", testCases: [],
        plan: { guardrail_version: "20261012-030000.000Z", safety_level: "strict", output_delivery: "full_buffered" } } };
    const service = { ...serviceMock(), pendingOutbox: vi.fn(async (kind: string) => kind === event.kind ? [event] : []),
      groupRouting: { poolsForValidation: vi.fn().mockResolvedValue(["pool-a"]) },
      markValidationRunning: vi.fn(), deferOutbox: vi.fn(), updateValidationProgress: vi.fn(), rejectValidation: vi.fn() };
    const metrics = metricsMock();
    const server = new RunnerControlServer(config, service as unknown as ControlPlaneService,
      metrics as unknown as ControllerMetrics, { activeConfiguration: vi.fn().mockResolvedValue(null) } as unknown as ModelConfigurationService);
    const ownStream = streamMock(), foreignStream = streamMock();
    const ownHello = registration("compiler-a"), foreignHello = registration("compiler-b");
    ownHello.registration.poolId = "pool-a"; foreignHello.registration.poolId = "pool-b";
    ownHello.registration.compilerCapable = foreignHello.registration.compilerCapable = true;
    const owner = await handle(server, ownStream, ownHello, null);
    const foreign = await handle(server, foreignStream, foreignHello, null);
    const progress = (runId: string, runnerId = "compiler-a") => ({ validationProgress: {
      runnerId, runId, phase: "VALIDATION_EXECUTION_PHASE_EXECUTING", completedCases: 1, passedCases: 1,
    } });
    const result = (runId: string, runnerId = "compiler-a") => ({ validationResult: {
      runnerId, runId, accepted: false, reason: "failure",
    } });
    await handle(server, ownStream, progress("guessed-run"), owner);
    await handle(server, ownStream, result("guessed-run"), owner);
    expect(service.updateValidationProgress).not.toHaveBeenCalled();
    expect(service.rejectValidation).not.toHaveBeenCalled();
    expect(metrics.observeJob).not.toHaveBeenCalled();
    await (server as unknown as { dispatchValidationRequests(): Promise<void> }).dispatchValidationRequests();
    await expect(handle(server, foreignStream, progress("run-owned", "compiler-b"), foreign)).rejects.toThrow("another Runner stream");
    await expect(handle(server, foreignStream, result("run-owned", "compiler-b"), foreign)).rejects.toThrow("another Runner stream");
    expect(service.updateValidationProgress).not.toHaveBeenCalled();
    expect(service.rejectValidation).not.toHaveBeenCalled();
    await handle(server, ownStream, progress("run-owned"), owner);
    await handle(server, ownStream, result("run-owned"), owner);
    expect(service.updateValidationProgress).toHaveBeenCalledOnce();
    expect(service.rejectValidation).toHaveBeenCalledExactlyOnceWith({ runId: "run-owned", reason: "failure" });
    await handle(server, ownStream, result("run-owned"), owner);
    expect(service.rejectValidation).toHaveBeenCalledOnce();
    expect(metrics.observeJob).toHaveBeenCalledOnce();
  });

  it("ends admission work when its exact session is replaced, even for the same boot", async () => {
    const service = serviceMock();
    const server = new RunnerControlServer(config, service as unknown as ControlPlaneService,
      metricsMock() as unknown as ControllerMetrics, { activeConfiguration: vi.fn().mockResolvedValue(null) } as unknown as ModelConfigurationService);
    const stream = streamMock();
    const hello = registration("admission-runner");
    await handle(server, stream, hello, null);
    const pending = server.checkArtifactAdmission({ guardrailVersion: "20261012-030000.000Z",
      plan: { guardrail_version: "20261012-030000.000Z", safety_level: "strict", output_delivery: "full_buffered" } } as never);
    await vi.waitFor(() => expect(stream.write.mock.calls.some(([message]) => message.artifactAdmissionRequest)).toBe(true));
    const request = stream.write.mock.calls.map(([message]) => message.artifactAdmissionRequest).find(Boolean);
    const replacement = streamMock();
    const current = await handle(server, replacement, hello, null);
    await handle(server, replacement, { artifactAdmissionResult: {
      runnerId: "admission-runner", requestId: request.requestId, admitted: true,
    } }, current);
    expect(await pending).toEqual([expect.objectContaining({ admitted: false, unavailable: true,
      reason: "Runner disconnected during the load check." })]);
  });

  it("does not authorize a guessed result while request bookkeeping is still pending", async () => {
    let continueDispatch!: () => void;
    const bookkeeping = new Promise<void>(resolve => { continueDispatch = resolve; });
    const event = { id: "job-pending", createdAt: new Date(), payload: { runId: "run-pending", testCases: [],
      plan: { guardrail_version: "20261012-030000.000Z", safety_level: "strict", output_delivery: "full_buffered" } } };
    const service = { ...serviceMock(), pendingOutbox: vi.fn(async (kind: string) => kind === "guardrail.validation_requested" ? [event] : []),
      markValidationRunning: vi.fn(), deferOutbox: vi.fn(() => bookkeeping), rejectValidation: vi.fn() };
    const server = new RunnerControlServer(config, service as unknown as ControlPlaneService,
      metricsMock() as unknown as ControllerMetrics, { activeConfiguration: vi.fn().mockResolvedValue(null) } as unknown as ModelConfigurationService);
    const stream = streamMock(), hello = registration("compiler");
    hello.registration.compilerCapable = true;
    const connection = await handle(server, stream, hello, null);
    stream.write.mockClear();
    const dispatching = (server as unknown as { dispatchValidationRequests(): Promise<void> }).dispatchValidationRequests();
    await vi.waitFor(() => expect(service.deferOutbox).toHaveBeenCalledOnce());
    const result = { validationResult: { runnerId: "compiler", runId: "run-pending", accepted: false, reason: "guessed" } };
    await handle(server, stream, result, connection);
    expect(service.rejectValidation).not.toHaveBeenCalled();
    expect(stream.write).not.toHaveBeenCalled();
    continueDispatch();
    await dispatching;
    expect(stream.write).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      validationRequest: expect.objectContaining({ runId: "run-pending" }),
    }));
    await handle(server, stream, result, connection);
    expect(service.rejectValidation).toHaveBeenCalledExactlyOnceWith({ runId: "run-pending", reason: "guessed" });
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
    const hello = registration("compiler");
    hello.registration.compilerCapable = true;
    stream.emit("data", hello);
    await vi.waitFor(() => expect(stream.write).toHaveBeenCalledTimes(2));
    expect(server.hasDefaultCompiler()).toBe(true);

    server.removeRunnerConnection("compiler", "different-boot");
    expect(stream.end).not.toHaveBeenCalled();
    server.removeRunnerConnection("compiler", "boot-compiler");
    expect(stream.end).toHaveBeenCalledOnce();
    expect(server.hasDefaultCompiler()).toBe(false);

    const replacement = streamMock();
    connect(replacement);
    replacement.emit("data", hello);
    await vi.waitFor(() => expect(replacement.write).toHaveBeenCalledTimes(2));
    stream.emit("close");
    stream.emit("end");
    stream.emit("data", desiredResult("compiler", true));
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
    await vi.waitFor(() => expect(stream.write).toHaveBeenCalledWith(expect.objectContaining({
      capabilityValidationRequest: expect.objectContaining({ requestId: "rail-test" }),
    })));
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
    expect(models.finalizeActivation).toHaveBeenCalledWith("revision-9", "default");
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
      "default",
    );
    expect(models.finalizeActivation).not.toHaveBeenCalled();
    const desiredWrites = stream.write.mock.calls
      .map(([message]) => message.desiredState)
      .filter(Boolean);
    expect(desiredWrites.at(-1)?.modelConfiguration?.revisionId).toBe("revision-8");
  });
});

it("dispatches telemetry authorization only to the current pool-authenticated registration", async () => {
  const walId = "a5c05b54-85cd-4cb8-9ea1-b75a50b59b16";
  const issued = { walId, capability: "a".repeat(64), acknowledgedCursor: 7, producedCursor: 9,
    lastBatchId: "last-batch", lastBatchDigest: "b".repeat(64) };
  const issue = vi.fn().mockResolvedValue(issued);
  const service = { ...serviceMock(), telemetryProgress: { issue } };
  const enabled = { ...config, runnerScopedTelemetry: true, runnerTelemetryProgress: true };
  const server = new RunnerControlServer(enabled, service as unknown as ControlPlaneService,
    metricsMock() as unknown as ControllerMetrics, { activeConfiguration: vi.fn().mockResolvedValue(null) } as unknown as ModelConfigurationService);
  const hello = { registration: { ...registration("progress-runner").registration, telemetryWalId: walId } };
  const stream = streamMock();
  await handle(server, stream, hello, null, "default");
  const accepted = stream.write.mock.calls.map(([message]) => message.registrationAccepted).find(Boolean);
  expect(accepted.telemetryUploadAuthorization).toEqual({ ...issued, acknowledgedCursor: "7", producedCursor: "9" });
  expect(issue).toHaveBeenCalledWith(expect.objectContaining({ runnerId: "progress-runner", bootId: "boot-progress-runner",
    poolId: "default", sessionId: expect.any(String) }), walId);
  const denied = streamMock();
  await expect(handle(server, denied, { registration: { ...hello.registration, runnerId: "legacy-progress" } }, null))
    .rejects.toThrow("Authenticated telemetry progress is unavailable");
  expect(issue).toHaveBeenCalledTimes(1);
  expect(denied.write).not.toHaveBeenCalled();
});

it.each([{ epoch: 0, groupId: "foreign" }, { epoch: 1, groupId: "default" }])("does not dispatch stale allocation metadata %j", async allocation => {
  const service = serviceMock();
  service.runnerControlSessions.dispatchedAllocation.mockResolvedValue(allocation);
  const server = new RunnerControlServer(config, service as unknown as ControlPlaneService,
    metricsMock() as unknown as ControllerMetrics, { activeConfiguration: vi.fn().mockResolvedValue(null) } as unknown as ModelConfigurationService);
  const hello = registration("stale-allocation");
  hello.registration.labels = { "tasklattice.snapshot-ack": "1" };
  const stream = streamMock();
  await handle(server, stream, hello, null);
  expect(stream.write.mock.calls.some(([message]) => Boolean(message.desiredState))).toBe(false);
});

function serviceMock() {
  return {
    runnerControlSessions: { isCurrent: vi.fn().mockResolvedValue(true), dispatched: vi.fn().mockResolvedValue(true), dispatchedAllocation: vi.fn().mockResolvedValue({ epoch: 0, groupId: "default" }), acknowledged: vi.fn().mockResolvedValue(true) },
    registerRunner: vi.fn().mockResolvedValue(9),
    desiredStateForPool: vi.fn().mockResolvedValue({
      generation: 9,
      groupId: "default",
      allocationEpoch: 0,
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
  authorizedPoolId?: string,
) {
  return (server as unknown as {
    handleMessage: (
      stream: unknown,
      message: Record<string, unknown>,
      current: unknown,
      authorizedPoolId?: string,
    ) => Promise<unknown>;
  }).handleMessage(stream, message, current, authorizedPoolId);
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
