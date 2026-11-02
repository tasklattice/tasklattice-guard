// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "./schema.js";
import { ControlPlaneService } from "../services/control-plane.js";
import { ModelPricingService } from "../services/model-pricing.js";
import { runWithTenantContext } from "../services/tenant-context.js";
import { routingEventSchema } from "../services/traffic-routing.js";
import type { ControllerConfig } from "../config.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;

describe.skipIf(!url)("tenant migration of populated upstream Controller tables", () => {
  const namespace = `guard_tenant_migration_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool;
  let pool: Pool;
  const read = (name: string) => readFileSync(new URL(`./migrations/${name}`, import.meta.url), "utf8");

  beforeAll(async () => {
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(new URL(url!).hostname);
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA "${namespace}"`);
    pool = new Pool({ connectionString: url, max: 2, options: `-c search_path=${namespace}`, application_name: namespace });
    const journal = JSON.parse(read("meta/_journal.json")) as { entries: { tag: string }[] };
    const multiTenantIndex = journal.entries.findIndex(entry => entry.tag === "0002_multi_tenant_resources");
    expect(multiTenantIndex).toBeGreaterThanOrEqual(0);
    for (const { tag } of journal.entries.slice(0, multiTenantIndex)) {
      await pool.query(read(`${tag}.sql`).replaceAll('"public".', `"${namespace}".`));
    }
    await pool.query(`
      INSERT INTO auth_user (id,name,email,role) VALUES ('legacy-user','User','legacy@example.test','user');
      INSERT INTO policy_record (id,name,owner,draft) VALUES ('legacy-policy','Policy','legacy-user','{}');
      INSERT INTO guardrail (id,name,draft_config) VALUES ('legacy-guardrail','Guardrail','{}');
      INSERT INTO runner_pool (id,name) VALUES ('default','Default');
      INSERT INTO endpoint (id,name,adapter) VALUES ('legacy-endpoint','Endpoint','litellm-generic-guardrail');
      INSERT INTO traffic_router (id,name,draft) VALUES ('legacy-router','Router','{"routes":[]}');
      INSERT INTO model_provider (id,name,kind,base_url,credential_ciphertext) VALUES ('platform-provider','Provider','custom-openai-compatible','http://provider.invalid/v1','');
      INSERT INTO model_definition (id,provider_id,name,model) VALUES ('legacy-model','platform-provider','Model','synthetic');
      INSERT INTO model_configuration_revision (id,revision,assignments) VALUES ('legacy-revision',1,'{"controlPlane":null,"bindings":{}}');
      INSERT INTO runtime_event (id,occurred_at,request_id,runner_id,direction,decision,duration_ms) VALUES ('legacy-event',now(),'request','runner','incoming','allow',1);
      INSERT INTO model_usage_cost (id,event_id,guardrail_id,model,provider,source,occurred_at,reason) VALUES ('legacy-cost','missing-cost-only-event','legacy-guardrail','model','provider','testing',now(),'unmatched_model');
      INSERT INTO route_assignment (decision_id,call_id,assignment_status,router_id,router_revision,route_id,target_id,guardrail_id,guardrail_version,endpoint_id,occurred_at)
        VALUES ('legacy-route','request','assigned','legacy-router',1,'route','target','legacy-guardrail','v1','legacy-endpoint',date_trunc('milliseconds', now()));
      INSERT INTO audit_event (id,kind,actor_id,resource_type,resource_id) VALUES ('legacy-audit','created','legacy-user','guardrail','legacy-guardrail');
    `);
    await pool.query(read("0002_multi_tenant_resources.sql"));
    // Continue the real migration order after testing an upgrade of populated legacy tables.
    for (const { tag } of journal.entries.slice(multiTenantIndex + 1)) {
      if (tag === "0005_quarantine_historical_telemetry") await pool.query(`
        INSERT INTO runtime_event (id,tenant_id,occurred_at,request_id,runner_id,direction,decision,duration_ms)
          VALUES ('legacy-c','tenantC',now(),'playground:old','runner','incoming','allow',1)
      `);
      if (tag === "0006_playground_invocation_pool") await pool.query(`
        INSERT INTO playground_invocation (call_id,tenant_id,guardrail_id,guardrail_version,expires_at)
          VALUES ('playground:old','tenantA','legacy-guardrail','v1',now() + interval '1 day')
      `);
      await pool.query(read(`${tag}.sql`).replaceAll('"public".', `"${namespace}".`));
    }
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await admin?.end();
  });

  it("backfills existing resources while keeping Providers platform-managed", async () => {
    for (const table of ["auth_user", "policy_record", "guardrail", "endpoint", "traffic_router", "model_configuration_revision"]) {
      expect((await pool.query(`SELECT DISTINCT tenant_id FROM "${table}"`)).rows, table)
        .toEqual([{ tenant_id: "tenantA" }]);
    }
    expect((await pool.query("SELECT id FROM tenant ORDER BY id")).rows).toEqual([{ id: "tenantA" }, { id: "tenantB" }, { id: "tenantC" }]);
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='model_provider' AND column_name='tenant_id'", [namespace])).rows).toEqual([]);
    expect((await pool.query("SELECT tenant_id FROM model_definition WHERE id='legacy-model'")).rows).toEqual([{ tenant_id: null }]);
    await pool.query("INSERT INTO model_definition (id,tenant_id,provider_id,name,model) VALUES ('model-b','tenantB','platform-provider','B Model','synthetic')");
    expect((await pool.query("SELECT tenant_id FROM model_definition WHERE model='synthetic' ORDER BY tenant_id NULLS FIRST")).rows)
      .toEqual([{ tenant_id: null }, { tenant_id: "tenantB" }]);
  });

  it("quarantines old audit ownership and leaves new owner-derived events intact on replay", async () => {
    expect((await pool.query("SELECT tenant_id FROM audit_event WHERE id='legacy-audit'")).rows).toEqual([{ tenant_id: null }]);
    expect((await pool.query("SELECT previous_tenant_id FROM historical_audit_attribution WHERE audit_id='legacy-audit'")).rows)
      .toEqual([{ previous_tenant_id: "tenantA" }]);
    await pool.query("INSERT INTO audit_event (id,kind,resource_type,resource_id) VALUES ('new-audit','updated','guardrail','legacy-guardrail')");
    await pool.query(read("0007_audit_attribution_quarantine.sql"));
    expect((await pool.query("SELECT tenant_id FROM audit_event WHERE id='new-audit'")).rows).toEqual([{ tenant_id: "tenantA" }]);
    expect((await pool.query("SELECT count(*)::int AS count FROM historical_audit_attribution WHERE audit_id='new-audit'")).rows).toEqual([{ count: 0 }]);
  });

  it("attributes actorless Policy and Router audit events to their owner", async () => {
    await pool.query("INSERT INTO policy_resource (id,tenant_id,definition,maintainer) VALUES ('policy-b','tenantB','{}','B')");
    await pool.query("INSERT INTO traffic_router (id,tenant_id,name,draft) VALUES ('router-b','tenantB','B','{\"routes\":[]}')");
    await pool.query("INSERT INTO audit_event (id,kind,resource_type,resource_id) VALUES ('policy-b-audit','updated','policy','policy-b'), ('router-b-audit','updated','router','router-b')");
    expect((await pool.query("SELECT tenant_id FROM audit_event WHERE id IN ('policy-b-audit','router-b-audit') ORDER BY id")).rows)
      .toEqual([{ tenant_id: "tenantB" }, { tenant_id: "tenantB" }]);
  });

  it("quarantines legacy telemetry and retains its former assignment for operator review", async () => {
    for (const [table, idColumn, id] of [["runtime_event", "id", "legacy-event"], ["model_usage_cost", "id", "legacy-cost"], ["route_assignment", "decision_id", "legacy-route"]]) {
      expect((await pool.query(`SELECT tenant_id FROM "${table}" WHERE "${idColumn}"=$1`, [id])).rows).toEqual([{ tenant_id: null }]);
    }
    expect((await pool.query("SELECT resource_type, resource_id, previous_tenant_id FROM historical_telemetry_attribution ORDER BY resource_type, resource_id")).rows).toEqual([
      { resource_type: "model_usage_cost", resource_id: "legacy-cost", previous_tenant_id: "tenantA" },
      { resource_type: "route_assignment", resource_id: "legacy-route", previous_tenant_id: "tenantA" },
      { resource_type: "runtime_event", resource_id: "legacy-c", previous_tenant_id: "tenantC" },
      { resource_type: "runtime_event", resource_id: "legacy-event", previous_tenant_id: "tenantA" },
    ]);
    const db = drizzle(pool, { schema });
    const controlPlane = new ControlPlaneService(db, {} as ControllerConfig);
    await expect(runWithTenantContext({ tenantId: "tenantA", role: "user" }, () => controlPlane.getRuntimeEvent("legacy-event"))).rejects.toMatchObject({ code: "not_found" });
    await expect(runWithTenantContext({ tenantId: "tenantC", role: "user" }, () => controlPlane.getRuntimeEvent("legacy-c"))).rejects.toMatchObject({ code: "not_found" });
    await expect(controlPlane.getRuntimeEvent("legacy-event")).resolves.toMatchObject({ tenantId: null });
    const pricing = new ModelPricingService(db);
    const tenantCosts = await runWithTenantContext({ tenantId: "tenantA", role: "user" }, () => pricing.monthlyCosts(["legacy-guardrail"]));
    const platformCosts = await pricing.monthlyCosts(["legacy-guardrail"]);
    expect(tenantCosts.get("legacy-guardrail")?.calls).toBe(0);
    expect(platformCosts.get("legacy-guardrail")?.calls).toBe(1);
    await pool.query("INSERT INTO runtime_event (id,occurred_at,request_id,runner_id,direction,decision,duration_ms) VALUES ('unattributed',now(),'unknown','runner','incoming','allow',1)");
    expect((await pool.query("SELECT tenant_id FROM runtime_event WHERE id='unattributed'")).rows).toEqual([{ tenant_id: null }]);
  });

  it("keeps old invocation allocation unknown and requires pool and group together", async () => {
    expect((await pool.query("SELECT pool_id, group_id FROM playground_invocation WHERE call_id='playground:old'")).rows)
      .toEqual([{ pool_id: null, group_id: null }]);
    await expect(pool.query("INSERT INTO playground_invocation (call_id,tenant_id,guardrail_id,guardrail_version,pool_id,expires_at) VALUES ('invalid','tenantA','legacy-guardrail','v1','pool-a',now())"))
      .rejects.toMatchObject({ code: "23514" });
    await pool.query("INSERT INTO playground_invocation (call_id,tenant_id,guardrail_id,guardrail_version,pool_id,group_id,expires_at) VALUES ('playground:new','tenantA','legacy-guardrail','v1','pool-a','group-a',now())");
    await pool.query(read("0006_playground_invocation_pool.sql"));
    expect((await pool.query("SELECT call_id, pool_id, group_id FROM playground_invocation ORDER BY call_id")).rows).toEqual([
      { call_id: "playground:new", pool_id: "pool-a", group_id: "group-a" },
      { call_id: "playground:old", pool_id: null, group_id: null },
    ]);
  });

  it("does not quarantine new records if the historical migration is replayed", async () => {
    await pool.query("INSERT INTO runtime_event (id,tenant_id,occurred_at,request_id,runner_id,direction,decision,duration_ms) VALUES ('new-event','tenantB',now(),'new','runner','incoming','allow',1)");
    await pool.query(read("0005_quarantine_historical_telemetry.sql"));
    expect((await pool.query("SELECT tenant_id FROM runtime_event WHERE id='new-event'")).rows).toEqual([{ tenant_id: "tenantB" }]);
    expect((await pool.query("SELECT count(*)::int AS count FROM historical_telemetry_attribution WHERE resource_id='new-event'")).rows).toEqual([{ count: 0 }]);
  });

  it("accepts matching late completion without unquarantining and rejects changed identity", async () => {
    const db = drizzle(pool, { schema });
    const service = new ControlPlaneService(db, {} as ControllerConfig);
    const [{ occurred_at: decisionAt }] = (await pool.query("SELECT occurred_at FROM route_assignment WHERE decision_id='legacy-route'")).rows;
    const base = { id: "late", eventType: "completion", decisionId: "legacy-route", callId: "request", runnerId: "runner",
      endpointId: "legacy-endpoint", routerId: "legacy-router", routerRevision: 1, routeId: "route", targetId: "target",
      guardrailId: "legacy-guardrail", guardrailVersion: "v1", occurredAt: new Date(), decisionAt,
      assignmentStatus: "assigned", outcome: "error", durationMs: 100 };
    const changes = [
      { callId: "forged" }, { endpointId: "forged" }, { routerId: "forged" }, { routerRevision: 2 },
      { routeId: "forged" }, { targetId: "forged" }, { guardrailId: "forged" }, { guardrailVersion: "v2" },
      { assignmentStatus: "unassigned" }, { decisionAt: new Date(decisionAt.getTime() - 1000) },
    ];
    await service.trafficRouting.recordEvents(changes.map(change => routingEventSchema.parse({ ...base, ...change })));
    expect((await pool.query("SELECT tenant_id, completed_at, outcome FROM route_assignment WHERE decision_id='legacy-route'")).rows)
      .toEqual([{ tenant_id: null, completed_at: null, outcome: null }]);
    await service.trafficRouting.recordEvents([routingEventSchema.parse(base)]);
    expect((await pool.query("SELECT tenant_id, outcome, duration_ms FROM route_assignment WHERE decision_id='legacy-route'")).rows)
      .toEqual([{ tenant_id: null, outcome: "error", duration_ms: 100 }]);
    await expect(runWithTenantContext({ tenantId: "tenantA", role: "user" }, () => service.getRuntimeEvent("call:legacy-route"))).rejects.toMatchObject({ code: "not_found" });
    await expect(service.getRuntimeEvent("call:legacy-route")).resolves.toMatchObject({ tenantId: null, decision: "error" });
  });

  it("rolls back preserved assignments and quarantine together on failure", async () => {
    await pool.query(`DELETE FROM historical_telemetry_quarantine_checkpoint WHERE id='0052';
      CREATE FUNCTION reject_route_quarantine() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$;
      UPDATE route_assignment SET tenant_id='tenantB' WHERE decision_id='legacy-route';
      CREATE TRIGGER reject_route_quarantine BEFORE UPDATE ON route_assignment FOR EACH ROW EXECUTE FUNCTION reject_route_quarantine()`);
    await expect(pool.query(read("0005_quarantine_historical_telemetry.sql"))).rejects.toThrow("test failure");
    expect((await pool.query("SELECT tenant_id FROM runtime_event WHERE id='new-event'")).rows).toEqual([{ tenant_id: "tenantB" }]);
    expect((await pool.query("SELECT count(*)::int AS count FROM historical_telemetry_attribution WHERE resource_id='new-event'")).rows).toEqual([{ count: 0 }]);
    expect((await pool.query("SELECT count(*)::int AS count FROM historical_telemetry_quarantine_checkpoint WHERE id='0052'")).rows).toEqual([{ count: 0 }]);
  });

  it("can be replayed without changing existing tenant ownership", async () => {
    await pool.query(read("0002_multi_tenant_resources.sql"));
    expect((await pool.query("SELECT tenant_id FROM model_definition WHERE id='model-b'")).rows).toEqual([{ tenant_id: "tenantB" }]);
    expect((await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND indexname='runtime_event_guardrail_time_id_idx'", [namespace])).rows).toHaveLength(1);
  });
});
