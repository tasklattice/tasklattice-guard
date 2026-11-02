// @vitest-environment node
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { status } from "@grpc/grpc-js";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import type { ControllerMetrics } from "../metrics.js";
import type { ModelConfigurationService } from "../model-config/service.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import { RunnerControlServer } from "./control-server.js";

const legacy = "legacy-controller-token-with-32-characters";
const tokens = { "pool-a": "pool-a-secret-with-at-least-32-characters", "pool-b": "pool-b-secret-with-at-least-32-characters", default: "default-secret-with-at-least-32-characters" };
function makeConfig(scoped: boolean) {
  return loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://unused:unused@localhost/unused",
    CONTROLLER_RUNNER_TOKEN: legacy, CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/test-key.pem",
    CONTROLLER_PROTO_PATH: resolve("../proto/tasklattice/guard/control/v1/runner_control.proto"),
    BETTER_AUTH_SECRET: "synthetic-test-auth-secret-at-least-32-chars",
    ...(scoped ? { CONTROLLER_RUNNER_POOL_TOKENS_JSON: JSON.stringify(tokens) } : {}),
  });
}
function setup(scoped = true) {
  const service = {
    runnerControlSessions: { isCurrent: vi.fn().mockResolvedValue(true), dispatched: vi.fn().mockResolvedValue(true), dispatchedAllocation: vi.fn().mockResolvedValue({ epoch: 0, groupId: "default" }), acknowledged: vi.fn().mockResolvedValue(true) },
    registerRunner: vi.fn(async () => 7), disconnectRunner: vi.fn(),
    desiredStateForPool: vi.fn(async (poolId: string) => ({ generation: 7, artifacts: [], disabledGuardrailIds: [], disabledEndpointIds: [], routerRevisions: [],
      endpoints: [{ endpointId: `endpoint-${poolId}`, adapter: "litellm-generic-guardrail", trafficRouterId: "", verification: { credentials: [] } }], guardrailLoggingLevels: {} })),
  };
  const metrics = Object.fromEntries(["observeControlMessage", "controlConnection", "observeReconcile", "observeArtifactResult", "observeJob", "observeHeartbeat"].map(key => [key, vi.fn()]));
  const models = { activeConfiguration: vi.fn(async () => null), bindValidationLease: vi.fn(() => true) };
  const server = new RunnerControlServer(makeConfig(scoped), service as unknown as ControlPlaneService, metrics as unknown as ControllerMetrics,
    models as unknown as ModelConfigurationService);
  return { server, service, models };
}
function connect(server: RunnerControlServer, token: string, poolId: string, compilerCapable = false) {
  const errors: Array<Error & { code?: number }> = [];
  const writes: any[] = [];
  const stream = Object.assign(new EventEmitter(), {
    metadata: { get: () => [`Bearer ${token}`] },
    end: vi.fn(), write: vi.fn((message: unknown) => { writes.push(message); }),
  });
  stream.on("error", error => errors.push(error));
  (server as unknown as { connect(stream: unknown): void }).connect(stream);
  stream.emit("data", { registration: { runnerId: `runner-${poolId}`, bootId: "boot", poolId, runnerVersion: "test", nemoVersion: "test", maxConcurrency: 4,
    compilerCapable, labels: {}, appliedGeneration: "0" } });
  return { errors, writes };
}

describe("pool-bound Runner control channel", () => {
  it("allows each scoped credential only its configured pool and its state", async () => {
    const { server, service } = setup();
    const a = connect(server, tokens["pool-a"], "pool-a");
    const b = connect(server, tokens["pool-b"], "pool-b");
    await vi.waitFor(() => expect(service.registerRunner).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(service.desiredStateForPool).toHaveBeenCalledTimes(2));
    expect(a.errors).toHaveLength(0);
    expect(b.errors).toHaveLength(0);
    expect(service.registerRunner).toHaveBeenCalledWith(expect.objectContaining({ poolId: "pool-a" }), expect.any(String));
    expect(service.registerRunner).toHaveBeenCalledWith(expect.objectContaining({ poolId: "pool-b" }), expect.any(String));
  });
  it("rejects a valid credential claiming another pool before any registration or state lookup", async () => {
    const { server, service } = setup();
    const attempt = connect(server, tokens["pool-a"], "pool-b");
    await vi.waitFor(() => expect(attempt.errors).toHaveLength(1));
    expect(attempt.errors[0]?.code).toBe(status.PERMISSION_DENIED);
    expect(service.registerRunner).not.toHaveBeenCalled();
    expect(service.desiredStateForPool).not.toHaveBeenCalled();
    expect(attempt.writes).toHaveLength(0);
  });
  it.each([legacy, "unknown-credential-with-32-characters"])("rejects legacy or unknown credential in scoped mode", async token => {
    const { server, service } = setup();
    const attempt = connect(server, token, "pool-a");
    expect(attempt.errors[0]?.code).toBe(status.UNAUTHENTICATED);
    expect(service.registerRunner).not.toHaveBeenCalled();
    expect(service.desiredStateForPool).not.toHaveBeenCalled();
  });
  it("retains the explicitly unscoped legacy control channel when no map is configured", async () => {
    const { server, service } = setup(false);
    const attempt = connect(server, legacy, "pool-b");
    await vi.waitFor(() => expect(service.registerRunner).toHaveBeenCalledOnce());
    expect(attempt.errors).toHaveLength(0);
  });
  it("binds a candidate lease to the selected pool before dispatch and fails closed if binding fails", async () => {
    const { server, service, models } = setup();
    const runner = connect(server, tokens.default, "default", true);
    await vi.waitFor(() => expect(service.desiredStateForPool).toHaveBeenCalledOnce());
    models.bindValidationLease.mockReturnValueOnce(false);
    expect(await server.validateRail({ requestId: "refused", credentialLeaseId: "lease-1" }))
      .toMatchObject({ passed: false });
    expect(runner.writes.some(message => message.capabilityValidationRequest?.requestId === "refused")).toBe(false);
    const pending = server.validateRail({ requestId: "sent", credentialLeaseId: "lease-2" });
    await vi.waitFor(() => expect(models.bindValidationLease).toHaveBeenLastCalledWith("lease-2", "default", expect.objectContaining({ poolId: "default", runnerId: "runner-default", bootId: "boot", sessionId: expect.any(String) })));
    await vi.waitFor(() => expect(runner.writes.some(message => message.capabilityValidationRequest?.requestId === "sent")).toBe(true));
    await server.stop();
    expect(await pending).toMatchObject({ passed: false });
  });
});
