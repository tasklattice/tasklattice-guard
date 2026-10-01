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
  CONTROLLER_RUNNER_TOKEN: "fixture-runner-token-at-least-32-characters",
  CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/unused/signing-key.pem",
  CONTROLLER_PROTO_PATH: resolve("../proto/tasklattice/guard/control/v1/runner_control.proto"),
  BETTER_AUTH_SECRET: "fixture-auth-secret-at-least-32-characters",
});
const service = {
  async registerRunner() { return 1; },
  async disconnectRunner() {},
  async desiredGeneration() { return 1; },
  async desiredStateForPool() {
    return { generation: 1, artifacts: [input.artifact], routers: [], endpoints: [],
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
  controlConnection() {}, observeReconcile() {}, observeArtifactResult() {},
};
const server = new RunnerControlServer(config, service, metrics, { async activeConfiguration() { return null; } });
// OS-assigned port; avoid production reconciliation timers and database jobs.
const port = await new Promise((resolvePort, reject) => server.grpc.bindAsync(
  "127.0.0.1:0", server.credentials(), (error, port) => error ? reject(error) : resolvePort(port),
));
emit({ type: "ready", port });
process.once("SIGTERM", () => { server.grpc.forceShutdown(); process.exit(0); });
