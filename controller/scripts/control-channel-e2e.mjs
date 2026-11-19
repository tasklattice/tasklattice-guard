// Real Controller transport + domain codec for the Python communication suite.
// Only persistence/model lookup are fixtures; no alternate wire implementation.
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { loadConfig } from "../server/config.ts";
import { RunnerControlServer } from "../server/control-channel/control-server.ts";

const lines = createInterface({ input: process.stdin });
const input = JSON.parse(await new Promise(resolveLine => lines.once("line", resolveLine)));
lines.close();
if (input.invalidAction !== undefined) input.artifact.plan.steps[0].on_unsafe = input.invalidAction;
const config = loadConfig({
  NODE_ENV: "production", CONTROLLER_GRPC_TRANSPORT: "plaintext",
  CONTROLLER_METRICS_TOKEN: "fixture-metrics-token-at-least-32-characters",
  CONTROLLER_DATABASE_URL: "postgresql://unused:unused@localhost/unused",
  CONTROLLER_RUNNER_POOL_TOKENS_JSON: JSON.stringify({ default: "fixture-runner-token-at-least-32-characters" }),
  CONTROLLER_RUNNER_HTTP_TOKENS_JSON: JSON.stringify({ default: "fixture-http-token-at-least-32-characters" }),
  CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/unused/signing-key.pem",
  CONTROLLER_PROTO_PATH: resolve("../proto/tasklattice/guard/control/v1/runner_control.proto"),
  BETTER_AUTH_SECRET: "fixture-auth-secret-at-least-32-characters",
});
// Persist only the currently registered identity and dispatched challenge in
// this no-database harness. The production transport still verifies both on
// every message and ACK, just as it does through the real session repository.
const sessions = new Map();
const current = identity => {
  const session = sessions.get(identity.runnerId);
  return session?.sessionId === identity.sessionId && session.bootId === identity.bootId
    && session.poolId === identity.poolId;
};
const service = {
  runnerControlSessions: {
    async isCurrent(identity) { return current(identity); },
    async dispatchedAllocation(identity) {
      if (!current(identity)) return null;
      sessions.get(identity.runnerId).snapshot = identity;
      return { groupId: "default", epoch: 0 };
    },
    async acknowledged(identity) {
      if (!current(identity)) return false;
      const snapshot = sessions.get(identity.runnerId).snapshot;
      return snapshot?.nonce === identity.nonce && snapshot.generation === identity.generation
        && snapshot.modelRevisionId === identity.modelRevisionId;
    },
  },
  protectionModes: {
    async desiredState() { return { generation: 1, modes: { [input.artifact.guardrailId]: "bypass" } }; },
    async recordResult(result) { if (!result.accepted) throw new Error(result.reason); },
  },
  async registerRunner(registration, sessionId) {
    sessions.set(registration.runnerId, { ...registration, sessionId });
    return 1;
  },
  async disconnectRunner(runnerId, bootId, sessionId) {
    const session = sessions.get(runnerId);
    if (session?.bootId === bootId && session.sessionId === sessionId) sessions.delete(runnerId);
  },
  async recordHeartbeat(heartbeat) {
    const session = sessions.get(heartbeat.runnerId);
    return session?.bootId === heartbeat.bootId && session.sessionId === heartbeat.controlSessionId;
  },
  async desiredGeneration() { return 1; },
  async desiredStateForPool() {
    return { generation: 1, groupId: "default", allocationEpoch: 0,
      artifacts: [input.artifact], routers: [], endpoints: input.endpoints ?? [],
      disabledGuardrailIds: [], disabledEndpointIds: [], guardrailLoggingLevels: {} };
  },
};
const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
const metrics = {
  observeControlMessage(direction, type, outcome) {
    if (direction === "received" && type === "desiredStateResult" && !outcome) {
      void server.distributionStatus().then(value => emit({ type: "ack", ...value }));
    }
  },
  controlConnection() {}, observeReconcile() {}, observeArtifactResult() {}, observeHeartbeat() {},
};
const server = new RunnerControlServer(config, service, metrics, { async activeConfiguration() { return null; } });
// OS-assigned port; avoid production reconciliation timers and database jobs.
const port = await new Promise((resolvePort, reject) => server.grpc.bindAsync(
  "127.0.0.1:0", server.credentials(), (error, port) => error ? reject(error) : resolvePort(port),
));
emit({ type: "ready", port });
process.once("SIGTERM", () => { server.grpc.forceShutdown(); process.exit(0); });
