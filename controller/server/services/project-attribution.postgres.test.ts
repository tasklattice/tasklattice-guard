// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { ControlPlaneService } from "./control-plane.js";
import { runWithProjectContext } from "./project-context.js";
import { routingEventSchema } from "./traffic-routing.js";
import type { ControllerConfig } from "../config.js";
import type { RuntimeEventInput } from "../domain/models.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("project attribution for asynchronous Runner telemetry", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let service: ControlPlaneService;
  beforeAll(async () => {
    database = await createTestDatabase(url!, "project_attribution");
    service = new ControlPlaneService(database.db, {} as ControllerConfig);
    await database.pool.query(`INSERT INTO guardrail (id,project_id,name,draft_config) VALUES ('shared-c','projectA','Owned','{}');
      INSERT INTO traffic_router (id,project_id,name,draft) VALUES ('router-a','projectA','A','{}'), ('router-c','projectC','C','{}');
      INSERT INTO endpoint (id,project_id,name,adapter) VALUES ('endpoint-a','projectA','A','litellm-generic-guardrail'), ('endpoint-c','projectC','C','litellm-generic-guardrail'), ('playground','projectB','Prefix collision','litellm-generic-guardrail');`);
  }, 30000);
  afterAll(async () => { await database?.drop(); });
  const asProject = <T>(projectId: string, callback: () => T) => runWithProjectContext({ projectId, role: "user" }, callback);
  function event(id: string, requestId: string, extra: Partial<RuntimeEventInput> = {}): RuntimeEventInput {
    return { id, requestId, occurredAt: new Date(), runnerId: "runner", guardrailId: "shared-c", guardrailVersion: "v1", direction: "incoming", decision: "allow", durationMs: 1,
      metadata: { protocol: "playground", usage: { model_calls: [{ call_id: "model-call", provider: "synthetic", model: "synthetic", usage_known: true, input_tokens: 1, output_tokens: 1 }] } }, ...extra };
  }
  it("attributes a Playground invocation and model costs to the Controller-recorded caller", async () => {
    expect((await asProject("projectA", () => service.getGuardrail("shared-c"))).projectId).toBe("projectA");
    await service.registerPlaygroundInvocation({ callId: "playground:trusted", projectId: "projectA", guardrailId: "shared-c", guardrailVersion: "v1", poolId: "pool-a", groupId: "group-a" });
    expect((await database.pool.query("SELECT pool_id, group_id FROM playground_invocation WHERE call_id='playground:trusted'")).rows)
      .toEqual([{ pool_id: "pool-a", group_id: "group-a" }]);
    await service.recordRuntimeEvents([event("shared-input", "playground:trusted"), event("shared-output", "playground:trusted", { direction: "outgoing" })]);
    const rows = (await database.pool.query("SELECT id, project_id FROM runtime_event ORDER BY id")).rows;
    const costs = (await database.pool.query("SELECT event_id, project_id FROM model_usage_cost ORDER BY event_id")).rows;
    expect(rows).toEqual([{ id: "shared-input", project_id: "projectA" }, { id: "shared-output", project_id: "projectA" }]);
    expect(costs).toEqual([{ event_id: "shared-input", project_id: "projectA" }, { event_id: "shared-output", project_id: "projectA" }]);
    await expect(asProject("projectA", () => service.getRuntimeEvent("shared-input"))).resolves.toMatchObject({ projectId: "projectA" });
    await expect(asProject("projectC", () => service.getRuntimeEvent("shared-input"))).rejects.toMatchObject({ code: "not_found" });
  });
  it("quarantines unknown, expired, conflicting and forged provenance; ignores supplied project fields", async () => {
    const now = new Date();
    await service.recordRuntimeEvents([
      event("missing", "missing", { guardrailId: "unknown" }),
      event("unknown-playground", "playground:unknown", { endpointId: "endpoint-c" }),
      event("wrong-guardrail", "playground:trusted", { guardrailId: "unknown" }),
      event("wrong-version", "playground:trusted", { guardrailVersion: "v2" }),
      event("wrong-endpoint", "playground:trusted", { endpointId: "endpoint-c" }),
      event("known-context-forged-endpoint", "playground:trusted", { endpointId: "endpoint-c", metadata: { protocol: "litellm" } }),
      event("wrong-router", "playground:trusted", { routerId: "router-c" }),
      event("wrong-protocol", "playground:trusted", { metadata: { protocol: "litellm", projectId: "projectC" } }),
      event("expired", "playground:trusted", { occurredAt: new Date(now.getTime() + 25 * 60 * 60 * 1000) }),
      event("mismatched-owner", "endpoint-call", { endpointId: "endpoint-a", routerId: "router-c" }),
      event("router-only", "router-call", { routerId: "router-c", metadata: { protocol: "litellm" } }),
      event("unknown-endpoint", "endpoint-call", { endpointId: "not-found", routerId: "router-a" }),
      event("endpoint-control", "endpoint-call", { endpointId: "endpoint-a", routerId: "router-a", metadata: { projectId: "projectC" } }),
      event("endpoint-prefix-collision", "playground:external-call", { endpointId: "playground", metadata: { protocol: "litellm" } }),
    ]);
    const rows = (await database.pool.query("SELECT id, project_id FROM runtime_event WHERE id NOT LIKE 'shared-%' ORDER BY id")).rows;
    expect(rows.find(row => row.id === "endpoint-control")?.project_id).toBe("projectA");
    expect(rows.find(row => row.id === "endpoint-prefix-collision")?.project_id).toBe("projectB");
    expect(rows.filter(row => !["endpoint-control", "endpoint-prefix-collision"].includes(row.id)).every(row => row.project_id === null)).toBe(true);
    const costs = (await database.pool.query("SELECT event_id, project_id FROM model_usage_cost WHERE event_id NOT LIKE 'shared-%'")).rows;
    expect(costs.every(row => row.project_id === null)).toBe(true);
    for (const project of ["projectA", "projectC"]) await expect(asProject(project, () => service.getRuntimeEvent("missing"))).rejects.toMatchObject({ code: "not_found" });
  });
  it("retains mappings for delayed telemetry replay while event occurrence is inside the lifetime", async () => {
    const occurredAt = new Date();
    await service.registerPlaygroundInvocation({ callId: "playground:delayed", projectId: "projectA", guardrailId: "shared-c", guardrailVersion: "v1", poolId: "pool-a", groupId: "group-a" });
    await database.pool.query("UPDATE playground_invocation SET expires_at = now() - interval '1 minute', created_at = now() - interval '1 day' WHERE call_id = 'playground:delayed'");
    await service.recordRuntimeEvents([event("replayed", "playground:delayed", { occurredAt: new Date(occurredAt.getTime() - 2 * 60 * 1000) })]);
    expect((await database.pool.query("SELECT project_id FROM runtime_event WHERE id='replayed'")).rows[0].project_id).toBe("projectA");
  });
  it("quarantines route events with conflicting owners and rejects cross-project completion poisoning", async () => {
    const makeEvent = (overrides: Record<string, unknown> = {}) => routingEventSchema.parse({ id: "route-event", eventType: "route_assignment",
      decisionId: "decision-a", callId: "call-a", runnerId: "runner", endpointId: "endpoint-a", routerId: "router-a", routerRevision: 1,
      routeId: "route", targetId: "target", guardrailId: "shared-c", guardrailVersion: "v1", occurredAt: new Date(), decisionAt: new Date(), assignmentStatus: "assigned", ...overrides });
    await service.trafficRouting.recordEvents([makeEvent(), makeEvent({ id: "unassigned", decisionId: "decision-unassigned", routerId: "", routerRevision: 0,
      routeId: "", targetId: "", guardrailId: "", guardrailVersion: "", assignmentStatus: "unassigned" }),
      makeEvent({ id: "unknown", decisionId: "decision-unknown", endpointId: "unknown", routerId: "router-a" }),
      makeEvent({ id: "mismatch", decisionId: "decision-mismatch", endpointId: "endpoint-a", routerId: "router-c", eventType: "completion", outcome: "error", durationMs: 1 })]);
    await service.trafficRouting.recordEvents([makeEvent({ id: "forged", eventType: "completion", endpointId: "endpoint-c", routerId: "router-c", outcome: "block", durationMs: 42 })]);
    const rows = (await database.pool.query("SELECT decision_id, project_id, outcome FROM route_assignment ORDER BY decision_id")).rows;
    expect(rows).toEqual([{ decision_id: "decision-a", project_id: "projectA", outcome: null },
      { decision_id: "decision-mismatch", project_id: null, outcome: "error" }, { decision_id: "decision-unassigned", project_id: "projectA", outcome: null },
      { decision_id: "decision-unknown", project_id: null, outcome: null }]);
    for (const project of ["projectA", "projectC"]) await expect(asProject(project, () => service.getRuntimeEvent("call:decision-mismatch"))).rejects.toMatchObject({ code: "not_found" });
  });
  it("prunes old mappings but quarantines late replays rather than guessing their owner", async () => {
    await database.pool.query("UPDATE playground_invocation SET expires_at = now() - interval '31 days' WHERE call_id = 'playground:delayed'");
    // A new service represents a restarted Controller and triggers hourly cleanup.
    const restarted = new ControlPlaneService(database.db, {} as ControllerConfig);
    await restarted.registerPlaygroundInvocation({ callId: "playground:new", projectId: "projectA", guardrailId: "shared-c", guardrailVersion: "v1", poolId: "pool-a", groupId: "group-a" });
    expect((await database.pool.query("SELECT 1 FROM playground_invocation WHERE call_id='playground:delayed'")).rowCount).toBe(0);
    await service.recordRuntimeEvents([event("very-late", "playground:delayed")]);
    expect((await database.pool.query("SELECT project_id FROM runtime_event WHERE id='very-late'")).rows[0].project_id).toBeNull();
  });
});
