// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { RunnerLeaseLedger } from "./runner-lease-ledger.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("durable Runner lease ledger (not live serving)", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let first: RunnerLeaseLedger;
  let second: RunnerLeaseLedger;
  const grant = { poolId: "pool-a", runnerId: "runner-1", bootId: "boot-1", nonce: "unique-1",
    epoch: 0, generation: 7, durationMs: 5_000, uncertaintyMs: 1_000 };

  beforeAll(async () => {
    database = await createTestDatabase(url!, "runner_lease_ledger");
    first = new RunnerLeaseLedger(database.db);
    second = new RunnerLeaseLedger(database.db);
  }, 30_000);
  beforeEach(async () => {
    await database.pool.query(`DELETE FROM runner_serving_grant; DELETE FROM runner_instance; DELETE FROM runner_control_session; DELETE FROM runner_pool_lease_epoch;
      DELETE FROM runner_pool; INSERT INTO runner_pool (id,name) VALUES ('pool-a','Pool A');`);
  });
  afterAll(async () => { await database?.drop(); });

  it("persists a conservative grant and rejects duplicate nonce without extending it", async () => {
    const issued = await first.issue(grant);
    expect(issued.conservativeExpiresAt.getTime() - issued.issuedAt.getTime()).toBeGreaterThanOrEqual(5_999);
    expect(await second.outstanding("pool-a", 0)).toMatchObject({ count: 1 });
    await expect(second.issue(grant)).rejects.toMatchObject({ code: "runner_lease_challenge_conflict" });
    await expect(second.issue({ ...grant, generation: 8 })).rejects.toMatchObject({ code: "runner_lease_challenge_conflict" });
    const row = await database.pool.query("SELECT generation,conservative_expires_at FROM runner_serving_grant");
    expect(Number(row.rows[0].generation)).toBe(7);
    expect(row.rows[0].conservative_expires_at.getTime()).toBe(issued.conservativeExpiresAt.getTime());
  });

  it("retains older boot grants independently of Runner registrations and later boots", async () => {
    await first.issue(grant);
    await second.issue({ ...grant, bootId: "boot-2", nonce: "unique-2" });
    expect(await first.outstanding("pool-a", 0)).toMatchObject({ count: 2 });
    await expect(database.pool.query("DELETE FROM runner_pool WHERE id='pool-a'")).rejects.toMatchObject({ code: "23503" });
    expect((await database.pool.query("SELECT boot_id FROM runner_serving_grant ORDER BY boot_id")).rows)
      .toEqual([{ boot_id: "boot-1" }, { boot_id: "boot-2" }]);
  });

  it("preserves outstanding grants and drain state if migration is replayed", async () => {
    await first.issue(grant);
    await first.beginDrain("pool-a", 0);
    const migration = readFileSync(new URL("../db/migrations/0009_runner_lease_ledger.sql", import.meta.url), "utf8");
    await database.pool.query(migration);
    expect(await second.outstanding("pool-a", 0)).toMatchObject({ count: 1 });
    await expect(second.issue({ ...grant, nonce: "replay-late" })).rejects.toMatchObject({ code: "runner_lease_epoch_unavailable" });
  });

  it("drains durably and rejects all later grants, without erasing prior grants", async () => {
    await first.issue(grant);
    expect(await second.beginDrain("pool-a", 0)).toMatchObject({ epoch: 0, draining: true });
    expect(await first.beginDrain("pool-a", 0)).toMatchObject({ epoch: 0, draining: true });
    await expect(first.issue({ ...grant, nonce: "late" })).rejects.toMatchObject({ code: "runner_lease_epoch_unavailable" });
    await expect(first.issue(grant)).rejects.toMatchObject({ code: "runner_lease_epoch_unavailable" });
    expect(await second.outstanding("pool-a", 0)).toMatchObject({ count: 1 });
    await expect(second.beginDrain("pool-a", 1)).rejects.toMatchObject({ code: "runner_lease_epoch_conflict" });
  });

  it("serializes independent Controller instances racing issuance and drain", async () => {
    const [issuance, drain] = await Promise.allSettled([first.issue(grant), second.beginDrain("pool-a", 0)]);
    expect(drain.status).toBe("fulfilled");
    if (issuance.status === "fulfilled") {
      expect(await second.outstanding("pool-a", 0)).toMatchObject({ count: 1 });
    } else {
      expect(issuance.reason).toMatchObject({ code: "runner_lease_epoch_unavailable" });
      expect(await second.outstanding("pool-a", 0)).toMatchObject({ count: 0 });
    }
    await expect(first.issue({ ...grant, nonce: "after-drain" })).rejects.toMatchObject({ code: "runner_lease_epoch_unavailable" });
  });

  it("only grants a repeated concurrent challenge once across Controllers", async () => {
    const results = await Promise.allSettled([first.issue(grant), second.issue(grant)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(await first.outstanding("pool-a", 0)).toMatchObject({ count: 1 });
  });

  it("binds protocol grants to the current registered boot and snapshot generation", async () => {
    await database.pool.query(`INSERT INTO runner_instance (runner_id,boot_id,pool_id,runner_version,nemo_version,max_concurrency,status)
      VALUES ('runner-1','boot-1','pool-a','test','test',1,'ready');
      INSERT INTO controller_state (id,desired_generation) VALUES ('singleton',7)
      ON CONFLICT (id) DO UPDATE SET desired_generation=7;
      INSERT INTO runner_control_session (id,runner_id,boot_id,pool_id,snapshot_nonce,snapshot_generation,snapshot_model_revision_id,snapshot_epoch,snapshot_group_id,snapshot_acknowledged_at,snapshot_accepted)
        VALUES ('session-1','runner-1','boot-1','pool-a','snapshot-1',7,'model-1',0,'default',now(),true);
      UPDATE runner_instance SET control_session_id='session-1' WHERE runner_id='runner-1';`);
    const bound = { ...grant, snapshotNonce: "snapshot-1", modelRevisionId: "model-1", controlSessionId: "session-1" };
    await expect(first.issueSnapshotBound({ ...bound, bootId: "old" })).rejects.toMatchObject({ code: "runner_lease_snapshot_unavailable" });
    await expect(first.issueSnapshotBound({ ...bound, generation: 8 })).rejects.toMatchObject({ code: "runner_lease_snapshot_unavailable" });
    await expect(first.issueSnapshotBound(bound)).resolves.toMatchObject({ snapshotNonce: "snapshot-1", modelRevisionId: "model-1" });
    await expect(second.issueSnapshotBound(bound)).rejects.toMatchObject({ code: "runner_lease_challenge_conflict" });
    const stored = await database.pool.query("SELECT snapshot_nonce,model_revision_id FROM runner_serving_grant");
    expect(stored.rows).toEqual([{ snapshot_nonce: "snapshot-1", model_revision_id: "model-1" }]);
  });

  it("waits for the same advisory lock used by allocation changes", async () => {
    const holder = await database.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtext('traffic-router-bindings'))");
      const pending = first.issue(grant);
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const result = await database.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event = 'advisory'
            AND query LIKE '%pg_advisory_xact_lock%' AND pid <> pg_backend_pid()`);
        waiting = result.rows[0].n > 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
      await holder.query("COMMIT");
      expect(await pending).toMatchObject({ poolId: "pool-a", epoch: 0 });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });

  it("serializes generation updates with a snapshot-bound grant until its insert commits", async () => {
    await database.pool.query(`INSERT INTO runner_instance (runner_id,boot_id,pool_id,runner_version,nemo_version,max_concurrency,status)
      VALUES ('runner-1','boot-1','pool-a','test','test',1,'ready');
      INSERT INTO controller_state (id,desired_generation) VALUES ('singleton',7)
      ON CONFLICT (id) DO UPDATE SET desired_generation=7;
      INSERT INTO runner_control_session (id,runner_id,boot_id,pool_id,snapshot_nonce,snapshot_generation,snapshot_model_revision_id,snapshot_epoch,snapshot_group_id,snapshot_acknowledged_at,snapshot_accepted)
        VALUES ('session-1','runner-1','boot-1','pool-a','snapshot-1',7,'model-1',0,'default',now(),true);
      UPDATE runner_instance SET control_session_id='session-1' WHERE runner_id='runner-1';
      CREATE FUNCTION hold_grant_insert() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(hashtext(TG_TABLE_SCHEMA || ':grant-before-insert')); RETURN NEW; END $$;
      CREATE TRIGGER hold_grant BEFORE INSERT ON runner_serving_grant FOR EACH ROW EXECUTE FUNCTION hold_grant_insert();`);
    const holder = await database.pool.connect();
    const key = `${(await holder.query("SELECT current_schema() AS name")).rows[0].name}:grant-before-insert`;
    let issuance: Promise<unknown> | undefined;
    let update: Promise<unknown> | undefined;
    const waiting = async (query: string, event?: string) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = await database.pool.query(`SELECT 1 FROM pg_stat_activity WHERE application_name = current_setting('application_name')
          AND wait_event_type = 'Lock' AND query LIKE $1 AND ($2::text IS NULL OR wait_event=$2)`, [query, event ?? null]);
        if (rows.rowCount) return true;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return false;
    };
    try {
      await holder.query("SELECT pg_advisory_lock(hashtext($1))", [key]);
      issuance = first.issueSnapshotBound({ ...grant, snapshotNonce: "snapshot-1", modelRevisionId: "model-1", controlSessionId: "session-1" });
      expect(await waiting('%insert into "runner_serving_grant"%', "advisory")).toBe(true);
      // This writer takes the ordinary row lock, without the allocation lock.
      update = database.pool.query("UPDATE controller_state SET desired_generation=8 WHERE id='singleton'");
      expect(await waiting("UPDATE controller_state SET desired_generation=8%")).toBe(true);
      await holder.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
      await expect(issuance).resolves.toMatchObject({ generation: 7 });
      await update;
      expect(Number((await database.pool.query("SELECT desired_generation FROM controller_state WHERE id='singleton'")).rows[0].desired_generation)).toBe(8);
    } finally {
      await holder.query("SELECT pg_advisory_unlock_all()");
      holder.release();
      await Promise.allSettled([issuance, update].filter((item): item is Promise<unknown> => Boolean(item)));
      await database.pool.query("DROP TRIGGER hold_grant ON runner_serving_grant; DROP FUNCTION hold_grant_insert()");
    }
  });

  it("rejects unknown pools, wrong epochs, invalid input and leaves no grants", async () => {
    await expect(first.issue({ ...grant, poolId: "missing" })).rejects.toMatchObject({ code: "not_found" });
    await expect(first.issue({ ...grant, epoch: 1 })).rejects.toMatchObject({ code: "runner_lease_epoch_unavailable" });
    for (const bad of [{ durationMs: 0 }, { durationMs: 60_001 }, { uncertaintyMs: -1 },
      { generation: Number.MAX_SAFE_INTEGER + 1 }, { nonce: " " }]) {
      await expect(first.issue({ ...grant, ...bad })).rejects.toBeTruthy();
    }
    expect(Number((await database.pool.query("SELECT count(*) FROM runner_serving_grant")).rows[0].count)).toBe(0);
  });
});
