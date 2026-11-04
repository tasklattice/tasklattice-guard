// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { advisoryTransactionLock } from "../db/postgres-locks.js";
import * as schema from "../db/schema.js";
import type { ControllerDatabase } from "../db/client.js";
import type { EndpointContextStorageLimits } from "../endpoint-context-storage-policy.js";
import { endpointContextCleanupBatchSize, issueEndpointTelemetryContexts, lockEndpointTelemetryContextReaders,
  pruneEndpointTelemetryContexts, retireEndpointTelemetryContexts } from "./endpoint-telemetry-contexts.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
type Projection = Parameters<typeof issueEndpointTelemetryContexts>[1];
type Transaction = Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0];
const endpoint = (id = "endpoint-a") => ({ endpointId: id, projectId: "projectA", adapter: "litellm-generic-guardrail",
  trafficRouterId: "router-a", verification: { credentials: [{ digest: "trusted-credential-digest" }] }, scanFlagOnlyDefault: true });
const router = () => ({ routerId: "router-a", revision: 3, routes: [{ id: "route-a", enabled: true,
  targets: [{ id: "target-a", guardrailId: "guardrail-a", guardrailVersion: "version-a", weightBps: 10000 }] }] });
const projection = (overrides: Partial<Projection> = {}): Projection => ({ poolId: "pool-a", groupId: "group-a", epoch: 2,
  generation: 7, endpoints: [endpoint()], routers: [router()], ...overrides });
const limits = (overrides: Partial<EndpointContextStorageLimits> = {}): EndpointContextStorageLimits => ({
  maxRowsPerPool: 16, maxRowsGlobal: 64, maxPayloadBytesPerContext: 4096,
  maxPayloadBytesPerPool: 65536, maxPayloadBytesGlobal: 262144, ...overrides });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

