// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Registry } from "prom-client";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { loadConfig } from "../config.js";
import type { ControllerAuth } from "../auth.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControllerMetrics } from "../metrics.js";
import { ControlPlaneService } from "../services/control-plane.js";
import { createHttpApp } from "./app.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
const poolA = "pool-a-control-token-with-at-least-32-characters";
const poolB = "pool-b-control-token-with-at-least-32-characters";
const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://unused:unused@localhost/unused",
  CONTROLLER_RUNNER_TOKEN: "legacy-runner-token-with-at-least-32-characters", BETTER_AUTH_SECRET: "better-auth-secret-with-at-least-32-characters",
  CONTROLLER_RUNNER_POOL_TOKENS_JSON: JSON.stringify({ "pool-a": poolA, "pool-b": poolB }),
  CONTROLLER_RUNNER_SCOPED_TELEMETRY: "true", CONTROLLER_RUNNER_TELEMETRY_PROGRESS: "true", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/test-key.pem" });

describe.skipIf(!url)("current-session contiguous telemetry delivery", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let service: ControlPlaneService;
  let sessionId: string, walId: string, capability: string;
  const identity = () => ({ sessionId, runnerId: "runner-a", bootId: "boot-a", poolId: "pool-a" });
  const register = async (session = sessionId, bootId = "boot-a") => service.registerRunner({ runnerId: "runner-a", bootId, poolId: "pool-a",
    runnerVersion: "test", nemoVersion: "test", maxConcurrency: 2, compilerCapable: false, labels: {}, appliedGeneration: 1 }, session);
  const app = () => createHttpApp({ config, service, auth: { api: { getSession: vi.fn() } } as unknown as ControllerAuth,
    runnerControl: {} as RunnerControlServer, metrics: { registry: new Registry() } as ControllerMetrics });
  const event = (id = "runtime-one") => ({ id, requestId: id, runnerId: "runner-a", occurredAt: new Date().toISOString(),
    direction: "incoming", decision: "allow", durationMs: 1, metadata: {} });
  const batch = (events = [event()], firstCursor = 1, producedCursor = firstCursor + events.length - 1) => ({ events,
    progress: { walId, batchId: randomUUID(), firstCursor, lastCursor: firstCursor + events.length - 1, producedCursor } });
  const post = (body: unknown, token = poolA, uploadCapability = capability) => app().request("/api/internal/v1/runtime-events", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-tasklattice-telemetry-capability": uploadCapability },
    body: JSON.stringify(body),
  });
  const cursors = async () => (await database.pool.query("SELECT acknowledged_cursor,produced_cursor,caught_up_at FROM runner_telemetry_wal WHERE runner_id='runner-a'")).rows[0];

  beforeAll(async () => {
    database = await createTestDatabase(url!, "telemetry_progress");
    service = new ControlPlaneService(database.db, config);
    await database.pool.query(`INSERT INTO runner_pool(id,name) VALUES ('pool-a','A'),('pool-b','B');
      INSERT INTO guardrail(id,tenant_id,name,draft_config) VALUES ('progress-guard','tenantA','Progress','{}');
      INSERT INTO controller_state(id,desired_generation) VALUES ('singleton',1) ON CONFLICT(id) DO UPDATE SET desired_generation=1;`);
  }, 30_000);
  beforeEach(async () => {
    await database.pool.query(`DELETE FROM runner_telemetry_capability; DELETE FROM runner_telemetry_wal;
      DELETE FROM model_usage_cost; DELETE FROM runtime_event; DELETE FROM route_assignment; DELETE FROM telemetry_watermark;
      DELETE FROM runner_instance; DELETE FROM runner_control_session;`);
    sessionId = randomUUID(); walId = randomUUID();
    await register();
    capability = (await service.telemetryProgress.issue(identity(), walId)).capability;
  });
  afterAll(async () => { await database?.drop(); });

  it("requires both pool authentication and a secret dispatched to the current session", async () => {
    for (const [poolToken, upload] of [[poolA, ""], [poolA, "0".repeat(64)], [poolB, capability]]) {
      expect((await post(batch(), poolToken, upload)).status).toBe(401);
    }
    expect((await post(batch([{ ...event(), runnerId: "spoofed-runner" }]))).status).toBe(401);
    expect((await database.pool.query("SELECT id FROM runtime_event")).rows).toEqual([]);
    expect(await cursors()).toMatchObject({ acknowledged_cursor: "0", produced_cursor: "0", caught_up_at: null });
    const [stored] = (await database.pool.query("SELECT capability_hash FROM runner_telemetry_capability")).rows;
    expect(stored.capability_hash).not.toEqual(capability);
    expect(JSON.stringify(stored)).not.toContain(capability);
  });

  it("commits contiguous mixed event dispositions and ACK together, replaying a lost reply exactly once", async () => {
    const now = new Date().toISOString();
    const routing = { id: "route-one", runnerId: "runner-a", eventType: "route_assignment", decisionId: "decision-one", callId: "call-one",
      endpointId: "unsupported", routerId: "", routerRevision: 0, routeId: "", targetId: "", guardrailId: "", guardrailVersion: "",
      assignmentStatus: "unassigned", occurredAt: now, decisionAt: now };
    const payload = batch([event(), routing] as ReturnType<typeof event>[], 1, 3);
    const first = await post(payload);
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ accepted: 2, progress: { walId, acknowledgedCursor: 2, producedCursor: 3,
      lastBatchId: payload.progress.batchId, lastBatchDigest: createHash("sha256").update(JSON.stringify(payload)).digest("hex") } });
    expect((await post(payload)).status).toBe(202);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM runtime_event")).rows[0].n).toBe(1);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM route_assignment")).rows[0].n).toBe(1);
    const changed = { ...payload, events: [{ ...payload.events[0], decision: "block" }, payload.events[1]] };
    expect((await post(changed)).status).toBe(409);
    expect((await post(batch([event("gap")], 4))).status).toBe(409);
    expect((await post(batch([event("overlap")], 2, 3))).status).toBe(409);
    expect((await post(batch([event("tail")], 3))).status).toBe(202);
    const caughtUp = { events: [], progress: { walId, batchId: randomUUID(), firstCursor: 3, lastCursor: 3, producedCursor: 3 } };
    expect((await post(caughtUp)).status).toBe(202);
    expect((await post(caughtUp)).status).toBe(202); // Replay remains a diagnostic, never freshness authority.
    expect(await cursors()).toMatchObject({ acknowledged_cursor: "3", produced_cursor: "3", caught_up_at: expect.any(Date) });
    expect((await database.pool.query("SELECT * FROM telemetry_watermark")).rows).toEqual([]);
    expect((await service.observabilitySnapshot()).watermarks).toEqual([]);
  });

  it("does not accept an empty caught-up claim while a previously reported tail remains", async () => {
    expect((await post(batch([event()], 1, 2))).status).toBe(202);
    expect((await post({ events: [], progress: { walId, batchId: randomUUID(), firstCursor: 1, lastCursor: 1, producedCursor: 1 } })).status).toBe(409);
    expect(await cursors()).toMatchObject({ acknowledged_cursor: "1", produced_cursor: "2", caught_up_at: null });
  });

  it("invalidates previous boot/session uploads and resumes only the same retained WAL", async () => {
    expect((await post(batch())).status).toBe(202);
    const old = capability;
    sessionId = randomUUID();
    await register(sessionId, "boot-b");
    expect((await post(batch([event("late")], 2), poolA, old)).status).toBe(401);
    const resumed = await service.telemetryProgress.issue({ ...identity(), bootId: "boot-b" }, walId);
    expect(resumed.acknowledgedCursor).toBe(1);
    capability = resumed.capability;
    expect((await post(batch([event("new")], 2))).status).toBe(202);
    const next = randomUUID(); await register(next, "boot-c");
    await expect(service.telemetryProgress.issue({ ...identity(), sessionId: next, bootId: "boot-c" }, randomUUID()))
      .rejects.toMatchObject({ code: "telemetry_wal_conflict" });
    expect((await database.pool.query("SELECT wal_id FROM runner_telemetry_wal")).rows).toEqual([{ wal_id: walId }]);
  });

  it("rolls back event writes and ACK on cursor persistence failure, retaining replay", async () => {
    await database.pool.query(`CREATE FUNCTION fail_telemetry_cursor() RETURNS trigger AS $$ BEGIN
      RAISE EXCEPTION 'injected cursor failure'; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_telemetry_cursor BEFORE UPDATE ON runner_telemetry_wal FOR EACH ROW EXECUTE FUNCTION fail_telemetry_cursor();`);
    const now = new Date().toISOString();
    const metered = { ...event(), guardrailId: "progress-guard", metadata: { usage: { model_calls: [{ call_id: "model-call", provider: "synthetic",
      model: "synthetic", usage_known: true, input_tokens: 1, output_tokens: 1 }] } } };
    const routing = { id: "rollback-route", runnerId: "runner-a", eventType: "route_assignment", decisionId: "rollback-decision", callId: "rollback-call",
      endpointId: "unsupported", routerId: "", routerRevision: 0, routeId: "", targetId: "", guardrailId: "", guardrailVersion: "",
      assignmentStatus: "unassigned", occurredAt: now, decisionAt: now };
    const payload = batch([metered, routing] as ReturnType<typeof event>[]);
    try {
      expect((await post(payload)).status).toBe(500);
      expect((await database.pool.query("SELECT * FROM runtime_event")).rows).toEqual([]);
      expect((await database.pool.query("SELECT * FROM route_assignment")).rows).toEqual([]);
      expect((await database.pool.query("SELECT * FROM model_usage_cost")).rows).toEqual([]);
      expect(await cursors()).toMatchObject({ acknowledged_cursor: "0", produced_cursor: "0" });
    } finally {
      await database.pool.query("DROP TRIGGER fail_telemetry_cursor ON runner_telemetry_wal; DROP FUNCTION fail_telemetry_cursor()");
    }
    expect((await post(payload)).status).toBe(202);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM model_usage_cost")).rows[0].n).toBe(1);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM route_assignment")).rows[0].n).toBe(1);
  });

  it("serializes two Controller clients racing the same cursor", async () => {
    const responses = await Promise.all([post(batch([event("one")])), post(batch([event("two")]))]);
    expect(responses.map(response => response.status).sort()).toEqual([202, 409]);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM runtime_event")).rows[0].n).toBe(1);
    expect(await cursors()).toMatchObject({ acknowledged_cursor: "1" });
  });

  it("keeps unrelated Runner uploads concurrent while blocking a same-Runner takeover until commit", async () => {
    await service.registerRunner({ runnerId: "runner-b", bootId: "boot-b", poolId: "pool-b", runnerVersion: "test", nemoVersion: "test",
      maxConcurrency: 2, compilerCapable: false, labels: {}, appliedGeneration: 1 }, "session-b");
    const walB = randomUUID();
    const issuedB = await service.telemetryProgress.issue({ runnerId: "runner-b", bootId: "boot-b", poolId: "pool-b", sessionId: "session-b" }, walB);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const payload = batch();
    const slow = service.telemetryProgress.ingest("pool-a", capability, payload.progress, "a".repeat(64), payload.events, async () => {
      entered(); await gate;
    });
    await started;
    const otherPayload = { events: [{ runnerId: "runner-b" }], progress: { walId: walB, batchId: randomUUID(), firstCursor: 1, lastCursor: 1, producedCursor: 1 } };
    const unrelated = await Promise.race([
      service.telemetryProgress.ingest("pool-b", issuedB.capability, otherPayload.progress, "b".repeat(64), otherPayload.events, async () => {}),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("unrelated Runner upload was globally serialized")), 2000)),
    ]);
    expect(unrelated.acknowledgedCursor).toBe(1);
    let replaced = false;
    const takeover = register(randomUUID(), "replacement-boot").then(() => { replaced = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(replaced).toBe(false);
    release();
    await slow; await takeover;
    expect((await post(batch([event("stale")], 2))).status).toBe(401);
  });
});
