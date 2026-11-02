// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { TenantGroupMovePreparationService } from "./tenant-group-moves.js";
import { TenantGroupService } from "./tenant-groups.js";
import { RunnerLeaseLedger } from "./runner-lease-ledger.js";
import { runWithTenantContext } from "./tenant-context.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("prepared allocation barriers (preparation path)", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let service: TenantGroupMovePreparationService;
  let groups: TenantGroupService;
  let clock: number;
  const actorId = "move-admin";
  const input = { kind: "tenant" as const, subjectId: "tenantA", sourceGroupId: "source", destinationGroupId: "target", actorId, idempotencyKey: "request-a" };
  const options = () => ({ enabled: true, maxGrantDurationMs: 1000, waitHorizonMs: 1500, timingPolicyId: "test-timing-v1", monotonicNow: () => clock });
  const admin = <T>(work: () => T) => runWithTenantContext({ role: "admin", tenantId: "tenantA", actorId }, work);
  const prepare = () => admin(() => service.prepare(input));
  const allocation = async () => (await database.pool.query("SELECT id,group_id FROM tenant ORDER BY id")).rows;

  beforeAll(async () => {
    database = await createTestDatabase(url!, "allocation_barrier");
    await database.pool.query("INSERT INTO auth_user (id,name,email,role,tenant_id) VALUES ('move-admin','Admin','move-admin@test.local','admin','tenantA')");
  }, 30000);
  beforeEach(async () => {
    clock = 100;
    service = new TenantGroupMovePreparationService(database.db, options());
    groups = new TenantGroupService(database.db);
    await database.pool.query(`DELETE FROM audit_event; DELETE FROM controller_outbox;
      DELETE FROM tenant_group_move_pool; DELETE FROM tenant_group_move_group; DELETE FROM tenant_group_move;
      DELETE FROM runner_serving_grant; DELETE FROM runner_instance; DELETE FROM runner_control_session; DELETE FROM runner_pool_lease_epoch;
      DELETE FROM runner_pool; UPDATE tenant SET group_id='default'; DELETE FROM tenant_group WHERE id <> 'default';
      INSERT INTO tenant_group (id,name) VALUES ('source','Source'),('target','Target'),('other','Other');
      UPDATE tenant SET group_id=CASE WHEN id='tenantC' THEN 'other' ELSE 'source' END;
      INSERT INTO runner_pool (id,name,group_id,runtime_url) VALUES
        ('source-a','Source A','source','http://source-a:8091'),('source-b','Source B','source','http://source-b:8091'),
        ('target-a','Target A','target','http://target:8091'),('other-a','Other A','other','http://other:8091');
      INSERT INTO controller_state (id,desired_generation) VALUES ('singleton',9) ON CONFLICT(id) DO UPDATE SET desired_generation=9;`);
  });
  afterAll(async () => { await database?.drop(); });

  it("is disabled by default and rejects tenant actors without mutating allocation", async () => {
    await expect(admin(() => new TenantGroupMovePreparationService(database.db).prepare(input)))
      .rejects.toMatchObject({ code: "allocation_transition_preparation_disabled" });
    await expect(runWithTenantContext({ role: "user", tenantId: "tenantA" }, () => service.prepare(input)))
      .rejects.toMatchObject({ status: 403 });
    expect((await database.pool.query("SELECT count(*)::int AS n FROM tenant_group_move")).rows[0].n).toBe(0);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM runner_pool_lease_epoch")).rows[0].n).toBe(0);
  });

  it("captures every source group pool, stops grants atomically and leaves membership and epochs unchanged", async () => {
    const before = await allocation();
    const move = await prepare();
    expect(move).toMatchObject({ state: "prepared", requiresExternalFence: true, sourceGroupId: "source", destinationGroupId: "target", waitHorizonMs: 1500 });
    const status = await admin(() => service.get(move.id));
    expect(status.pools.map(pool => pool.poolId)).toEqual(["source-a", "source-b"]);
    expect(status.pools.every(pool => pool.requiresExternalFence && pool.sourceEpoch === 0 && pool.sourceBarrierRevision === 1)).toBe(true);
    expect((await database.pool.query("SELECT pool_id,epoch,draining FROM runner_pool_lease_epoch ORDER BY pool_id")).rows)
      .toEqual([{ pool_id: "source-a", epoch: "0", draining: true }, { pool_id: "source-b", epoch: "0", draining: true }]);
    const ledger = new RunnerLeaseLedger(database.db);
    await expect(ledger.issue({ poolId: "source-b", runnerId: "r", bootId: "b", nonce: "n", epoch: 0, generation: 9, durationMs: 1000, uncertaintyMs: 0 }))
      .rejects.toMatchObject({ code: "runner_lease_epoch_unavailable" });
    expect(await allocation()).toEqual(before);
    expect(Number((await database.pool.query("SELECT desired_generation FROM controller_state WHERE id='singleton'")).rows[0].desired_generation)).toBe(9);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM controller_outbox")).rows[0].n).toBe(0);
  });

  it("prepares only the moved pool and never drains the destination group", async () => {
    const move = await admin(() => service.prepare({ ...input, kind: "pool", subjectId: "source-a" }));
    expect((await admin(() => service.get(move.id))).pools.map(pool => pool.poolId)).toEqual(["source-a"]);
    expect((await database.pool.query("SELECT pool_id FROM runner_pool_lease_epoch WHERE draining ORDER BY pool_id")).rows).toEqual([{ pool_id: "source-a" }]);
    expect((await database.pool.query("SELECT group_id FROM runner_pool WHERE id='source-a'")).rows[0].group_id).toBe("source");
  });

  it("rejects stale expected ownership, protected pools and invalid timing without preparing anything", async () => {
    await expect(admin(() => service.prepare({ ...input, sourceGroupId: "other" })))
      .rejects.toMatchObject({ code: "tenant_group_assignment_conflict" });
    await database.pool.query("INSERT INTO runner_pool(id,name,group_id,is_default) VALUES ('default','Default','source',true)");
    await expect(admin(() => service.prepare({ ...input, kind: "pool", subjectId: "default" })))
      .rejects.toMatchObject({ code: "default_runner_pool_protected" });
    for (const invalid of [{ maxGrantDurationMs: 60_001 }, { waitHorizonMs: 999 }, { timingPolicyId: " " }]) {
      expect(() => new TenantGroupMovePreparationService(database.db, { ...options(), ...invalid })).toThrow();
    }
    expect((await database.pool.query("SELECT count(*)::int AS n FROM tenant_group_move")).rows[0].n).toBe(0);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM runner_pool_lease_epoch")).rows[0].n).toBe(0);
  });

  it("serializes grant issuance with preparation and preserves any grant that won before the barrier", async () => {
    const ledger = new RunnerLeaseLedger(database.db);
    const results = await Promise.allSettled([prepare(), ledger.issue({ poolId: "source-a", runnerId: "old", bootId: "boot", nonce: "race",
      epoch: 0, generation: 9, durationMs: 1000, uncertaintyMs: 0 })]);
    expect(results[0].status).toBe("fulfilled");
    const move = (results[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof service.prepare>>>).value;
    const status = await admin(() => service.get(move.id));
    const grants = (await database.pool.query("SELECT nonce FROM runner_serving_grant")).rows;
    expect(grants).toEqual(results[1].status === "fulfilled" ? [{ nonce: "race" }] : []);
    expect(status.pools.find(pool => pool.poolId === "source-a")?.grantCount).toBe(grants.length);
    await expect(ledger.issue({ poolId: "source-a", runnerId: "old", bootId: "boot", nonce: "late",
      epoch: 0, generation: 9, durationMs: 1000, uncertaintyMs: 0 })).rejects.toMatchObject({ code: "runner_lease_epoch_unavailable" });
  });

  it("serializes independent Controllers and keeps idempotent retries on the same barrier", async () => {
    const other = new TenantGroupMovePreparationService(database.db, options());
    const results = await Promise.allSettled([prepare(), admin(() => other.prepare({ ...input, subjectId: "tenantB", idempotencyKey: "request-b" }))]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const winner = (results.find(result => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof service.prepare>>>).value;
    const winnerInput = winner.subjectId === input.subjectId ? input : { ...input, subjectId: "tenantB", idempotencyKey: "request-b" };
    expect(await admin(() => other.prepare(winnerInput))).toMatchObject({ id: winner.id, barrierId: winner.barrierId });
    await expect(admin(() => other.prepare({ ...winnerInput, destinationGroupId: "other" })))
      .rejects.toMatchObject({ code: "allocation_transition_idempotency_conflict" });
    expect((await database.pool.query("SELECT count(*)::int AS n FROM audit_event WHERE kind='tenant_group.move_prepared'")).rows[0].n).toBe(1);
  });

  it("protects source/destination claims from direct allocation and connectivity mutations but preserves no-ops", async () => {
    await prepare();
    for (const attempt of [
      () => groups.assignTenant("tenantB", { groupId: "other", expectedGroupId: "source" }, actorId),
      () => groups.assignTenant("tenantC", { groupId: "target", expectedGroupId: "other" }, actorId),
      () => groups.assignPool("source-b", { groupId: "other", expectedGroupId: "source" }, actorId),
      () => groups.createPool("source", { id: "new-source", name: "New", runtimeUrl: "http://new:8091" }, actorId),
      () => groups.createPool("target", { id: "new-target", name: "New", runtimeUrl: "http://new:8091" }, actorId),
      () => groups.updateConnectivity("target-a", { runtimeUrl: "http://changed:8091", publicUrl: null }, actorId),
      () => groups.remove("target", actorId),
    ]) await expect(admin(attempt)).rejects.toMatchObject({ code: "allocation_transition_in_progress" });
    await expect(admin(() => groups.assignTenant("tenantA", { groupId: "source", expectedGroupId: "source" }, actorId)))
      .resolves.toMatchObject({ groupId: "source", generation: 9 });
    await expect(admin(() => groups.assignPool("source-b", { groupId: "source", expectedGroupId: "source" }, actorId)))
      .resolves.toMatchObject({ groupId: "source", generation: 9 });
    await expect(admin(() => groups.createPool("other", { id: "new-other", name: "New", runtimeUrl: "http://new:8091" }, actorId)))
      .resolves.toMatchObject({ id: "new-other" });
  });

  it("requires a fresh monotonic full horizon and cannot use wall-clock timestamps as elapsed proof", async () => {
    const move = await prepare();
    const handle = await admin(() => service.beginWait(move.id));
    await database.pool.query("UPDATE tenant_group_move SET wait_started_at=now()-interval '10 years' WHERE id=$1", [move.id]);
    clock += 1499;
    await expect(admin(() => service.observeElapsed(handle))).rejects.toMatchObject({ code: "allocation_transition_wait_incomplete" });
    clock += 1;
    const observed = await admin(() => service.observeElapsed(handle));
    expect(observed).toMatchObject({ state: "prepared", waitElapsedMs: 1500, requiresExternalFence: true });
    expect(observed.waitObservedAt).toBeInstanceOf(Date);
    await expect(admin(() => service.observeElapsed(handle))).rejects.toMatchObject({ code: "allocation_transition_wait_unavailable" });
    expect((await database.pool.query("SELECT group_id FROM tenant WHERE id='tenantA'")).rows[0].group_id).toBe("source");
    await expect(database.pool.query("UPDATE tenant_group_move SET requires_external_fence=false WHERE id=$1", [move.id])).rejects.toMatchObject({ code: "23514" });
  });

  it("restarts the full horizon on process takeover and invalidates old or serialized handles", async () => {
    const move = await prepare();
    const oldHandle = await admin(() => service.beginWait(move.id));
    clock += 1500;
    const replacement = new TenantGroupMovePreparationService(database.db, options());
    await expect(admin(() => replacement.observeElapsed(oldHandle))).rejects.toMatchObject({ code: "allocation_transition_wait_unavailable" });
    const newHandle = await admin(() => replacement.beginWait(move.id));
    await expect(admin(() => service.observeElapsed(oldHandle))).rejects.toMatchObject({ code: "allocation_transition_wait_unavailable" });
    await expect(admin(() => replacement.observeElapsed(JSON.parse(JSON.stringify(newHandle))))).rejects.toMatchObject({ code: "allocation_transition_wait_unavailable" });
    await expect(admin(() => replacement.observeElapsed(newHandle))).rejects.toMatchObject({ code: "allocation_transition_wait_incomplete" });
    clock += 1500;
    expect(await admin(() => replacement.observeElapsed(newHandle))).toMatchObject({ waitElapsedMs: 1500, requiresExternalFence: true });
  });

  it("invalidates observations after clock uncertainty, drain reset or source-set changes", async () => {
    const move = await prepare();
    let handle = await admin(() => service.beginWait(move.id));
    clock = Number.NaN;
    await expect(admin(() => service.observeElapsed(handle))).rejects.toMatchObject({ code: "allocation_transition_wait_unavailable" });
    clock = 10_000;
    await expect(admin(() => service.observeElapsed(handle))).rejects.toMatchObject({ code: "allocation_transition_wait_unavailable" });
    handle = await admin(() => service.beginWait(move.id));
    clock += 1500;
    await database.pool.query("UPDATE runner_pool_lease_epoch SET draining=false WHERE pool_id='source-a'");
    await expect(admin(() => service.observeElapsed(handle))).rejects.toMatchObject({ code: "allocation_transition_barrier_changed" });
    await database.pool.query("UPDATE runner_pool_lease_epoch SET draining=true WHERE pool_id='source-a'");
    await expect(admin(() => service.observeElapsed(handle))).rejects.toMatchObject({ code: "allocation_transition_wait_unavailable" });
    await database.pool.query("INSERT INTO runner_pool(id,name,group_id) VALUES ('unexpected','Unexpected','source')");
    await expect(admin(() => service.beginWait(move.id))).rejects.toMatchObject({ code: "allocation_transition_barrier_changed" });
  });

  it("does not use an old wait after a backward clock or unexpected post-barrier grant", async () => {
    const move = await prepare();
    let handle = await admin(() => service.beginWait(move.id));
    clock -= 1;
    await expect(admin(() => service.observeElapsed(handle))).rejects.toMatchObject({ code: "allocation_transition_wait_unavailable" });
    clock = 10_000;
    await expect(admin(() => service.observeElapsed(handle))).rejects.toMatchObject({ code: "allocation_transition_wait_unavailable" });
    handle = await admin(() => service.beginWait(move.id));
    clock += 1500;
    // Model an old writer that ignores draining. Even an expired DB deadline
    // cannot allow an elapsed observation to silently accept that new authority.
    await database.pool.query(`INSERT INTO runner_serving_grant(pool_id,runner_id,boot_id,nonce,epoch,generation,duration_ms,uncertainty_ms,issued_at,conservative_expires_at)
      VALUES ('source-a','legacy','boot','unexpected',0,9,1000,0,now()-interval '1 day',now()-interval '1 day');`);
    await expect(admin(() => service.observeElapsed(handle))).rejects.toMatchObject({ code: "allocation_transition_barrier_changed" });
    expect((await admin(() => service.get(move.id))).waitObservedAt).toBeNull();
    expect((await database.pool.query("SELECT count(*)::int AS n FROM runner_serving_grant")).rows[0].n).toBe(1);
  });

  it("detects a drain reset and restoration between observations using the durable revision", async () => {
    const move = await prepare();
    const handle = await admin(() => service.beginWait(move.id));
    // A redundant beginDrain does not change authority or invalidate a barrier.
    expect(await new RunnerLeaseLedger(database.db).beginDrain("source-a", 0)).toMatchObject({ barrierRevision: 1 });
    await database.pool.query("UPDATE runner_pool_lease_epoch SET draining=false WHERE pool_id='source-a'");
    await database.pool.query("UPDATE runner_pool_lease_epoch SET draining=true WHERE pool_id='source-a'");
    expect((await database.pool.query("SELECT barrier_revision FROM runner_pool_lease_epoch WHERE pool_id='source-a'")).rows[0].barrier_revision).toBe("3");
    await expect(database.pool.query("UPDATE runner_pool_lease_epoch SET barrier_revision=1 WHERE pool_id='source-a'"))
      .rejects.toMatchObject({ code: "55000" });
    await expect(database.pool.query("DELETE FROM runner_pool_lease_epoch WHERE pool_id='source-a'"))
      .rejects.toMatchObject({ code: "55000" });
    clock += 1500;
    await expect(admin(() => service.observeElapsed(handle))).rejects.toMatchObject({ code: "allocation_transition_barrier_changed" });
    await expect(admin(() => service.beginWait(move.id))).rejects.toMatchObject({ code: "allocation_transition_barrier_changed" });
    expect((await admin(() => service.get(move.id))).waitObservedAt).toBeNull();
  });

  it.each([
    ["challenge identity", "nonce='replacement'"],
    ["uncertainty bound", "uncertainty_ms=1"],
    ["sub-millisecond issue time", "issued_at=issued_at+interval '1 microsecond'"],
  ])("detects equal-count, equal-duration grant tampering of %s", async (_name, update) => {
    await new RunnerLeaseLedger(database.db).issue({ poolId: "source-a", runnerId: "old", bootId: "boot", nonce: "captured",
      epoch: 0, generation: 9, durationMs: 1000, uncertaintyMs: 0 });
    const move = await prepare();
    const status = await admin(() => service.get(move.id));
    expect(status.pools.find(pool => pool.poolId === "source-a")).toMatchObject({ grantCount: 1, longestGrantMs: 1000, grantDigest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const handle = await admin(() => service.beginWait(move.id));
    await database.pool.query(`UPDATE runner_serving_grant SET ${update} WHERE pool_id='source-a'`);
    expect((await database.pool.query("SELECT count(*)::int AS count,max(duration_ms) AS maximum FROM runner_serving_grant WHERE pool_id='source-a'")).rows[0])
      .toEqual({ count: 1, maximum: 1000 });
    clock += 1500;
    await expect(admin(() => service.observeElapsed(handle))).rejects.toMatchObject({ code: "allocation_transition_barrier_changed" });
    expect((await admin(() => service.get(move.id))).waitObservedAt).toBeNull();
  });

  it("rejects unbounded grant history and rolls back all drain/claim changes", async () => {
    await database.pool.query(`INSERT INTO runner_pool_lease_epoch(pool_id) VALUES ('source-b');
      INSERT INTO runner_serving_grant(pool_id,runner_id,boot_id,nonce,epoch,generation,duration_ms,uncertainty_ms,issued_at,conservative_expires_at)
      VALUES ('source-b','old','boot','old',0,9,1001,0,now()-interval '1 year',now()-interval '1 year');`);
    await expect(prepare()).rejects.toMatchObject({ code: "allocation_transition_unbounded_history" });
    expect((await database.pool.query("SELECT count(*)::int AS n FROM tenant_group_move")).rows[0].n).toBe(0);
    expect((await database.pool.query("SELECT pool_id,draining FROM runner_pool_lease_epoch")).rows).toEqual([{ pool_id: "source-b", draining: false }]);
  });

  it("preserves barrier and incomplete wait evidence on migration replay and refuses policy changes", async () => {
    const move = await prepare();
    const handle = await admin(() => service.beginWait(move.id));
    clock += 1500;
    await admin(() => service.observeElapsed(handle));
    await database.pool.query(readFileSync(new URL("../db/migrations/0011_prepared_allocation_transitions.sql", import.meta.url), "utf8"));
    expect(await admin(() => service.get(move.id))).toMatchObject({ barrierId: move.barrierId, state: "prepared", waitElapsedMs: 1500, requiresExternalFence: true });
    const changed = new TenantGroupMovePreparationService(database.db, { ...options(), timingPolicyId: "changed-policy" });
    await expect(admin(() => changed.beginWait(move.id))).rejects.toMatchObject({ code: "allocation_transition_timing_conflict" });
    expect((await database.pool.query("SELECT bool_and(draining) AS all_draining FROM runner_pool_lease_epoch")).rows[0].all_draining).toBe(true);
  });
});
