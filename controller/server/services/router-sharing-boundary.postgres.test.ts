// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RouterDraft } from "../../shared/traffic-routing.js";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { runWithProjectContext } from "./project-context.js";
import { TrafficRoutingService } from "./traffic-routing.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
const snapshot: RouterDraft = { routes: [{ id: "r", name: "Route", kind: "normal", enabled: true,
  selector: { expression: { combinator: "and", conditions: [{ combinator: "or", conditions: [
    { field: "endpoint.id", operator: "in", value: ["endpoint-private", "endpoint-missing"] },
    { field: "auth.principal", operator: "equals", value: "endpoint-private" },
  ] }] } }, targets: [
    { id: "target-private", guardrailId: "guard-private", guardrailVersion: "1", weightBps: 5000 },
    { id: "target-own", guardrailId: "guard-own", guardrailVersion: "1", weightBps: 5000 },
  ] }, { id: "fallback", name: "Fallback", kind: "fallback", enabled: true,
    selector: { expression: { combinator: "and", conditions: [] } },
    targets: [{ id: "target-fallback", guardrailId: "guard-own", guardrailVersion: "1", weightBps: 10000 }],
  }] };
const context = { endpoints: [{ id: "endpoint-private", name: "Private Endpoint", adapter: "litellm-generic-guardrail" }],
  guardrails: [{ id: "guard-private", name: "Private Guardrail", version: "1" }, { id: "guard-own", name: "Own Guardrail", version: "1" }] };

describe.skipIf(!url)("shared Router reference visibility", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let service: TrafficRoutingService;
  const asA = <T>(fn: () => T) => runWithProjectContext({ projectId: "projectA", actorId: "user-a", role: "user" }, fn);
  const asB = <T>(fn: () => T) => runWithProjectContext({ projectId: "projectB", actorId: "user-b", role: "user" }, fn);
  const asC = <T>(fn: () => T) => runWithProjectContext({ projectId: "projectC", actorId: "user-c", role: "user" }, fn);
  const asAdmin = <T>(fn: () => T) => runWithProjectContext({ projectId: "projectA", actorId: "admin", role: "admin" }, fn);

  beforeAll(async () => {
    database = await createTestDatabase(url!, "router_share_refs");
    service = new TrafficRoutingService(database.db);
    const pool = database.pool;
    await pool.query(`INSERT INTO auth_user (id,username,email,role) SELECT id,name,email,role FROM (VALUES ('user-a','A','router-a@example.test','user','projectA'),('user-b','B','router-b@example.test','user','projectB'),('user-c','C','router-c@example.test','user','projectC'),('admin','Admin','router-admin@example.test','admin','projectA')) AS fixture(id,name,email,role,project_id);
      INSERT INTO guardrail (id,project_id,name,draft_config) VALUES
      ('guard-private','projectB','Private Guardrail','{}'), ('guard-own','projectA','Own Guardrail','{}');`);
    await pool.query("INSERT INTO traffic_router (id,project_id,name,draft,active_revision,active_snapshot,rollout_error) VALUES ('router-b','projectB','B Router',$1,1,$1,'runner failed: guard-private Private Endpoint')", [JSON.stringify(snapshot)]);
    await pool.query("INSERT INTO endpoint (id,project_id,name,adapter,traffic_router_id) VALUES ('endpoint-private','projectB','Private Endpoint','litellm-generic-guardrail','router-b')");
    await pool.query("INSERT INTO traffic_router_change_request (id,router_id,kind,status,snapshot,endpoint_ids,context,reason,submitted_by) VALUES ('change-b','router-b','publish','pending',$1,$2,$3,'Change','user-b')",
      [JSON.stringify(snapshot), JSON.stringify(["endpoint-private"]), JSON.stringify(context)]);
    await pool.query("INSERT INTO traffic_router_revision (router_id,revision,source_draft_revision,request_draft_revision,snapshot,idempotency_key,created_by,context) VALUES ('router-b',1,1,1,$1,'key','user-b',$2)",
      [JSON.stringify(snapshot), JSON.stringify(context)]);
    await pool.query(`
      INSERT INTO resource_share (id,owner_project_id,recipient_project_id,resource_type,resource_id) VALUES
      ('router-share','projectB','projectA','router','router-b'),
      ('guard-owner-share','projectA','projectB','guardrail','guard-own');`);
  }, 30000);
  afterAll(async () => { await database?.drop(); });

  async function views() {
    const [router, changes, revisions, distribution] = await Promise.all([
      service.get("router-b"), service.changeRequests("router-b"), service.revisions("router-b"), service.distribution("router-b", 1),
    ]);
    return { router, changes, revisions, distribution };
  }
  const serialized = (value: unknown) => JSON.stringify(value);
  function expectNoPrivate(value: unknown) {
    const data = serialized(value);
    for (const privateValue of ["endpoint-private", "Private Endpoint", "guard-private", "Private Guardrail", "target-private"]) {
      expect(data).not.toContain(privateValue);
    }
    expect(data).toContain("guard-own");
    // Values that are not Endpoint IDs, such as a selector prefix or a
    // principal from another authentication system, are part of the Router.
    expect(data).toContain("endpoint-missing");
    expect(data).toContain("[restricted]");
  }

  it("does not reveal a revoked Guardrail ID through Router publication validation", async () => {
    await database.pool.query("DELETE FROM resource_share WHERE id='guard-owner-share'");
    try {
      await asB(() => service.preview("router-b", 1));
      throw new Error("Expected preview to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "validation_failed" });
      expect(String(error)).not.toContain("guard-own");
      expect(String(error)).not.toContain("Own Guardrail");
    }
    const view = serialized(await asB(views));
    expect(view).not.toContain("guard-own");
    expect(view).not.toContain("Own Guardrail");
  });
});
