// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("Router / Endpoint database migration", () => {
  const namespace = `guard_entity_migration_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool;
  let pool: Pool;
  const read = (name: string) => readFileSync(new URL(`./migrations/${name}`, import.meta.url), "utf8");
  beforeAll(async () => {
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(new URL(url!).hostname);
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA "${namespace}"`);
    pool = new Pool({ connectionString: url, max: 1, options: `-c search_path=${namespace}` });
    const journal = JSON.parse(read("meta/_journal.json")) as { entries: { tag: string }[] };
    for (const { tag } of journal.entries.filter(({ tag }) => tag < "0008_router_endpoint")) {
      await pool.query(read(`${tag}.sql`).replaceAll('"public".', `"${namespace}".`));
    }
    await pool.query(`
      INSERT INTO guardrail (id,name,draft_config) VALUES ('guard','Guard','{}');
      INSERT INTO runner_pool (id,name) VALUES ('pool','Pool');
      INSERT INTO integration (id,name,adapter,verification) VALUES ('ep','Gateway','generic-http-guard','{"credentials":[{"id":"secret","sha256":"verifier"}]}');
      INSERT INTO guardrail_deployment (id,name,guardrail_id,pool_id,integration_id,route_order,traffic_scope) VALUES
        ('deployment-default','Default Deployment','guard','pool',NULL,0,'{}'),
        ('custom-router','Custom route','guard','pool','ep',2,'{"combinator":"and","conditions":[{"field":"integration.id","operator":"equals","value":"ep"}],"groups":[{"combinator":"or","conditions":[{"field":"http.path","operator":"equals","value":"integration.id"}]}]}');
      INSERT INTO runtime_event (id,occurred_at,request_id,runner_id,integration_id,deployment_id,direction,decision,duration_ms)
        VALUES ('event',now(),'request','runner','ep','deployment-default','incoming','allow',1);
    `);
    await pool.query("BEGIN");
    try {
      await pool.query(read("0008_router_endpoint.sql"));
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await admin?.end();
  });

  it("preserves endpoint credentials, ordered bindings, and user condition values", async () => {
    expect((await pool.query("SELECT verification FROM endpoint WHERE id='ep'")).rows[0].verification)
      .toEqual({ credentials: [{ id: "secret", sha256: "verifier" }] });
    expect((await pool.query("SELECT endpoint_id,route_order,traffic_scope FROM guardrail_router WHERE id='custom-router'")).rows[0])
      .toEqual({ endpoint_id: "ep", route_order: 2, traffic_scope: {
        combinator: "and",
        conditions: [{ field: "endpoint.id", operator: "equals", value: "ep" }],
        groups: [{ combinator: "or", conditions: [{ field: "http.path", operator: "equals", value: "integration.id" }] }],
      } });
  });
  it("updates the system fallback and telemetry references without legacy tables", async () => {
    expect((await pool.query("SELECT id,name FROM guardrail_router WHERE endpoint_id IS NULL")).rows)
      .toEqual([{ id: "router-default", name: "Default Router" }]);
    expect((await pool.query("SELECT endpoint_id,router_id FROM runtime_event")).rows)
      .toEqual([{ endpoint_id: "ep", router_id: "router-default" }]);
    expect((await pool.query("SELECT to_regclass('integration') AS endpoint_legacy, to_regclass('guardrail_deployment') AS router_legacy")).rows[0])
      .toEqual({ endpoint_legacy: null, router_legacy: null });
  });
  it("retains foreign keys and route-order uniqueness under the new names", async () => {
    await expect(pool.query("UPDATE guardrail_router SET endpoint_id='missing' WHERE id='custom-router'"))
      .rejects.toMatchObject({ code: "23503", constraint: "guardrail_router_endpoint_id_endpoint_id_fk" });
    await expect(pool.query("INSERT INTO guardrail_router (id,name,guardrail_id,pool_id,endpoint_id,route_order) VALUES ('duplicate','Duplicate','guard','pool','ep',2)"))
      .rejects.toMatchObject({ code: "23505", constraint: "router_endpoint_route_order_idx" });
  });
});
