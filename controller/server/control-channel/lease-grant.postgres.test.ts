// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { loadConfig } from "../config.js";
import type { ControllerMetrics } from "../metrics.js";
import type { ModelConfigurationService } from "../model-config/service.js";
import { ControlPlaneService } from "../services/control-plane.js";
import { RunnerLeaseLedger } from "../services/runner-lease-ledger.js";
import { RunnerControlServer } from "./control-server.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
const poolToken = "pool-a-secret-with-at-least-32-characters";
describe.skipIf(!url)("experimental authenticated lease probe and durable ledger", () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let server: RunnerControlServer;
  beforeAll(async () => {
    db = await createTestDatabase(url!, "lease_probe");
    await db.pool.query(`INSERT INTO runner_pool (id,name) VALUES ('pool-a','Pool A');
      INSERT INTO runner_instance (runner_id,boot_id,pool_id,runner_version,nemo_version,max_concurrency,status)
      VALUES ('runner-a','boot-a','pool-a','test','test',1,'ready');
      INSERT INTO controller_state (id,desired_generation) VALUES ('singleton',7)
      ON CONFLICT (id) DO UPDATE SET desired_generation=7`);
    const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://unused:unused@localhost/unused",
      CONTROLLER_RUNNER_TOKEN: "legacy-token-with-at-least-32-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/test-key.pem",
      CONTROLLER_PROTO_PATH: resolve("../proto/tasklattice/guard/control/v1/runner_control.proto"), BETTER_AUTH_SECRET: "synthetic-test-auth-secret-at-least-32-chars",
      CONTROLLER_RUNNER_POOL_TOKENS_JSON: JSON.stringify({ "pool-a": poolToken }), CONTROLLER_EXPERIMENTAL_RUNNER_LEASE_GRANTS: "true" });
    const service = new ControlPlaneService(db.db, config);
    vi.spyOn(service, "desiredStateForPool").mockResolvedValue({ generation: 7, groupId: "default", artifacts: [], disabledGuardrailIds: [], disabledEndpointIds: [], routerRevisions: [], endpoints: [], guardrailLoggingLevels: {} });
    const metrics = Object.fromEntries(["observeControlMessage", "controlConnection", "observeReconcile", "observeArtifactResult", "observeJob", "observeHeartbeat"].map(k => [k, vi.fn()]));
    server = new RunnerControlServer(config, service as unknown as ControlPlaneService, metrics as unknown as ControllerMetrics,
      { activeConfiguration: vi.fn(async () => null) } as unknown as ModelConfigurationService, new RunnerLeaseLedger(db.db));
  }, 30000);
  afterAll(async () => { await server?.stop(); await db?.drop(); });
  it("persists an exact-snapshot grant before replying and rejects replay and draining", async () => {
    const writes: Array<Record<string, any>> = [];
    const stream = Object.assign(new EventEmitter(), { metadata: { get: () => [`Bearer ${poolToken}`] },
      end: vi.fn(), write: vi.fn((message: Record<string, any>) => { writes.push(message); }) });
    stream.on("error", () => {});
    (server as unknown as { connect(stream: unknown): void }).connect(stream);
    stream.emit("data", { registration: { runnerId: "runner-a", bootId: "boot-a", poolId: "pool-a", runnerVersion: "test", nemoVersion: "test",
      maxConcurrency: 1, compilerCapable: false, appliedGeneration: "0", labels: { "tasklattice.snapshot-ack": "1", "tasklattice.lease-probe": "1" } } });
    await vi.waitFor(() => expect(writes.some(item => item.desiredState)).toBe(true));
    const nonce = writes.find(item => item.desiredState)!.desiredState.snapshotNonce;
    stream.emit("data", { desiredStateResult: { runnerId: "runner-a", generation: "7", accepted: true, reason: "", modelRevisionId: "", snapshotNonce: nonce } });
    const request = { runnerId: "runner-a", bootId: "boot-a", nonce: "lease-1", epoch: "0", generation: "7", snapshotNonce: nonce };
    stream.emit("data", { servingLeaseRequest: request });
    await vi.waitFor(() => expect(writes.some(item => item.servingLeaseResponse?.granted === true)).toBe(true));
    expect((await db.pool.query("SELECT pool_id,runner_id,boot_id,nonce,snapshot_nonce,model_revision_id FROM runner_serving_grant")).rows)
      .toEqual([{ pool_id: "pool-a", runner_id: "runner-a", boot_id: "boot-a", nonce: "lease-1", snapshot_nonce: nonce, model_revision_id: "" }]);
    stream.emit("data", { servingLeaseRequest: request });
    await vi.waitFor(() => expect(writes.filter(item => item.servingLeaseResponse).length).toBe(2));
    expect(writes.filter(item => item.servingLeaseResponse).at(-1)!.servingLeaseResponse.granted).toBe(false);
    await new RunnerLeaseLedger(db.db).beginDrain("pool-a", 0);
    stream.emit("data", { servingLeaseRequest: { ...request, nonce: "lease-2" } });
    await vi.waitFor(() => expect(writes.filter(item => item.servingLeaseResponse).length).toBe(3));
    expect(writes.filter(item => item.servingLeaseResponse).at(-1)!.servingLeaseResponse.granted).toBe(false);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM runner_serving_grant")).rows[0].n).toBe(1);
  }, 30000);
});
