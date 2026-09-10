import { dirname, resolve } from "node:path";

import { credentials, loadPackageDefinition, Metadata, Server, ServerCredentials, status } from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import type { ProtoGrpcType } from "../generated/control-protocol/runner_control.js";
import type { ControllerMetrics } from "../metrics.js";
import type { ModelConfigurationService } from "../model-config/service.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import { RunnerControlServer } from "./control-server.js";
import { CONTROL_MESSAGE_MAX_BYTES, controlChannelOptions } from "./transport.js";

const config = loadConfig({
  NODE_ENV: "test",
  CONTROLLER_DATABASE_URL: "postgresql://controller:controller@localhost/controller",
  CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters",
  CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/controller-signing-key.pem",
  CONTROLLER_PROTO_PATH: resolve("../proto/tasklattice/guard/control/v1/runner_control.proto"),
  BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
});

describe("production Controller gRPC transport budget", () => {
  it.each([false, true])("preserves large evidence and rejects oversized messages (oversized=%s)", async (oversized) => {
    // Synthetic content tests transport integrity, not detector correctness.
    const evidence = "x".repeat(oversized ? CONTROL_MESSAGE_MAX_BYTES : 5 * 1024 * 1024) + "END";
    const desiredId = "disabled-" + "d".repeat(5 * 1024 * 1024);
    const service = {
      registerRunner: vi.fn().mockResolvedValue(1),
      desiredStateForPool: vi.fn().mockResolvedValue({
        generation: 1, artifacts: [], routers: [], endpoints: [],
        disabledGuardrailIds: [desiredId], disabledEndpointIds: [], guardrailLoggingLevels: {},
      }),
      disconnectRunner: vi.fn(),
      completeValidation: vi.fn(),
    };
    const metrics = {
      observeControlMessage: vi.fn(), controlConnection: vi.fn(),
      observeReconcile: vi.fn(), observeJob: vi.fn(),
    };
    const server = new RunnerControlServer(config, service as unknown as ControlPlaneService,
      metrics as unknown as ControllerMetrics,
      { activeConfiguration: vi.fn().mockResolvedValue(null) } as unknown as ModelConfigurationService);
    // Bind the actual production server to an ephemeral port without starting
    // database/outbox timers unrelated to this socket-level regression.
    const grpcServer = (server as unknown as { grpc: Server }).grpc;
    const port = await new Promise<number>((resolvePort, reject) => {
      grpcServer.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (error, value) => {
        if (error) reject(error); else resolvePort(value);
      });
    });
    const descriptor = loadPackageDefinition(loadSync(config.protoPath, {
      includeDirs: [dirname(config.protoPath)], longs: String, enums: String, defaults: true, oneofs: true,
    })) as unknown as ProtoGrpcType;
    const client = new descriptor.tasklattice.guard.control.v1.RunnerControl(
      `127.0.0.1:${port}`, credentials.createInsecure(), {
        ...controlChannelOptions,
        // Permit the oversized request at the test sender to exercise the
        // production server's receive bound rather than a client-side refusal.
        "grpc.max_send_message_length": CONTROL_MESSAGE_MAX_BYTES + 1024 * 1024,
      },
    );
    const metadata = new Metadata();
    metadata.set("authorization", `Bearer ${config.runnerToken}`);
    const stream = client.Connect(metadata, { deadline: Date.now() + 10_000 });
    let receivedDesired: string | undefined;
    let errorCode: number | undefined;
    stream.on("error", (error: { code: number }) => { errorCode = error.code; });
    stream.on("data", (message) => {
      if (message.desiredState) receivedDesired = message.desiredState.disabledGuardrailIds[0];
    });
    try {
      stream.write({ registration: {
        runnerId: "transport-runner", bootId: "boot-1", poolId: "default", compilerCapable: true,
      } });
      await expect.poll(() => receivedDesired, { timeout: 5_000 }).toBe(desiredId);
      stream.write({ validationResult: {
        runnerId: "transport-runner", runId: "large-validation", accepted: true,
        status: "VALIDATION_STATUS_PASSED", metrics: { total: 321, passed: 321 },
        reason: evidence,
        results: Array.from({ length: 321 }, (_, i) => ({
          caseId: `case-${i}`, passed: true,
          expectedDecision: "VALIDATION_DECISION_ALLOW", actualDecision: "VALIDATION_DECISION_ALLOW",
        })),
      } });
      if (oversized) {
        await expect.poll(() => errorCode, { timeout: 5_000 }).toBe(status.RESOURCE_EXHAUSTED);
        expect(service.completeValidation).not.toHaveBeenCalled();
      } else {
        await expect.poll(() => service.completeValidation.mock.calls.length, { timeout: 5_000 }).toBe(1);
        const delivered = service.completeValidation.mock.calls[0][0];
        expect(delivered.reason).toBe(evidence);
        expect(delivered.results).toHaveLength(321);
        expect(delivered.results.at(-1).caseId).toBe("case-320");
        expect(errorCode).toBeUndefined();
      }
    } finally {
      stream.cancel();
      client.close();
      await server.stop();
    }
  }, 20_000);
});
