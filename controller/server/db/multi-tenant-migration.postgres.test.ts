// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
    for (const { tag } of journal.entries.filter(entry => entry.tag !== "0049_multi_tenant_resources")) {
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
      INSERT INTO audit_event (id,kind,actor_id,resource_type,resource_id) VALUES ('legacy-audit','created','legacy-user','guardrail','legacy-guardrail');
    `);
    await pool.query(read("0049_multi_tenant_resources.sql"));
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await admin?.end();
  });

  it("backfills existing resources while keeping Providers platform-managed", async () => {
    for (const table of ["auth_user", "policy_record", "guardrail", "endpoint", "traffic_router", "model_configuration_revision", "runtime_event", "audit_event"]) {
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

  it("attributes actorless Policy and Router audit events to their owner", async () => {
    await pool.query("INSERT INTO policy_resource (id,tenant_id,definition,maintainer) VALUES ('policy-b','tenantB','{}','B')");
    await pool.query("INSERT INTO traffic_router (id,tenant_id,name,draft) VALUES ('router-b','tenantB','B','{\"routes\":[]}')");
    await pool.query("INSERT INTO audit_event (id,kind,resource_type,resource_id) VALUES ('policy-b-audit','updated','policy','policy-b'), ('router-b-audit','updated','router','router-b')");
    expect((await pool.query("SELECT tenant_id FROM audit_event WHERE id IN ('policy-b-audit','router-b-audit') ORDER BY id")).rows)
      .toEqual([{ tenant_id: "tenantB" }, { tenant_id: "tenantB" }]);
  });

  it("can be replayed without changing existing tenant ownership", async () => {
    await pool.query(read("0049_multi_tenant_resources.sql"));
    expect((await pool.query("SELECT tenant_id FROM model_definition WHERE id='model-b'")).rows).toEqual([{ tenant_id: "tenantB" }]);
    expect((await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND indexname='runtime_event_guardrail_time_id_idx'", [namespace])).rows).toHaveLength(1);
  });
});
