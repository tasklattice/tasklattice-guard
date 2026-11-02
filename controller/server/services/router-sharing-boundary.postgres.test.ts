// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RouterDraft } from "../../shared/traffic-routing.js";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { runWithTenantContext } from "./tenant-context.js";
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
  const asA = <T>(fn: () => T) => runWithTenantContext({ tenantId: "tenantA", actorId: "user-a", role: "user" }, fn);
  const asB = <T>(fn: () => T) => runWithTenantContext({ tenantId: "tenantB", actorId: "user-b", role: "user" }, fn);
  const asC = <T>(fn: () => T) => runWithTenantContext({ tenantId: "tenantC", actorId: "user-c", role: "user" }, fn);
  const asAdmin = <T>(fn: () => T) => runWithTenantContext({ tenantId: "tenantA", actorId: "admin", role: "admin" }, fn);

  beforeAll(async () => {
    database = await createTestDatabase(url!, "router_share_refs");
    service = new TrafficRoutingService(database.db);
    const pool = database.pool;
    await pool.query(`INSERT INTO auth_user (id,name,email,role,tenant_id) VALUES
      ('user-a','A','router-a@example.test','user','tenantA'), ('user-b','B','router-b@example.test','user','tenantB'),
      ('user-c','C','router-c@example.test','user','tenantC'), ('admin','Admin','router-admin@example.test','admin','tenantA');
      INSERT INTO guardrail (id,tenant_id,name,draft_config) VALUES
      ('guard-private','tenantB','Private Guardrail','{}'), ('guard-own','tenantA','Own Guardrail','{}');`);
    await pool.query("INSERT INTO traffic_router (id,tenant_id,name,draft,active_revision,active_snapshot,rollout_error) VALUES ('router-b','tenantB','B Router',$1,1,$1,'runner failed: guard-private Private Endpoint')", [JSON.stringify(snapshot)]);
    await pool.query("INSERT INTO endpoint (id,tenant_id,name,adapter,traffic_router_id) VALUES ('endpoint-private','tenantB','Private Endpoint','litellm-generic-guardrail','router-b')");
    await pool.query("INSERT INTO traffic_router_change_request (id,router_id,kind,status,snapshot,endpoint_ids,context,reason,submitted_by) VALUES ('change-b','router-b','publish','pending',$1,$2,$3,'Change','user-b')",
      [JSON.stringify(snapshot), JSON.stringify(["endpoint-private"]), JSON.stringify(context)]);
    await pool.query("INSERT INTO traffic_router_revision (router_id,revision,source_draft_revision,request_draft_revision,snapshot,idempotency_key,created_by,context) VALUES ('router-b',1,1,1,$1,'key','user-b',$2)",
      [JSON.stringify(snapshot), JSON.stringify(context)]);
    await pool.query(`
      INSERT INTO resource_share (id,owner_tenant_id,recipient_tenant_id,resource_type,resource_id) VALUES
      ('router-share','tenantB','tenantA','router','router-b'),
      ('guard-owner-share','tenantA','tenantB','guardrail','guard-own');`);
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

  it("does not transitively reveal private Endpoints or Guardrails through a Router share", async () => {
    expectNoPrivate(await asA(views));
    expectNoPrivate(await asA(() => service.list()));
    await expect(asC(() => service.get("router-b"))).rejects.toMatchObject({ code: "not_found" });
    const owner = serialized(await asB(views));
    expect(owner).toContain("endpoint-private");
    expect(owner).toContain("Private Guardrail");
    expect(owner).toContain("Own Guardrail");
    const admin = serialized(await asAdmin(views));
    expect(admin).toContain("Private Endpoint");
    expect(admin).toContain("endpoint-missing");
    expect(admin).toContain("Private Guardrail");
  });

  it("reveals only explicitly shared references and redacts them again on revocation", async () => {
    await database.pool.query(`INSERT INTO resource_share (id,owner_tenant_id,recipient_tenant_id,resource_type,resource_id) VALUES
      ('endpoint-share','tenantB','tenantA','endpoint','endpoint-private'),
      ('guard-share','tenantB','tenantA','guardrail','guard-private')`);
    const shared = serialized(await asA(views));
    expect(shared).toContain("endpoint-private");
    expect(shared).toContain("Private Endpoint");
    expect(shared).toContain("guard-private");
    expect(shared).toContain("Private Guardrail");
    await database.pool.query("DELETE FROM resource_share WHERE id IN ('endpoint-share','guard-share')");
    expectNoPrivate(await asA(views));
  });

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
