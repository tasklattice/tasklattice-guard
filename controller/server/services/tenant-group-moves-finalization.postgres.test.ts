// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { TenantGroupMoveService, type AllocationFenceRequest, type PermanentAllocationFence } from "./tenant-group-moves.js";
import { RunnerLeaseLedger } from "./runner-lease-ledger.js";
import { TenantGroupService } from "./tenant-groups.js";
import { runWithTenantContext } from "./tenant-context.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("permanently fenced allocation completion (test-only infrastructure verifier)", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let service: TenantGroupMoveService;
  let clock: number;
  let calls: AllocationFenceRequest[];
  let verify: (request: AllocationFenceRequest) => Promise<PermanentAllocationFence | null>;
  const actorId = "completion-admin";
  const input = { kind: "tenant" as const, subjectId: "tenantA", sourceGroupId: "source", destinationGroupId: "target", actorId, idempotencyKey: "completion-a" };
  const admin = <T>(work: () => T) => runWithTenantContext({ role: "admin", tenantId: "tenantA", actorId }, work);
  const options = () => ({ enabled: true, maxGrantDurationMs: 1000, waitHorizonMs: 1500, timingPolicyId: "test-only-timing", monotonicNow: () => clock });
  // Explicit test double: this does not prove Kubernetes/network fencing and
  // must never be installed in Controller startup or exposed as HTTP evidence.
  const testOnlyFence = (request: AllocationFenceRequest): PermanentAllocationFence => ({ verified: true,
    capabilityKind: "permanent_external_fence", verifierId: "test-only-fencer", evidenceId: `test-${request.bindingDigest}`,
    moveId: request.moveId, barrierId: request.barrierId, bindingDigest: request.bindingDigest,
    sourcePoolIds: request.sourcePools.map(pool => pool.poolId) });
  const makeService = () => new TenantGroupMoveService(database.db, { ...options(), externalFenceVerifier: {
    verifyPermanentFence: async request => { calls.push(request); return verify(request); },
  } });
  const ready = async (target = service, moveInput: Parameters<TenantGroupMoveService["prepare"]>[0] = input) => {
    const move = await admin(() => target.prepare(moveInput));
    const handle = await admin(() => target.beginWait(move.id));
    clock += 1500;
    await admin(() => target.observeElapsed(handle));
    return { move, handle };
  };
  const state = async () => ({
    tenants: (await database.pool.query("SELECT id,group_id FROM tenant ORDER BY id")).rows,
    pools: (await database.pool.query("SELECT id,group_id FROM runner_pool ORDER BY id")).rows,
    epochs: (await database.pool.query("SELECT pool_id,epoch,draining,barrier_revision FROM runner_pool_lease_epoch ORDER BY pool_id")).rows,
    contexts: (await database.pool.query("SELECT id,retired_at FROM endpoint_telemetry_context ORDER BY id")).rows,
    generation: Number((await database.pool.query("SELECT desired_generation FROM controller_state WHERE id='singleton'")).rows[0].desired_generation),
    outbox: Number((await database.pool.query("SELECT count(*) AS n FROM controller_outbox")).rows[0].n),
    completedAudits: Number((await database.pool.query("SELECT count(*) AS n FROM audit_event WHERE kind='tenant_group.move_completed'")).rows[0].n),
  });

  beforeAll(async () => {
    database = await createTestDatabase(url!, "allocation_completion");
    await database.pool.query("INSERT INTO auth_user (id,name,email,role,tenant_id) VALUES ('completion-admin','Admin','completion-admin@test.local','admin','tenantA')");
  }, 30000);
  beforeEach(async () => {
    clock = 100; calls = []; verify = async request => testOnlyFence(request); service = makeService();
    // Only this disposable schema is reset. Production retirement/deletion
    // protection must remain active during each finalization test itself.
    await database.pool.query(`DELETE FROM audit_event; DELETE FROM controller_outbox; TRUNCATE endpoint_telemetry_context;
      DELETE FROM tenant_group_move_pool; DELETE FROM tenant_group_move_group; DELETE FROM tenant_group_move;
      DELETE FROM runner_serving_grant; DELETE FROM runner_instance; DELETE FROM runner_control_session; DELETE FROM runner_pool_lease_epoch;
      DELETE FROM runner_pool; UPDATE tenant SET group_id='default'; DELETE FROM tenant_group WHERE id <> 'default';
      INSERT INTO tenant_group(id,name) VALUES ('source','Source'),('target','Target'),('other','Other');
      UPDATE tenant SET group_id=CASE WHEN id='tenantC' THEN 'other' ELSE 'source' END;
      INSERT INTO runner_pool(id,name,group_id,runtime_url) VALUES ('source-a','A','source','http://a:8091'),
        ('source-b','B','source','http://b:8091'),('target-a','Target','target','http://target:8091'),('other-a','Other','other','http://other:8091');
      INSERT INTO runner_pool_lease_epoch(pool_id) SELECT id FROM runner_pool;
      INSERT INTO endpoint_telemetry_context(id,snapshot_key,tenant_id,group_id,pool_id,allocation_epoch,generation,endpoint_id,adapter,verification_digest,endpoint_snapshot_digest)
        SELECT id,id,'tenantA',group_id,id,0,9,'endpoint-'||id,'guard','verification','snapshot' FROM runner_pool;
      INSERT INTO controller_state(id,desired_generation) VALUES ('singleton',9) ON CONFLICT(id) DO UPDATE SET desired_generation=9;`);
  });
  afterAll(async () => { await database?.drop(); });

  it("keeps completion disabled by default and rejects tenant authority", async () => {
    await expect(admin(() => new TenantGroupMoveService(database.db).finalize("unknown", undefined, actorId)))
      .rejects.toMatchObject({ code: "allocation_transition_preparation_disabled" });
    await expect(runWithTenantContext({ role: "user", tenantId: "tenantA" }, () => service.finalize("unknown", undefined, actorId)))
      .rejects.toMatchObject({ status: 403 });
    expect(calls).toHaveLength(0);
  });

  it("does not use elapsed observation without an injected authoritative verifier", async () => {
    const target = new TenantGroupMoveService(database.db, options());
    const { move, handle } = await ready(target);
    const before = await state();
    await expect(admin(() => target.finalize(move.id, handle, actorId))).rejects.toMatchObject({ code: "allocation_transition_fencer_unavailable" });
    expect(await state()).toEqual(before);
  });

  it.each(["missing", "serialized", "unobserved", "restarted"])("rejects %s process-local full-horizon evidence", async kind => {
    const move = await admin(() => service.prepare(input));
    const handle = await admin(() => service.beginWait(move.id));
    clock += 1500;
    if (kind !== "unobserved") await admin(() => service.observeElapsed(handle));
    const target = kind === "restarted" ? makeService() : service;
    const supplied = kind === "missing" ? undefined : kind === "serialized" ? JSON.parse(JSON.stringify(handle)) : handle;
    const before = await state();
    await expect(admin(() => target.finalize(move.id, supplied, actorId))).rejects.toMatchObject({ code: "allocation_transition_wait_unavailable" });
    expect(await state()).toEqual(before); expect(calls).toHaveLength(0);
  });

  it.each(["missing", "false", "momentary", "move", "barrier", "digest", "pool", "verifier"])("rejects %s external-fence evidence", async kind => {
    verify = async request => {
      if (kind === "missing") return null;
      const evidence = testOnlyFence(request);
      return { ...evidence, ...(kind === "false" ? { verified: false } : kind === "momentary" ? { capabilityKind: "observed_offline" } :
        kind === "move" ? { moveId: "another-move" } : kind === "barrier" ? { barrierId: "another-barrier" } :
        kind === "digest" ? { bindingDigest: "0".repeat(64) } : kind === "pool" ? { sourcePoolIds: ["source-a"] } : { verifierId: " " }) } as PermanentAllocationFence;
    };
    const { move, handle } = await ready(); const before = await state();
    await expect(admin(() => service.finalize(move.id, handle, actorId))).rejects.toMatchObject({ code: "allocation_transition_fence_unverified" });
    expect(await state()).toEqual(before);
    expect((await admin(() => service.get(move.id))).state).toBe("prepared");
  });

  it("atomically moves a Tenant, fences every shared source pool, retires contexts and retains grant history", async () => {
    await new RunnerLeaseLedger(database.db).issue({ poolId: "source-a", runnerId: "old", bootId: "boot", nonce: "old-grant", epoch: 0,
      generation: 9, durationMs: 1000, uncertaintyMs: 0 });
    await database.pool.query("INSERT INTO runner_control_session(id,runner_id,boot_id,pool_id,snapshot_accepted,snapshot_acknowledged_at) VALUES ('old-session','old','boot','source-a',true,now())");
    const { move, handle } = await ready();
    const completed = await admin(() => service.finalize(move.id, handle, actorId));
    expect(completed).toMatchObject({ state: "completed", completedGeneration: 10, completedActorId: actorId,
      requiresExternalFence: true, fenceVerifierId: "test-only-fencer", fenceBindingDigest: calls[0]!.bindingDigest });
    expect(completed.completedAt).toBeInstanceOf(Date);
    const after = await state();
    expect(after.tenants).toContainEqual({ id: "tenantA", group_id: "target" });
    expect(after.tenants).toContainEqual({ id: "tenantB", group_id: "source" });
    expect(after.epochs.filter(row => row.pool_id.startsWith("source"))).toEqual([
      { pool_id: "source-a", epoch: "1", draining: false, barrier_revision: "2" },
      { pool_id: "source-b", epoch: "1", draining: false, barrier_revision: "2" },
    ]);
    expect(after.epochs.find(row => row.pool_id === "target-a")).toMatchObject({ epoch: "0", draining: false, barrier_revision: "0" });
    expect(after.contexts.filter(row => row.id.startsWith("source")).every(row => row.retired_at instanceof Date)).toBe(true);
    expect(after.contexts.find(row => row.id === "other-a")!.retired_at).toBeNull();
    expect(after.contexts.find(row => row.id === "target-a")!.retired_at).toBeNull();
    expect(after).toMatchObject({ generation: 10, outbox: 1, completedAudits: 1 });
    expect((await database.pool.query("SELECT snapshot_accepted,snapshot_acknowledged_at FROM runner_control_session WHERE id='old-session'")).rows[0])
      .toEqual({ snapshot_accepted: false, snapshot_acknowledged_at: null });
    expect((await database.pool.query("SELECT nonce FROM runner_serving_grant")).rows).toEqual([{ nonce: "old-grant" }]);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM tenant_group_move_group")).rows[0].n).toBe(0);
    expect((await admin(() => service.get(move.id))).pools.every(pool => pool.releasedAt instanceof Date)).toBe(true);
    expect(calls[0]!.sourcePools.map(pool => pool.poolId)).toEqual(["source-a", "source-b"]);
    expect(Object.isFrozen(calls[0])).toBe(true); expect(Object.isFrozen(calls[0]!.sourcePools[0])).toBe(true);
    await expect(new RunnerLeaseLedger(database.db).issue({ poolId: "source-a", runnerId: "old", bootId: "boot", nonce: "stale", epoch: 0,
      generation: 9, durationMs: 1000, uncertaintyMs: 0 })).rejects.toMatchObject({ code: "runner_lease_epoch_unavailable" });
  });

  it("moves only the selected pool and supports a second move without losing capture history", async () => {
    const poolInput = { ...input, kind: "pool" as const, subjectId: "source-a" };
    const first = await ready(service, poolInput);
    await admin(() => service.finalize(first.move.id, first.handle, actorId));
    const afterFirst = await state();
    expect(afterFirst.pools.find(row => row.id === "source-a")!.group_id).toBe("target");
    expect(afterFirst.epochs.find(row => row.pool_id === "source-b")).toMatchObject({ epoch: "0", barrier_revision: "0" });
    expect(afterFirst.contexts.find(row => row.id === "source-b")!.retired_at).toBeNull();
    const second = await ready(service, { ...poolInput, sourceGroupId: "target", destinationGroupId: "other", idempotencyKey: "second-pool-move" });
    await admin(() => service.finalize(second.move.id, second.handle, actorId));
    expect((await state()).pools.find(row => row.id === "source-a")!.group_id).toBe("other");
    expect((await database.pool.query("SELECT move_id,released_at FROM tenant_group_move_pool WHERE pool_id='source-a' ORDER BY move_id")).rows)
      .toHaveLength(2);
    expect((await admin(() => service.get(first.move.id))).pools[0]!.sourceEpoch).toBe(0);
    expect((await admin(() => service.get(second.move.id))).pools[0]!.sourceEpoch).toBe(1);
  });

  it("returns committed results after restart without a new fence, wait or mutation", async () => {
    const { move, handle } = await ready();
    const completed = await admin(() => service.finalize(move.id, handle, actorId));
    const before = await state(); const count = calls.length;
    const restarted = new TenantGroupMoveService(database.db, options());
    expect(await admin(() => restarted.finalize(move.id, undefined, actorId))).toEqual(completed);
    expect(await state()).toEqual(before); expect(calls).toHaveLength(count);
    await database.pool.query(readFileSync(new URL("../db/migrations/0060_fenced_allocation_completion.sql", import.meta.url), "utf8"));
    expect(await admin(() => restarted.finalize(move.id, undefined, actorId))).toEqual(completed);
  });

  it("requires another full horizon after process restart even with persisted successful observation", async () => {
    const old = await ready(); const restarted = makeService();
    await expect(admin(() => restarted.finalize(old.move.id, old.handle, actorId))).rejects.toMatchObject({ code: "allocation_transition_wait_unavailable" });
    const handle = await admin(() => restarted.beginWait(old.move.id));
    await expect(admin(() => restarted.observeElapsed(handle))).rejects.toMatchObject({ code: "allocation_transition_wait_incomplete" });
    clock += 1500; await admin(() => restarted.observeElapsed(handle));
    expect(await admin(() => restarted.finalize(old.move.id, handle, actorId))).toMatchObject({ state: "completed" });
  });

  it("rejects wait takeover while the verifier is outside the database lock", async () => {
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    verify = async request => { entered(); await gate; return testOnlyFence(request); };
    const { move, handle } = await ready();
    const pending = admin(() => service.finalize(move.id, handle, actorId));
    await started;
    const restarted = makeService(); await admin(() => restarted.beginWait(move.id));
    const before = await state(); release();
    await expect(pending).rejects.toMatchObject({ code: "allocation_transition_wait_unavailable" });
    expect(await state()).toEqual(before);
  });

  it("retains the drain and requires a fresh full wait after verifier uncertainty", async () => {
    verify = async () => { throw new Error("test-only infrastructure verifier unavailable"); };
    const { move, handle } = await ready(); const before = await state();
    await expect(admin(() => service.finalize(move.id, handle, actorId))).rejects.toThrow("test-only infrastructure verifier unavailable");
    expect(await state()).toEqual(before);
    verify = async request => testOnlyFence(request);
    await expect(admin(() => service.finalize(move.id, handle, actorId))).rejects.toMatchObject({ code: "allocation_transition_wait_unavailable" });
    const fresh = await admin(() => service.beginWait(move.id));
    await expect(admin(() => service.observeElapsed(fresh))).rejects.toMatchObject({ code: "allocation_transition_wait_incomplete" });
    clock += 1500; await admin(() => service.observeElapsed(fresh));
    expect(await admin(() => service.finalize(move.id, fresh, actorId))).toMatchObject({ state: "completed" });
  });

  it.each(["topology", "drain", "grant", "clock"])("rejects %s changes during permanent-fence verification", async kind => {
    if (kind === "grant") await new RunnerLeaseLedger(database.db).issue({ poolId: "source-a", runnerId: "old", bootId: "boot", nonce: "captured",
      epoch: 0, generation: 9, durationMs: 1000, uncertaintyMs: 0 });
    verify = async request => {
      if (kind === "topology") await database.pool.query("INSERT INTO runner_pool(id,name,group_id) VALUES ('unexpected','Unexpected','source')");
      if (kind === "drain") await database.pool.query("UPDATE runner_pool_lease_epoch SET draining=false WHERE pool_id='source-a'; UPDATE runner_pool_lease_epoch SET draining=true WHERE pool_id='source-a'");
      if (kind === "grant") await database.pool.query("UPDATE runner_serving_grant SET nonce='replacement' WHERE pool_id='source-a'");
      if (kind === "clock") clock = 99;
      return testOnlyFence(request);
    };
    const { move, handle } = await ready();
    await expect(admin(() => service.finalize(move.id, handle, actorId)))
      .rejects.toMatchObject({ code: kind === "clock" ? "allocation_transition_wait_unavailable" : "allocation_transition_barrier_changed" });
    expect((await admin(() => service.get(move.id))).state).toBe("prepared");
    expect((await state())).toMatchObject({ generation: 9, outbox: 0, completedAudits: 0 });
    expect((await state()).tenants).toContainEqual({ id: "tenantA", group_id: "source" });
  });

  it("rolls back membership, epochs, context retirement and claim release if outbox persistence fails", async () => {
    const { move, handle } = await ready(); const before = await state();
    await database.pool.query(`CREATE FUNCTION fail_allocation_outbox() RETURNS trigger AS $$ BEGIN
      IF NEW.payload->>'resourceType'='allocation_move' THEN RAISE EXCEPTION 'injected outbox failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_allocation_outbox BEFORE INSERT ON controller_outbox FOR EACH ROW EXECUTE FUNCTION fail_allocation_outbox();`);
    try {
      await expect(admin(() => service.finalize(move.id, handle, actorId))).rejects.toMatchObject({ cause: { message: "injected outbox failure" } });
      expect(await state()).toEqual(before);
      expect((await admin(() => service.get(move.id))).state).toBe("prepared");
      expect((await admin(() => service.get(move.id))).pools.every(pool => pool.releasedAt === null)).toBe(true);
      await expect(admin(() => service.finalize(move.id, handle, actorId))).rejects.toMatchObject({ code: "allocation_transition_wait_unavailable" });
    } finally { await database.pool.query("DROP TRIGGER fail_allocation_outbox ON controller_outbox; DROP FUNCTION fail_allocation_outbox()"); }
  });

  it("commits one generation, outbox and audit for concurrent finalization retries", async () => {
    const { move, handle } = await ready();
    const results = await Promise.all([admin(() => service.finalize(move.id, handle, actorId)), admin(() => service.finalize(move.id, handle, actorId))]);
    expect(results[0]).toEqual(results[1]);
    expect(await state()).toMatchObject({ generation: 10, outbox: 1, completedAudits: 1 });
  });

  it("cannot fabricate completion without required fence and live-wait metadata at the database boundary", async () => {
    const move = await admin(() => service.prepare(input));
    await expect(database.pool.query("UPDATE tenant_group_move SET state='completed',completed_at=now(),completed_actor_id=$2 WHERE id=$1", [move.id, actorId]))
      .rejects.toMatchObject({ code: "23514" });
    expect((await admin(() => service.get(move.id))).state).toBe("prepared");
  });

  it.each([Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER])("rejects preparation without both revision increments at %s", async revision => {
    // Fixture-only counter placement; production cannot bypass the trigger.
    await database.pool.query("ALTER TABLE runner_pool_lease_epoch DISABLE TRIGGER runner_pool_barrier_revision");
    try { await database.pool.query("UPDATE runner_pool_lease_epoch SET barrier_revision=$1 WHERE pool_id='source-a'", [revision]); }
    finally { await database.pool.query("ALTER TABLE runner_pool_lease_epoch ENABLE TRIGGER runner_pool_barrier_revision"); }
    const before = await state();
    await expect(admin(() => service.prepare(input))).rejects.toMatchObject({ code: "allocation_transition_pool_unavailable" });
    expect(await state()).toEqual(before);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM tenant_group_move")).rows[0].n).toBe(0);
  });

  it("can prepare and complete using the final two safe barrier revisions", async () => {
    await database.pool.query("ALTER TABLE runner_pool_lease_epoch DISABLE TRIGGER runner_pool_barrier_revision");
    try { await database.pool.query("UPDATE runner_pool_lease_epoch SET barrier_revision=$1 WHERE pool_id='source-a'", [Number.MAX_SAFE_INTEGER - 2]); }
    finally { await database.pool.query("ALTER TABLE runner_pool_lease_epoch ENABLE TRIGGER runner_pool_barrier_revision"); }
    const { move, handle } = await ready();
    expect((await admin(() => service.get(move.id))).pools.find(pool => pool.poolId === "source-a")!.sourceBarrierRevision)
      .toBe(Number.MAX_SAFE_INTEGER - 1);
    expect(await admin(() => service.finalize(move.id, handle, actorId))).toMatchObject({ state: "completed" });
    expect((await state()).epochs.find(row => row.pool_id === "source-a")!.barrier_revision).toBe(String(Number.MAX_SAFE_INTEGER));
  });

  it.each(["source", "target"])("reports retained history when the completed %s group later becomes empty", async groupId => {
    const { move, handle } = await ready();
    await admin(() => service.finalize(move.id, handle, actorId));
    const groups = new TenantGroupService(database.db);
    await admin(() => groups.assignTenant("tenantA", { groupId: "other", expectedGroupId: "target" }, actorId));
    await admin(() => groups.assignTenant("tenantB", { groupId: "other", expectedGroupId: "source" }, actorId));
    for (const [poolId, previous] of [["source-a", "source"], ["source-b", "source"], ["target-a", "target"]]) {
      await admin(() => groups.assignPool(poolId!, { groupId: "other", expectedGroupId: previous! }, actorId));
    }
    const before = await state();
    await expect(admin(() => groups.remove(groupId, actorId))).rejects.toMatchObject({ status: 409, code: "tenant_group_history_retained" });
    expect(await state()).toEqual(before);
    expect((await database.pool.query("SELECT id FROM tenant_group WHERE id=$1", [groupId])).rows).toEqual([{ id: groupId }]);
    expect((await admin(() => service.get(move.id))).state).toBe("completed");
  });
});
