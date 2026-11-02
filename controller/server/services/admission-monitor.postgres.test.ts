// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { loadConfig } from "../config.js";
import { ControlPlaneService } from "./control-plane.js";
import type { RunnerLoad } from "../domain/models.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
const load: RunnerLoad = { inflight: 0, maxConcurrency: 4, queueDepth: 0, requestsDelta: 0, errorsDelta: 0, timeoutsDelta: 0,
  latencyP95Ms: 0, cpuUtilization: 0, memoryUtilization: 0, activeGuardrails: 0, compileQueueDepth: 0, observationIntervalMs: 10000 };
function report(ids = ["tenantA", "tenantB"]) {
  return Buffer.from(JSON.stringify({ version: 1, available: true, capacity: 4, monotonicSeconds: 10,
    tenants: ids.map(tenantId => ({ tenantId, active: 1, queued: 0, limit: 2,
      outcomes: { admitted: 0, queue_full: 0, queue_timeout: 0, rate_limited: 0, cancelled: 0, unavailable: 0 },
      wait: { buckets: Array(15).fill(0), count: 0, totalSeconds: 0 }, held: { buckets: Array(15).fill(0), count: 0, totalSeconds: 0 } })) }));
}
describe.skipIf(!url)("admission monitoring uses accepted durable Runner identity", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>, service: ControlPlaneService;
  let config: ReturnType<typeof loadConfig>;
  beforeAll(async () => {
    database = await createTestDatabase(url!, "admission_monitor");
    config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: url!, CONTROLLER_RUNNER_TOKEN: "test-runner-token-that-is-at-least-32-characters",
      BETTER_AUTH_SECRET: "test-auth-secret-that-is-at-least-32-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/test-key.pem" });
    await database.pool.query(`INSERT INTO controller_state(id,desired_generation) VALUES ('singleton',7) ON CONFLICT(id) DO UPDATE SET desired_generation=7;
      INSERT INTO tenant_group(id,name) VALUES ('ab','A + B'),('c','C isolated');
      UPDATE tenant SET group_id=CASE WHEN id='tenantC' THEN 'c' ELSE 'ab' END;
      INSERT INTO runner_pool(id,name,group_id) VALUES ('pool-ab','Shared','ab'),('pool-c','Isolated','c');`);
  }, 30000);
  beforeEach(async () => {
    service = new ControlPlaneService(database.db, config);
    await database.pool.query(`DELETE FROM runner_instance; DELETE FROM runner_control_session;
      UPDATE tenant SET group_id=CASE WHEN id='tenantC' THEN 'c' ELSE 'ab' END;
      INSERT INTO runner_control_session(id,runner_id,boot_id,pool_id) VALUES ('session-ab','runner-ab','boot-ab','pool-ab');
      INSERT INTO runner_instance(runner_id,boot_id,pool_id,runner_version,nemo_version,status,max_concurrency,control_session_id)
      VALUES ('runner-ab','boot-ab','pool-ab','test','test','ready',4,'session-ab');`);
  });
  afterAll(async () => { await database?.drop(); });
  const heartbeat = (sequence: number, session = "session-ab", admissionSnapshot = report()) => service.recordHeartbeat({
    runnerId: "runner-ab", bootId: "boot-ab", controlSessionId: session, sequence, appliedGeneration: 7, load, admissionSnapshot });

  it("records only accepted monotonic heartbeats and returns current source-pool placement", async () => {
    expect(await heartbeat(1)).toBe(true);
    expect((await service.admissionMonitor.view("pool-ab")).groups[0]).toMatchObject({ id: "ab", available: true, values: { active: 2, capacity: 4 } });
    expect(await heartbeat(1, "session-ab", report(["foreign-private-label"]))).toBe(false);
    const result = await service.admissionMonitor.view("pool-ab");
    expect(result.groups[0]!.available).toBe(true); expect(JSON.stringify(result)).not.toContain("foreign-private-label");
    expect((await service.admissionMonitor.view("unknown-pool")).groups).toEqual([]);
  });
  it("rejects old-session metrics after replacement and after durable session disconnection", async () => {
    expect(await heartbeat(1)).toBe(true);
    await database.pool.query(`UPDATE runner_control_session SET disconnected_at=clock_timestamp() WHERE id='session-ab';
      INSERT INTO runner_control_session(id,runner_id,boot_id,pool_id) VALUES ('replacement','runner-ab','boot-ab','pool-ab');
      UPDATE runner_instance SET control_session_id='replacement' WHERE runner_id='runner-ab';`);
    expect(await heartbeat(2)).toBe(false);
    expect((await service.admissionMonitor.view("pool-ab")).groups[0]!.values.active).toBeNull();
    expect(await heartbeat(2, "replacement")).toBe(true);
    expect((await service.admissionMonitor.view("pool-ab")).groups[0]!.values.active).toBe(2);
    await database.pool.query("UPDATE runner_control_session SET disconnected_at=clock_timestamp() WHERE id='replacement'");
    expect((await service.admissionMonitor.view("pool-ab")).groups[0]!.values.active).toBeNull();
  });
  it("refuses a reported tenant after its database group assignment changes", async () => {
    expect(await heartbeat(1)).toBe(true);
    await database.pool.query("UPDATE tenant SET group_id='c' WHERE id='tenantB'");
    expect((await service.admissionMonitor.view("pool-ab")).groups[0]).toMatchObject({ available: false, reason: "tenant_group_mismatch", values: { active: null } });
  });
});
