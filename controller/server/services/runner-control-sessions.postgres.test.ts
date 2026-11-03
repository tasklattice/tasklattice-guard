// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { loadConfig } from "../config.js";
import { ControlPlaneService } from "./control-plane.js";
import { RunnerLeaseLedger } from "./runner-lease-ledger.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("durable Runner control stream identity", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let first: ControlPlaneService;
  let second: ControlPlaneService;
  let ledger: RunnerLeaseLedger;
  const registration = { runnerId: "runner-a", bootId: "same-boot", poolId: "pool-a", runnerVersion: "test", nemoVersion: "test",
    compilerCapable: false, maxConcurrency: 1, labels: {}, appliedGeneration: 7 };
  const identity = (sessionId = "session-a") => ({ sessionId, runnerId: registration.runnerId, bootId: registration.bootId, poolId: registration.poolId });
  const snapshot = (sessionId = "session-a", nonce = "snapshot-a") => ({ ...identity(sessionId), nonce, generation: 7, modelRevisionId: "model-a" });
  const grant = (sessionId = "session-a", nonce = "grant-a", snapshotNonce = "snapshot-a") => ({ poolId: "pool-a", runnerId: "runner-a", bootId: "same-boot",
    controlSessionId: sessionId, nonce, epoch: 0, generation: 7, snapshotNonce, modelRevisionId: "model-a", durationMs: 5000, uncertaintyMs: 1000 });
  const heartbeat = (controlSessionId?: string) => ({ runnerId: "runner-a", bootId: "same-boot", controlSessionId, sequence: 99,
    appliedGeneration: 7, load: { inflight: 0, maxConcurrency: 1, queueDepth: 0, cpuUtilization: 0, memoryUtilization: 0, latencyP95Ms: 0 } });

  beforeAll(async () => {
    database = await createTestDatabase(url!, "runner_control_sessions");
    const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://unused:unused@localhost/unused",
      CONTROLLER_RUNNER_TOKEN: "synthetic-token-at-least-32-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/key",
      BETTER_AUTH_SECRET: "synthetic-auth-secret-at-least-32-characters" });
    first = new ControlPlaneService(database.db, config);
    second = new ControlPlaneService(database.db, config);
    ledger = new RunnerLeaseLedger(database.db);
  }, 30000);
  beforeEach(async () => {
    await database.pool.query(`DELETE FROM runner_serving_grant; DELETE FROM runner_instance; DELETE FROM runner_control_session;
      DELETE FROM runner_pool_lease_epoch; DELETE FROM runner_pool;
      INSERT INTO runner_pool (id,name) VALUES ('pool-a','Pool A');
      INSERT INTO controller_state (id,desired_generation) VALUES ('singleton',7) ON CONFLICT (id) DO UPDATE SET desired_generation=7;`);
  });
  afterAll(async () => { await database?.drop(); });

  const acknowledge = async (service: ControlPlaneService, sessionId = "session-a", nonce = "snapshot-a") => {
    expect(await service.runnerControlSessions.dispatched(snapshot(sessionId, nonce))).toBe(true);
    expect(await service.runnerControlSessions.acknowledged({ ...snapshot(sessionId, nonce), accepted: true })).toBe(true);
  };

  it("returns the exact persisted epoch and group for the snapshot being dispatched", async () => {
    await first.registerRunner(registration, "session-a");
    await database.pool.query("INSERT INTO runner_pool_lease_epoch(pool_id,epoch) VALUES ('pool-a',7)");
    expect(await first.runnerControlSessions.dispatchedAllocation(snapshot())).toEqual({ epoch: 7, groupId: "default" });
    expect((await database.pool.query("SELECT snapshot_epoch, snapshot_group_id, snapshot_nonce FROM runner_control_session WHERE id='session-a'")).rows)
      .toEqual([{ snapshot_epoch: '7', snapshot_group_id: 'default', snapshot_nonce: 'snapshot-a' }]);
    await second.registerRunner(registration, "session-b");
    expect(await first.runnerControlSessions.dispatchedAllocation(snapshot())).toBeNull();
  });

  it("rejects old same-boot heartbeat, disconnect, ACK and grant after another Controller replaces the stream", async () => {
    await first.registerRunner(registration, "session-a");
    await acknowledge(first);
    await ledger.issueSnapshotBound(grant());
    await second.registerRunner(registration, "session-b");
    expect(await first.runnerControlSessions.isCurrent(identity())).toBe(false);
    expect(await first.recordHeartbeat(heartbeat("session-a"))).toBe(false);
    expect(await first.recordHeartbeat(heartbeat())).toBe(false);
    await first.disconnectRunner("runner-a", "same-boot", "session-a");
    expect(await first.runnerControlSessions.acknowledged({ ...snapshot(), accepted: true })).toBe(false);
    await expect(ledger.issueSnapshotBound(grant("session-a", "stale-grant"))).rejects.toMatchObject({ code: "runner_lease_snapshot_unavailable" });
    expect(await second.runnerControlSessions.isCurrent(identity("session-b"))).toBe(true);
    expect(await second.recordHeartbeat(heartbeat("session-b"))).toBe(true);
    await acknowledge(second, "session-b", "snapshot-b");
    await ledger.issueSnapshotBound(grant("session-b", "grant-b", "snapshot-b"));
    expect((await database.pool.query("SELECT control_session_id FROM runner_serving_grant ORDER BY nonce")).rows)
      .toEqual([{ control_session_id: "session-a" }, { control_session_id: "session-b" }]);
  });

  it("requires the latest durably acknowledged snapshot and rejects ACK replay or missing session", async () => {
    await first.registerRunner(registration, "session-a");
    await expect(ledger.issueSnapshotBound(grant())).rejects.toMatchObject({ code: "runner_lease_snapshot_unavailable" });
    await acknowledge(first);
    expect(await first.runnerControlSessions.acknowledged({ ...snapshot(), accepted: true })).toBe(false);
    expect(await first.runnerControlSessions.dispatched(snapshot("session-a", "snapshot-b"))).toBe(true);
    await expect(ledger.issueSnapshotBound(grant())).rejects.toMatchObject({ code: "runner_lease_snapshot_unavailable" });
    expect(await first.runnerControlSessions.acknowledged({ ...snapshot(), accepted: true })).toBe(false);
    expect(await first.runnerControlSessions.acknowledged({ ...snapshot("session-a", "snapshot-b"), accepted: true })).toBe(true);
    await expect(ledger.issueSnapshotBound({ ...grant(), controlSessionId: undefined } as never)).rejects.toBeTruthy();
    await expect(ledger.issueSnapshotBound(grant("session-a", "fresh", "snapshot-b"))).resolves.toMatchObject({ controlSessionId: "session-a" });
    expect(JSON.stringify(await first.listRunnerPoolsWithCapacity())).not.toContain("session-a");
    expect(JSON.stringify(await first.listRunnerPoolsWithCapacity())).not.toContain("controlSessionId");
  });

  it("does not turn a rejected snapshot into grant authority with a replayed ACK", async () => {
    await first.registerRunner(registration, "session-a");
    expect(await first.runnerControlSessions.dispatched(snapshot())).toBe(true);
    expect(await first.runnerControlSessions.acknowledged({ ...snapshot(), accepted: false })).toBe(true);
    expect(await first.runnerControlSessions.acknowledged({ ...snapshot(), accepted: true })).toBe(false);
    await expect(ledger.issueSnapshotBound(grant())).rejects.toMatchObject({ code: "runner_lease_snapshot_unavailable" });
  });

  it("rejects snapshot ACK and grants when allocation epoch, group or generation changed", async () => {
    await first.registerRunner(registration, "session-a");
    await acknowledge(first);
    await database.pool.query("UPDATE runner_pool_lease_epoch SET epoch=1 WHERE pool_id='pool-a'");
    await expect(ledger.issueSnapshotBound({ ...grant(), epoch: 1 })).rejects.toMatchObject({ code: "runner_lease_snapshot_unavailable" });
    await database.pool.query("UPDATE runner_pool_lease_epoch SET epoch=0 WHERE pool_id='pool-a'; INSERT INTO tenant_group (id,name) VALUES ('new-group','New') ON CONFLICT DO NOTHING; UPDATE runner_pool SET group_id='new-group' WHERE id='pool-a'");
    await expect(ledger.issueSnapshotBound(grant())).rejects.toMatchObject({ code: "runner_lease_snapshot_unavailable" });
    await database.pool.query("UPDATE runner_pool SET group_id='default' WHERE id='pool-a'; UPDATE controller_state SET desired_generation=8 WHERE id='singleton'");
    await expect(ledger.issueSnapshotBound(grant())).rejects.toMatchObject({ code: "runner_lease_snapshot_unavailable" });
    expect(await first.runnerControlSessions.acknowledged({ ...snapshot(), accepted: true })).toBe(false);
  });

  it("serializes same-boot replacement against issuance and delayed disconnect without deleting grants", async () => {
    await first.registerRunner(registration, "session-a");
    await acknowledge(first);
    const [issued] = await Promise.allSettled([ledger.issueSnapshotBound(grant()), second.registerRunner(registration, "session-b"),
      first.disconnectRunner("runner-a", "same-boot", "session-a")]);
    expect(await second.runnerControlSessions.isCurrent(identity("session-b"))).toBe(true);
    const rows = (await database.pool.query("SELECT control_session_id FROM runner_serving_grant")).rows;
    expect(rows).toEqual(issued.status === "fulfilled" ? [{ control_session_id: "session-a" }] : []);
  });

  it("retains current sessions, snapshot evidence and grant history when migration is replayed", async () => {
    await first.registerRunner(registration, "session-a");
    await acknowledge(first);
    await ledger.issueSnapshotBound(grant());
    await database.pool.query(readFileSync(new URL("../db/migrations/0011_runner_control_sessions.sql", import.meta.url), "utf8"));
    expect(await first.runnerControlSessions.isCurrent(identity())).toBe(true);
    expect((await database.pool.query("SELECT snapshot_accepted FROM runner_control_session")).rows).toEqual([{ snapshot_accepted: true }]);
    expect((await database.pool.query("SELECT control_session_id FROM runner_serving_grant")).rows).toEqual([{ control_session_id: "session-a" }]);
  });
});
