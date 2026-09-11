// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import * as schema from "../db/schema.js";
import type { RouterDraft } from "../../shared/traffic-routing.js";
import { ControlPlaneService } from "./control-plane.js";
import { routingEventSchema, type RoutingEvent } from "./traffic-routing.js";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
const url = process.env.GUARD_TEST_POSTGRES_URL;
const actor = "admin";
const draft = (): RouterDraft => ({ routes: [{ id: "fallback", name: "Fallback", kind: "fallback", enabled: true,
  selector: { expression: { combinator: "and", conditions: [] } },
  targets: [{ id: "target-a", guardrailId: "guard-a", guardrailVersion: "1", weightBps: 10000 }],
}] });
const withHeader = (): RouterDraft => ({ routes: [{ ...draft().routes[0]!, id: "partner", name: "Partner", kind: "normal",
  selector: { expression: { combinator: "and", conditions: [{ field: "http.header", key: "x-channel", requestSource: "business_request", operator: "equals", value: "partner" }] } },
}, ...draft().routes] });

describe.skipIf(!url)("Traffic composition transactions in PostgreSQL", () => {
  const namespace = `guard_traffic_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool; let pool: Pool; let service: ControlPlaneService;
  const read = (name: string) => readFileSync(new URL(`../db/migrations/${name}`, import.meta.url), "utf8");
  beforeAll(async () => {
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(new URL(url!).hostname);
    admin = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 });
    await admin.query(`CREATE SCHEMA "${namespace}"`);
    pool = new Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 5000, options: `-c search_path=${namespace}`, application_name: namespace });
    const journal = JSON.parse(read("meta/_journal.json")) as { entries: { tag: string }[] };
    expect(journal.entries.some(e => e.tag === "0009_traffic_router_composition")).toBe(true);
    // Start from nothing: preserve real constraints and never depend on public's migration state.
    for (const { tag } of journal.entries) await pool.query(read(`${tag}.sql`).replaceAll('"public".', `"${namespace}".`));
    service = new ControlPlaneService(drizzle(pool, { schema }), loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: url!,
      CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/unused-signing-key.pem",
      CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"), BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters" }));
  });
  afterAll(async () => { await pool?.end(); await admin?.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await admin?.end(); });
  beforeEach(async () => {
    await pool.query('TRUNCATE auth_user, guardrail, runner_pool, controller_state, traffic_router, route_assignment, telemetry_watermark CASCADE');
    await pool.query(`INSERT INTO auth_user (id,name,email,role) VALUES ('admin','Admin','admin@example.test','admin');
      INSERT INTO controller_state (id) VALUES ('singleton');
      INSERT INTO runner_pool (id,name) VALUES ('default','Default');
      INSERT INTO guardrail (id,name,draft_config) VALUES ('guard-a','Original','{}'),('guard-b','Other','{}');
      INSERT INTO guardrail_version (guardrail_id,version,generation,status,runtime_profile,plan,artifact_id) VALUES
        ('guard-a','1',1,'ready','auto','{}','artifact-a'),('guard-b','1',2,'ready','auto','{}','artifact-b');
      INSERT INTO endpoint (id,name,adapter) VALUES ('http','HTTP','HTTP'),('a2a','A2A','A2A');`);
  });
  async function create(value = draft()) { return service.trafficRouting.create("Router", "", value, actor); }
  async function publish(value = draft()) { const router = await create(value); return service.trafficRouting.publish(router.id, 1, randomUUID(), actor); }
  async function generation() { return Number((await pool.query("SELECT desired_generation FROM controller_state WHERE id='singleton'")).rows[0].desired_generation); }
  async function count(table: string, where = "TRUE") { return (await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0].n as number; }

  it("creates a draft with multiple exclusive source Endpoints atomically", async () => {
    const router = await service.trafficRouting.create("Sources", "", draft(), actor, ["http", "a2a"]);
    expect(router.endpointIds.sort()).toEqual(["a2a", "http"]);
    expect(router.activeSnapshot).toBeNull();
    await expect(service.trafficRouting.create("Conflict", "", draft(), actor, ["http"])).rejects.toMatchObject({ code: "endpoint_router_conflict" });
    expect(await count("traffic_router")).toBe(1);
    await expect(service.trafficRouting.create("Missing", "", draft(), actor, ["missing"])).rejects.toThrow("Endpoint was not found");
    expect(await count("traffic_router")).toBe(1);
  });

  it("serializes competing creation requests for the same source Endpoint", async () => {
    const results = await Promise.allSettled([
      service.trafficRouting.create("First", "", draft(), actor, ["http"]),
      service.trafficRouting.create("Second", "", draft(), actor, ["http"]),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await count("traffic_router")).toBe(1);
  });

  it("serializes concurrent publication retries into one immutable revision, generation and audit", async () => {
    const router = await create();
    const results = await Promise.all(Array.from({ length: 8 }, () => service.trafficRouting.publish(router.id, 1, "same-request", actor)));
    expect(results.every(r => r.activeRevision === 1)).toBe(true);
    expect(await generation()).toBe(1);
    expect(await count("traffic_router_revision")).toBe(1);
    expect(await count("audit_event", "kind='router.published'")).toBe(1);
    expect((await service.trafficRouting.revisions(router.id))[0]?.snapshot).toEqual(draft());
    const changed = draft(); changed.routes[0]!.name = "Edited later";
    await service.trafficRouting.save(router.id, 1, changed, actor);
    await service.trafficRouting.publish(router.id, 1, "same-request", actor);
    expect(await generation()).toBe(1);
    expect((await service.trafficRouting.get(router.id)).activeSnapshot).toEqual(draft());
    await expect(service.trafficRouting.publish(router.id, 2, "same-request", actor)).rejects.toMatchObject({ code: "router_publish_key_conflict" });
  });

  it("allows one concurrent draft writer and never publishes a stale draft", async () => {
    const router = await create();
    const a = draft(), b = draft(); a.routes[0]!.name = "A"; b.routes[0]!.name = "B";
    const saves = await Promise.allSettled([service.trafficRouting.save(router.id, 1, a, actor), service.trafficRouting.save(router.id, 1, b, actor)]);
    expect(saves.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(saves.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "router_draft_conflict" } });
    await expect(service.trafficRouting.publish(router.id, 1, "stale", actor)).rejects.toMatchObject({ code: "router_draft_conflict" });
    expect(await generation()).toBe(0); expect(await count("traffic_router_revision")).toBe(0);
    const saved = await service.trafficRouting.get(router.id);
    const live = await service.trafficRouting.publish(router.id, 2, "current", actor);
    expect(live.activeSnapshot).toEqual(saved.draft);
  });

  it("rolls back by publishing old content as a new revision and replays that request once", async () => {
    const router = await publish(); const changed = draft(); changed.routes[0]!.targets[0]!.guardrailId = "guard-b";
    await service.trafficRouting.save(router.id, 1, changed, actor);
    await service.trafficRouting.publish(router.id, 2, "second", actor);
    const rolled = await service.trafficRouting.publish(router.id, 2, "rollback", actor, 1);
    expect(rolled).toMatchObject({ activeRevision: 3, draftRevision: 3, activeSnapshot: draft() });
    await service.trafficRouting.publish(router.id, 2, "rollback", actor, 1);
    expect(await generation()).toBe(3); expect(await count("traffic_router_revision")).toBe(3);
    await expect(service.trafficRouting.publish(router.id, 2, "rollback", actor, 2)).rejects.toMatchObject({ code: "router_publish_key_conflict" });
  });

  it.each([9900, 10100])("preserves a %i bps draft but rejects publication atomically", async total => {
    const value = draft(); value.routes[0]!.targets = [{ id: "a", guardrailId: "guard-a", guardrailVersion: "1", weightBps: 5000 }, { id: "b", guardrailId: "guard-b", guardrailVersion: "1", weightBps: total - 5000 }];
    const router = await create(value);
    await expect(service.trafficRouting.publish(router.id, 1, "invalid", actor)).rejects.toMatchObject({ code: "validation_failed" });
    expect((await service.trafficRouting.get(router.id)).draft).toEqual(value);
    expect(await generation()).toBe(0); expect(await count("traffic_router_revision")).toBe(0);
  });

  it("requires ready positive targets while retaining an unready zero-weight candidate", async () => {
    await pool.query("UPDATE guardrail_version SET status='compiling' WHERE guardrail_id='guard-b'");
    const value = draft(); value.routes[0]!.targets.push({ id: "candidate", guardrailId: "guard-b", guardrailVersion: "1", weightBps: 0 });
    const router = await publish(value);
    value.routes[0]!.targets[0]!.weightBps = 9000; value.routes[0]!.targets[1]!.weightBps = 1000;
    await service.trafficRouting.save(router.id, 1, value, actor);
    await expect(service.trafficRouting.publish(router.id, 2, "unready", actor)).rejects.toMatchObject({ code: "validation_failed" });
    expect((await service.trafficRouting.get(router.id)).activeRevision).toBe(1);
    expect(await generation()).toBe(1);
  });

  it("serializes competing bindings and keeps one source Endpoint per Router", async () => {
    const [a, b] = await Promise.all([publish(), publish()]);
    const results = await Promise.allSettled([service.trafficRouting.bind(a.id, ["http"], actor), service.trafficRouting.bind(b.id, ["http"], actor)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "endpoint_router_conflict" } });
    const owner = (await pool.query("SELECT traffic_router_id FROM endpoint WHERE id='http'")).rows[0].traffic_router_id;
    const other = owner === a.id ? b.id : a.id;
    const before = await generation();
    await service.trafficRouting.bind(other, ["a2a"], actor);
    expect((await pool.query("SELECT traffic_router_id FROM endpoint WHERE id='a2a'")).rows[0].traffic_router_id).toBe(other);
    expect(await generation()).toBeGreaterThan(before);
    await service.trafficRouting.bind(owner, [], actor);
    expect((await service.trafficRouting.bind(other, ["http"], actor)).endpointIds).toEqual(["http"]);
  });

  it("checks endpoint capability at both binding and publication against the active snapshot", async () => {
    const router = await publish(withHeader());
    await expect(service.trafficRouting.bind(router.id, ["a2a"], actor)).rejects.toMatchObject({ code: "validation_failed" });
    await service.trafficRouting.bind(router.id, ["http"], actor);
    const plain = await publish(); await service.trafficRouting.bind(plain.id, ["a2a"], actor);
    await service.trafficRouting.save(plain.id, 1, withHeader(), actor);
    await expect(service.trafficRouting.publish(plain.id, 2, "unsupported", actor)).rejects.toMatchObject({ code: "validation_failed" });
    expect((await service.trafficRouting.get(plain.id)).activeSnapshot).toEqual(draft());
    const unpublished = await create();
    await expect(service.trafficRouting.bind(unpublished.id, ["http"], actor)).rejects.toMatchObject({ code: "endpoint_router_conflict" });
  });

  function event(routerId: string, decisionId: string, overrides: Partial<RoutingEvent> = {}): RoutingEvent {
    return routingEventSchema.parse({ id: `assignment-${decisionId}`, eventType: "route_assignment", decisionId, callId: `call-${decisionId}`, runnerId: "runner", endpointId: "http", routerId, routerRevision: 1,
      routeId: "fallback", targetId: "target-a", guardrailId: "guard-a", guardrailVersion: "1", occurredAt: new Date(), decisionAt: new Date(Date.now() - 1000), assignmentStatus: "assigned", ...overrides });
  }
  async function runner(id = "runner") { await pool.query("INSERT INTO runner_instance (runner_id,boot_id,pool_id,runner_version,nemo_version,max_concurrency) VALUES ($1,'boot','default','test','test',10)", [id]); }

  it("deduplicates retries and completion-before-assignment while counting unique logical decisions", async () => {
    const router = await publish(); await runner();
    const a = event(router.id, "a"), done = event(router.id, "a", { id: "completion-a", eventType: "completion", outcome: "block", durationMs: 300 });
    await service.trafficRouting.recordEvents([done, a, done, a]);
    await Promise.all(Array.from({ length: 4 }, () => service.trafficRouting.recordEvents([a, done])));
    await service.trafficRouting.recordEvents([event(router.id, "b"), event(router.id, "c", { assignmentStatus: "unassigned", routeId: "", targetId: "", guardrailId: "", guardrailVersion: "", failureReason: "binding unavailable" })]);
    const result = await service.trafficRouting.distribution(router.id, 24);
    expect(result).toMatchObject({ total: 3, assigned: 2, unassigned: 1, unit: "logical_call", telemetryFresh: true, completeness: "current" });
    expect(result.rows.find(r => r.assignmentStatus === "assigned")).toMatchObject({ count: 2, completed: 1, blocked: 1, errors: 0, p95Ms: 300 });
    expect(result.trend.reduce((n, r) => n + r.count, 0)).toBe(3);
  });

  it("folds multistage outcomes without inflating counts and retains revision/endpoint filters", async () => {
    const router = await publish();
    for (const [i, outcome] of ["allow", "transform", "intervene", "block", "error"].entries()) {
      await service.trafficRouting.recordEvents([event(router.id, "multi", { id: `stage-${i}`, eventType: "completion", outcome: outcome as RoutingEvent["outcome"], durationMs: (i + 1) * 100 })]);
    }
    await service.trafficRouting.recordEvents([event(router.id, "r2", { routerRevision: 2, endpointId: "a2a" })]);
    const result = await service.trafficRouting.distribution(router.id, 24);
    expect(result).toMatchObject({ total: 2, multipleRevisions: true });
    const first = await service.trafficRouting.distribution(router.id, 24, 1, "http");
    expect(first).toMatchObject({ total: 1, multipleRevisions: false });
    expect(first.rows[0]).toMatchObject({ count: 1, completed: 1, errors: 1, blocked: 0, p95Ms: 500 });
    expect((await service.trafficRouting.distribution(router.id, 24, 1, "a2a")).total).toBe(0);
  });

  it("backfills late completion into decision time and replaces only inferred timeout", async () => {
    const router = await publish(); const decisionAt = new Date(Date.now() - 2 * 3600000);
    const a = event(router.id, "late", { decisionAt });
    await service.trafficRouting.recordEvents([a]);
    expect((await service.trafficRouting.distribution(router.id, 24)).rows[0]).toMatchObject({ errors: 1, completed: 1 });
    await service.trafficRouting.recordEvents([event(router.id, "late", { id: "late-completion", decisionAt, eventType: "completion", outcome: "allow", durationMs: 420000 })]);
    expect((await service.trafficRouting.distribution(router.id, 24)).rows[0]).toMatchObject({ count: 1, errors: 0, allowed: 1, p95Ms: 420000 });
    expect((await service.trafficRouting.distribution(router.id, 1)).total).toBe(0);
    expect((await pool.query("SELECT occurred_at FROM route_assignment WHERE decision_id='late'")).rows[0].occurred_at).toEqual(decisionAt);
    await service.trafficRouting.recordEvents([event(router.id, "explicit", { id: "real-timeout", eventType: "completion", outcome: "timeout" }), event(router.id, "explicit", { id: "later-allow", eventType: "completion", outcome: "allow" })]);
    expect((await pool.query("SELECT outcome FROM route_assignment WHERE decision_id='explicit'")).rows[0].outcome).toBe("timeout");
  });

  it("reports missing telemetry and stale heartbeats instead of presenting trustworthy zero traffic", async () => {
    const router = await publish();
    expect(await service.trafficRouting.distribution(router.id, 24)).toMatchObject({ total: 0, telemetryFresh: false, dataWatermark: null, completeness: "delayed_or_unavailable" });
    await runner(); await service.trafficRouting.recordEvents([event(router.id, "fresh")]);
    expect((await service.trafficRouting.distribution(router.id, 24)).telemetryFresh).toBe(true);
    await runner("silent");
    expect((await service.trafficRouting.distribution(router.id, 24)).telemetryFresh).toBe(false);
    await service.trafficRouting.recordEvents([event(router.id, "silent-event", { runnerId: "silent" })]);
    await pool.query("UPDATE runner_instance SET last_heartbeat_at=now()-interval '2 minutes' WHERE runner_id='runner'");
    expect((await service.trafficRouting.distribution(router.id, 24)).telemetryFresh).toBe(false);
    await pool.query("UPDATE runner_instance SET last_heartbeat_at=now(); UPDATE telemetry_watermark SET last_received_at=now()-interval '2 minutes' WHERE runner_id='runner'");
    const stale = await service.trafficRouting.distribution(router.id, 24);
    expect(stale.telemetryFresh).toBe(false); expect(Date.parse(stale.dataWatermark!)).toBeLessThan(Date.now() - 60000);
  });

  async function sourceFixture() {
    const db = drizzle(pool, { schema });
    const config = { allowedTopics: ["support"], restrictedTopics: [], policyBindings: [], safetyLevel: "strict" as const, outputDelivery: "full_buffered" as const };
    await db.insert(schema.testCases).values({ guardrailId: "guard-a", id: "custom-case", name: "Pinned case", policyId: "policy-fixed", phase: "input", content: "frozen", expectedDecision: "block", origin: "custom", coveredRuleIds: ["rule-1"] });
    const cases = await db.select().from(schema.testCases).where(eq(schema.testCases.guardrailId, "guard-a"));
    const snapshot = { draftConfig: config, runtimeProfile: "llmrails_colang2_programmable", loggingLevel: "debug", excludedTestCaseIds: ["custom-case"], testCases: cases };
    await db.update(schema.guardrailVersions).set({ sourceSnapshot: snapshot }).where(eq(schema.guardrailVersions.guardrailId, "guard-a"));
    await db.update(schema.guardrails).set({ draftConfig: config, activeVersion: "1", runtimeProfile: snapshot.runtimeProfile, loggingLevel: "debug", excludedTestCaseIds: snapshot.excludedTestCaseIds }).where(eq(schema.guardrails.id, "guard-a"));
    return { db, snapshot };
  }
  it("duplicates the exact published source after draft changes, with independent identity and no readiness or traffic", async () => {
    const { db, snapshot } = await sourceFixture(); const router = await publish(); await service.trafficRouting.bind(router.id, ["http"], actor);
    await db.update(schema.guardrails).set({ draftRevision: 2, draftConfig: { ...snapshot.draftConfig, allowedTopics: ["changed"] }, loggingLevel: "trace" }).where(eq(schema.guardrails.id, "guard-a"));
    await pool.query("UPDATE guardrail_test_case SET content='changed' WHERE guardrail_id='guard-a'");
    const request = { id: "guard-a", name: "Independent", sourceVersion: "1", idempotencyKey: "copy", actorId: actor };
    const copies = await Promise.all(Array.from({ length: 6 }, () => service.duplicateGuardrail(request)));
    const copy = copies[0]!; expect(new Set(copies.map(c => c.id)).size).toBe(1); expect(copy.id).not.toBe("guard-a");
    expect(copy).toMatchObject({ draftConfig: snapshot.draftConfig, runtimeProfile: snapshot.runtimeProfile, loggingLevel: "debug", excludedTestCaseIds: ["custom-case"], status: "draft", activeVersion: null, latestValidationRun: null, versions: [] });
    expect(copy.copyOrigin).toMatchObject({ sourceGuardrailId: "guard-a", sourceName: "Original", sourceVersion: "1", sourceDraftRevision: null });
    // JSON storage normalizes dates; digest must describe the actual frozen source payload.
    const storedSnapshot = (await db.select().from(schema.guardrailVersions).where(eq(schema.guardrailVersions.guardrailId, "guard-a")))[0]!.sourceSnapshot;
    expect(copy.copyOrigin?.contentDigest).toBe(createHash("sha256").update(stableJson(storedSnapshot)).digest("hex"));
    const cases = await db.select().from(schema.testCases).where(eq(schema.testCases.guardrailId, copy.id));
    expect(cases).toHaveLength(1); expect(cases[0]).toMatchObject({ id: "custom-case", content: "frozen", coveredRuleIds: ["rule-1"] });
    expect(await count("guardrail", "duplicate_key IS NOT NULL")).toBe(1); expect(await count("audit_event", "kind='guardrail.duplicated'")).toBe(1);
    const before = (await db.select().from(schema.guardrails).where(eq(schema.guardrails.id, "guard-a")))[0];
    await db.update(schema.guardrails).set({ draftConfig: { ...snapshot.draftConfig, allowedTopics: ["copy only"] } }).where(eq(schema.guardrails.id, copy.id));
    expect((await db.select().from(schema.guardrails).where(eq(schema.guardrails.id, "guard-a")))[0]).toEqual(before);
    expect((await service.trafficRouting.get(router.id)).activeSnapshot).toEqual(draft());
    expect((await service.trafficRouting.get(router.id)).endpointIds).toEqual(["http"]);
    expect(await generation()).toBe(2);
    expect((await service.duplicateGuardrail(request)).id).toBe(copy.id);
    await expect(service.duplicateGuardrail({ ...request, name: "Different request" })).rejects.toMatchObject({ code: "duplicate_key_conflict" });
  });

  it("freezes a requested draft revision and fails stale or snapshot-less copies without partial objects", async () => {
    const { snapshot } = await sourceFixture();
    const request = { id: "guard-a", name: "Draft copy", sourceDraftRevision: 1, idempotencyKey: "draft-copy", actorId: actor };
    const copy = await service.duplicateGuardrail(request);
    expect(copy.draftConfig).toEqual(snapshot.draftConfig); expect(copy.copyOrigin).toMatchObject({ sourceDraftRevision: 1, sourceVersion: null });
    await pool.query("UPDATE guardrail SET draft_revision=2 WHERE id='guard-a'");
    expect((await service.duplicateGuardrail(request)).id).toBe(copy.id);
    await expect(service.duplicateGuardrail({ ...request, idempotencyKey: "stale" })).rejects.toMatchObject({ code: "guardrail_draft_conflict" });
    await pool.query("UPDATE guardrail_version SET source_snapshot=NULL WHERE guardrail_id='guard-a'");
    await expect(service.duplicateGuardrail({ id: "guard-a", name: "Legacy", sourceVersion: "1", idempotencyKey: "legacy", actorId: actor })).rejects.toMatchObject({ code: "source_snapshot_unavailable" });
    expect(await count("guardrail", "duplicate_key IS NOT NULL")).toBe(1);
    expect(await count("audit_event", "kind='guardrail.duplicated'")).toBe(1);
  });
});