describe.skipIf(!url)("bounded immutable Endpoint provenance storage", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let second: ControllerDatabase;
  beforeAll(async () => {
    database = await createTestDatabase(url!, "endpoint_context_storage");
    second = drizzle(database.pool, { schema });
    await database.pool.query("INSERT INTO controller_state(id,desired_generation) VALUES ('singleton',7) ON CONFLICT(id) DO NOTHING");
  }, 30000);
  beforeEach(async () => {
    // This isolated test schema intentionally resets immutable history with
    // TRUNCATE; production cleanup is exercised only through the public helper.
    await database.pool.query("TRUNCATE runtime_event,model_usage_cost,route_assignment,endpoint_telemetry_context,endpoint_telemetry_context_gc_cursor");
  });
  afterAll(async () => { await database?.drop(); });

  const issue = (input = projection(), policy = limits(), db = database.db) => db.transaction(async tx => {
    await advisoryTransactionLock(tx, "traffic-router-bindings");
    await tx.execute(sql`select desired_generation from controller_state where id='singleton' for share`);
    return issueEndpointTelemetryContexts(tx, input, policy);
  });
  const rows = async () => (await database.pool.query("SELECT * FROM endpoint_telemetry_context ORDER BY id")).rows;
  const cleanup = () => database.db.transaction(tx => pruneEndpointTelemetryContexts(tx));
  const seedRetired = async (id: string, age = "40 days", pool = "seed-pool") => {
    await database.pool.query(`INSERT INTO endpoint_telemetry_context(id,snapshot_key,project_id,group_id,pool_id,allocation_epoch,generation,
      endpoint_id,adapter,verification_digest,endpoint_snapshot_digest,issued_at,retired_at)
      VALUES ($1,$1,'projectA','seed-group',$3,1,1,$1,'litellm-generic-guardrail','verification','snapshot',
        clock_timestamp()-interval '50 days',clock_timestamp()-$2::interval)`, [id, age, pool]);
  };
  const insertRuntimeReference = (tx: Transaction, contextId: string, id: string) => tx.execute(sql`
    insert into runtime_event(id,occurred_at,request_id,runner_id,direction,decision,duration_ms,metadata,allocation_context_id)
    values (${id},clock_timestamp(),${id},'synthetic-runner','incoming','allow',1,'{}',${contextId})`);
  const blocked = async (pid: number) => {
    await expect.poll(async () => (await database.pool.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted) AS blocked", [pid])).rows[0].blocked,
      { timeout: 3000, interval: 10 }).toBe(true);
  };

  it("reuses unchanged active authority across unrelated generations and retains original issuance generation", async () => {
    const original = (await issue()).get("endpoint-a")!;
    expect((await issue(projection({ generation: 9000 }), limits(), second)).get("endpoint-a")).toBe(original);
    const stored = await rows();
    expect(stored).toHaveLength(1); expect(Number(stored[0].generation)).toBe(7); expect(stored[0].retired_at).toBeNull();
    expect(Buffer.from(original, "base64url")).toHaveLength(32);
    expect(original).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it.each(["verification", "router revision", "router target", "epoch", "project", "group", "adapter"])("issues fresh authority for a changed %s", async kind => {
    const old = (await issue()).get("endpoint-a")!;
    const next = projection();
    if (kind === "verification") next.endpoints[0]!.verification = { credentials: [{ digest: "rotated-credential-digest" }] };
    if (kind === "router revision") next.routers[0]!.revision += 1;
    if (kind === "router target") next.routers[0]!.routes[0]!.targets[0]!.guardrailVersion = "version-b";
    if (kind === "epoch") next.epoch += 1;
    if (kind === "project") next.endpoints[0]!.projectId = "projectC";
    if (kind === "group") next.groupId = "group-b";
    if (kind === "adapter") next.endpoints[0]!.adapter = "f5-scan";
    const replacement = (await issue(next)).get("endpoint-a")!;
    expect(replacement).not.toBe(old);
    const stored = await rows(); expect(stored).toHaveLength(2);
    expect(stored.find(row => row.id === old)!.retired_at).toBeInstanceOf(Date);
    expect(stored.find(row => row.id === replacement)!.retired_at).toBeNull();
  });

  it("never revives a retired capability when identical authority is reissued", async () => {
    const old = (await issue()).get("endpoint-a")!;
    await database.db.transaction(tx => retireEndpointTelemetryContexts(tx, ["pool-a"]));
    const oldRow = (await rows()).find(row => row.id === old)!;
    const replacement = (await issue(projection({ generation: 8 }))).get("endpoint-a")!;
    expect(replacement).not.toBe(old); expect(Buffer.from(replacement, "base64url")).toHaveLength(32);
    expect((await rows()).find(row => row.id === old)).toEqual(oldRow);
    expect(Number((await rows()).find(row => row.id === replacement)!.generation)).toBe(8);
  });

  it("keeps reuse available at capacity and after a policy shrink while rejecting new authority atomically", async () => {
    const input = projection({ endpoints: [endpoint("endpoint-a"), endpoint("endpoint-b")] });
    const old = await issue(input, limits({ maxRowsPerPool: 2, maxRowsGlobal: 2 }));
    const before = await rows();
    const shrunk = limits({ maxRowsPerPool: 1, maxRowsGlobal: 1, maxPayloadBytesPerContext: 1, maxPayloadBytesPerPool: 1, maxPayloadBytesGlobal: 1 });
    expect(await issue({ ...input, generation: 900 }, shrunk)).toEqual(old);
    expect(await rows()).toEqual(before);
    const changed = projection({ endpoints: [endpoint("endpoint-a"), { ...endpoint("endpoint-b"), projectId: "projectC" }, endpoint("endpoint-c")] });
    await expect(issue(changed, limits({ maxRowsPerPool: 3, maxRowsGlobal: 3 })))
      .rejects.toMatchObject({ code: "endpoint_context_capacity_exhausted", status: 503, detail: { scope: "pool", resource: "rows", limit: 3 } });
    expect(await rows()).toEqual(before);
  });

  it("rejects duplicate snapshot identities and incomplete runtime policy before changing authority", async () => {
    await issue(); const before = await rows();
    await expect(issue(projection({ endpoints: [endpoint(), endpoint()] })))
      .rejects.toMatchObject({ code: "validation_failed" });
    await expect(issue(projection(), {} as EndpointContextStorageLimits)).rejects.toThrow("positive bounded integers");
    expect(await rows()).toEqual(before);
  });

  it("counts retained incarnations against pool and global row budgets", async () => {
    const old = (await issue(projection(), limits({ maxRowsPerPool: 1, maxRowsGlobal: 2 }))).get("endpoint-a")!;
    await database.db.transaction(tx => retireEndpointTelemetryContexts(tx, ["pool-a"]));
    await expect(issue(projection(), limits({ maxRowsPerPool: 1, maxRowsGlobal: 2 })))
      .rejects.toMatchObject({ code: "endpoint_context_capacity_exhausted", detail: { scope: "pool", resource: "rows" } });
    await issue(projection({ poolId: "pool-b" }), limits({ maxRowsPerPool: 1, maxRowsGlobal: 2 }));
    await expect(issue(projection({ poolId: "pool-c" }), limits({ maxRowsPerPool: 1, maxRowsGlobal: 2 })))
      .rejects.toMatchObject({ code: "endpoint_context_capacity_exhausted", detail: { scope: "global", resource: "rows" } });
    expect((await rows()).some(row => row.id === old && row.retired_at instanceof Date)).toBe(true);
    expect(await rows()).toHaveLength(2);
  });

  it("uses exact generated UTF-8 logical bytes at the per-context boundary", async () => {
    const original = (await issue()).get("endpoint-a")!;
    const size = Number((await rows()).find(row => row.id === original)!.payload_bytes);
    await issue(projection({ poolId: "pool-b" }), limits({ maxPayloadBytesPerContext: size }));
    await expect(issue(projection({ poolId: "pool-c" }), limits({ maxPayloadBytesPerContext: size - 1 })))
      .rejects.toMatchObject({ code: "endpoint_context_capacity_exhausted", detail: { scope: "context", resource: "payload_bytes" } });
    expect((await rows()).map(row => Number(row.payload_bytes))).toEqual([size, size]);
    const before = await rows();
    const unicode = projection(); unicode.routers[0]!.routes[0]!.targets[0]!.guardrailId = "漢".repeat(80);
    // 80 Unicode characters fit JS character counts while their UTF-8 payload
    // exceeds this small byte margin. The existing active authority survives.
    await expect(issue(unicode, limits({ maxPayloadBytesPerContext: size + 100 })))
      .rejects.toMatchObject({ code: "endpoint_context_capacity_exhausted", detail: { scope: "context", resource: "payload_bytes" } });
    expect(await rows()).toEqual(before);
  });

  it("enforces aggregate pool and global logical-byte budgets", async () => {
    await issue(); const size = Number((await rows())[0]!.payload_bytes);
    const two = projection({ endpoints: [endpoint("endpoint-a"), endpoint("endpoint-b")] });
    await expect(issue(two, limits({ maxPayloadBytesPerContext: size, maxPayloadBytesPerPool: size * 2 - 1, maxPayloadBytesGlobal: size * 4 })))
      .rejects.toMatchObject({ code: "endpoint_context_capacity_exhausted", detail: { scope: "pool", resource: "payload_bytes" } });
    expect(await rows()).toHaveLength(1);
    await expect(issue(projection({ poolId: "pool-b" }), limits({ maxPayloadBytesPerContext: size,
      maxPayloadBytesPerPool: size, maxPayloadBytesGlobal: size * 2 - 1 })))
      .rejects.toMatchObject({ code: "endpoint_context_capacity_exhausted", detail: { scope: "global", resource: "payload_bytes" } });
    expect(await rows()).toHaveLength(1);
    await issue(two, limits({ maxPayloadBytesPerContext: size, maxPayloadBytesPerPool: size * 2, maxPayloadBytesGlobal: size * 4 }));
    expect((await rows()).reduce((sum, row) => sum + Number(row.payload_bytes), 0)).toBe(size * 2);
  });

  it("serializes independent Controllers at the global row cap and deduplicates concurrent identical authority", async () => {
    const constrained = limits({ maxRowsPerPool: 1, maxRowsGlobal: 1 });
    // Exercise the lifecycle lock independently of the outer allocation lock.
    const results = await Promise.allSettled([
      database.db.transaction(tx => issueEndpointTelemetryContexts(tx, projection(), constrained)),
      second.transaction(tx => issueEndpointTelemetryContexts(tx, projection({ poolId: "pool-b" }), constrained)),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
    const stored = (await rows())[0]!;
    const input = projection({ poolId: stored.pool_id });
    const duplicates = await Promise.all([
      database.db.transaction(tx => issueEndpointTelemetryContexts(tx, input, constrained)),
      second.transaction(tx => issueEndpointTelemetryContexts(tx, input, constrained)),
    ]);
    expect(duplicates[0]).toEqual(duplicates[1]); expect(await rows()).toHaveLength(1);
  });

  it("does not oversubscribe the global byte budget when Controllers issue to different pools", async () => {
    await issue(); const size = Number((await rows())[0]!.payload_bytes);
    await database.pool.query("TRUNCATE endpoint_telemetry_context");
    const constrained = limits({ maxPayloadBytesPerContext: size, maxPayloadBytesPerPool: size, maxPayloadBytesGlobal: size * 2 - 1 });
    const results = await Promise.allSettled([
      database.db.transaction(tx => issueEndpointTelemetryContexts(tx, projection(), constrained)),
      second.transaction(tx => issueEndpointTelemetryContexts(tx, projection({ poolId: "pool-b" }), constrained)),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect((await rows()).reduce((sum, row) => sum + Number(row.payload_bytes), 0)).toBe(size);
  });

  it("prunes only old unreferenced rows and preserves runtime, cost and route evidence references", async () => {
    const active = (await issue(projection({ poolId: "live-pool" }))).get("endpoint-a")!;
    for (const id of ["runtime-proof", "cost-proof", "route-proof", "old-unreferenced"]) await seedRetired(id);
    await seedRetired("just-past-retention", "31 days 1 hour");
    await seedRetired("retention-window", "30 days 12 hours");
    await seedRetired("future-retirement", "-1 day");
    await database.db.transaction(async tx => { await lockEndpointTelemetryContextReaders(tx); await insertRuntimeReference(tx, "runtime-proof", "event-proof"); });
    await database.pool.query(`INSERT INTO model_usage_cost(id,event_id,guardrail_id,model,provider,source,occurred_at,reason,allocation_context_id)
      VALUES ('cost-reference','event-cost','guardrail-a','synthetic','synthetic','runtime',now(),'usage_missing','cost-proof');
      INSERT INTO route_assignment(decision_id,call_id,assignment_status,router_id,router_revision,route_id,target_id,guardrail_id,guardrail_version,endpoint_id,occurred_at,allocation_context_id)
      VALUES ('route-reference','call-route','assigned','router-a',3,'route-a','target-a','guardrail-a','version-a','endpoint-a',now(),'route-proof');`);
    let deleted = 0; for (let index = 0; index < 6; index += 1) deleted += await cleanup();
    expect(deleted).toBe(2);
    expect((await rows()).map(row => row.id).sort()).toEqual([active, "cost-proof", "future-retirement", "retention-window", "route-proof", "runtime-proof"].sort());
  });

  it("bounds each sweep to128 visits and advances past protected history to reclaim later garbage", async () => {
    await database.pool.query(`INSERT INTO endpoint_telemetry_context(id,snapshot_key,project_id,group_id,pool_id,allocation_epoch,generation,
      endpoint_id,adapter,verification_digest,endpoint_snapshot_digest,issued_at,retired_at)
      SELECT 'protected-'||lpad(n::text,3,'0'),'protected-'||n,'projectA','seed','seed',1,1,'protected-'||n,'guard','v','s',
        now()-interval '50 days',now()-interval '40 days' FROM generate_series(1,128) n;
      INSERT INTO runtime_event(id,occurred_at,request_id,runner_id,direction,decision,duration_ms,metadata,allocation_context_id)
      SELECT 'event-'||id,now(),id,'synthetic','incoming','allow',1,'{}',id FROM endpoint_telemetry_context;
      INSERT INTO endpoint_telemetry_context(id,snapshot_key,project_id,group_id,pool_id,allocation_epoch,generation,
        endpoint_id,adapter,verification_digest,endpoint_snapshot_digest,issued_at,retired_at)
      SELECT 'free-'||lpad(n::text,3,'0'),'free-'||n,'projectA','seed','seed',1,1,'free-'||n,'guard','v','s',
        now()-interval '50 days',now()-interval '39 days' FROM generate_series(1,129) n;`);
    expect(endpointContextCleanupBatchSize).toBe(128);
    expect(await cleanup()).toBe(0);
    expect(await cleanup()).toBe(128);
    expect(await cleanup()).toBe(1);
    expect(await cleanup()).toBe(0);
    expect(await cleanup()).toBe(0);
    expect(await rows()).toHaveLength(128);
  });

  it("reclaims eligible unreferenced capacity but never evicts referenced old authority to fit a snapshot", async () => {
    await seedRetired("reclaimable", "40 days", "pool-a");
    await issue(projection(), limits({ maxRowsPerPool: 1, maxRowsGlobal: 1 }));
    expect(await rows()).toHaveLength(1); expect((await rows())[0]!.id).not.toBe("reclaimable");
    await database.pool.query("TRUNCATE endpoint_telemetry_context,endpoint_telemetry_context_gc_cursor");
    await seedRetired("referenced", "40 days", "pool-a");
    await database.db.transaction(async tx => { await lockEndpointTelemetryContextReaders(tx); await insertRuntimeReference(tx, "referenced", "event-ref"); });
    await expect(issue(projection(), limits({ maxRowsPerPool: 1, maxRowsGlobal: 1 })))
      .rejects.toMatchObject({ code: "endpoint_context_capacity_exhausted", detail: { resource: "rows" } });
    expect((await rows()).map(row => row.id)).toEqual(["referenced"]);
  });

  it("serializes cleanup with in-flight context evidence so a new reference cannot lose its authority", async () => {
    await seedRetired("reference-race");
    const entered = deferred(), release = deferred();
    const reader = database.db.transaction(async tx => {
      await lockEndpointTelemetryContextReaders(tx); entered.resolve(); await release.promise;
      await insertRuntimeReference(tx, "reference-race", "race-event");
    });
    await entered.promise;
    let writerPid!: number; const writerStarted = deferred();
    const writer = second.transaction(async tx => {
      const result = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      writerPid = result.rows[0]!.pid; writerStarted.resolve(); return pruneEndpointTelemetryContexts(tx);
    });
    try {
      await writerStarted.promise; await blocked(writerPid);
      expect((await rows()).some(row => row.id === "reference-race")).toBe(true);
    } finally { release.resolve(); }
    await reader; expect(await writer).toBe(0);
    expect((await rows()).map(row => row.id)).toEqual(["reference-race"]);
  });

  it("keeps retirement outside an in-flight reader transaction and preserves immutable history", async () => {
    const id = (await issue()).get("endpoint-a")!; const before = (await rows())[0]!;
    const entered = deferred(), release = deferred();
    const reader = database.db.transaction(async tx => { await lockEndpointTelemetryContextReaders(tx); entered.resolve(); await release.promise; });
    await entered.promise;
    let writerPid!: number; const started = deferred();
    const writer = second.transaction(async tx => {
      const result = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      writerPid = result.rows[0]!.pid; started.resolve(); await retireEndpointTelemetryContexts(tx, ["pool-a"]);
    });
    try { await started.promise; await blocked(writerPid); expect((await rows())[0]!.retired_at).toBeNull(); }
    finally { release.resolve(); }
    await reader; await writer;
    const after = (await rows())[0]!;
    expect(after).toEqual({ ...before, id, retired_at: expect.any(Date) });
  });

  it("allows concurrent readers while issuance waits for every reader transaction", async () => {
    const releaseA = deferred(), releaseB = deferred(), enteredA = deferred(), enteredB = deferred();
    const readerA = database.db.transaction(async tx => { await lockEndpointTelemetryContextReaders(tx); enteredA.resolve(); await releaseA.promise; });
    await enteredA.promise;
    let readerBEntered = false;
    const readerB = second.transaction(async tx => { await lockEndpointTelemetryContextReaders(tx); readerBEntered = true; enteredB.resolve(); await releaseB.promise; });
    let writerPid!: number; const writerStarted = deferred();
    let writer: ReturnType<typeof issue> | undefined;
    try {
      await expect.poll(() => readerBEntered, { timeout: 3000, interval: 10 }).toBe(true);
      writer = database.db.transaction(async tx => {
        const result = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        writerPid = result.rows[0]!.pid; writerStarted.resolve(); return issueEndpointTelemetryContexts(tx, projection(), limits());
      });
      await enteredB.promise; await writerStarted.promise; await blocked(writerPid);
      releaseA.resolve(); await readerA; await blocked(writerPid);
    } finally { releaseA.resolve(); releaseB.resolve(); }
    await readerB; expect((await writer!).get("endpoint-a")).toBeTruthy(); expect(await rows()).toHaveLength(1);
  });
});
