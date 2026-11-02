// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("Tenant Group migration of populated pre-group tables", () => {
  const namespace = `tenant_group_upgrade_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool;
  const read = (name: string) => readFileSync(new URL(`./migrations/${name}`, import.meta.url), "utf8").replaceAll('"public".', `"${namespace}".`);
  beforeAll(async () => {
    expect(["localhost", "127.0.0.1", "[::1]"]).toContain(new URL(url!).hostname);
    admin = new Pool({ connectionString: url, max: 1 }); await admin.query(`CREATE SCHEMA "${namespace}"`);
    pool = new Pool({ connectionString: url, max: 1, options: `-c search_path=${namespace}` });
    const journal = JSON.parse(read("meta/_journal.json")) as { entries: Array<{ idx: number; tag: string }> };
    for (const entry of journal.entries.filter(entry => entry.idx < 50)) await pool.query(read(`${entry.tag}.sql`));
    await pool.query("INSERT INTO runner_pool(id,name,is_default) VALUES ('default','Default',true),('legacy-extra','Legacy pool',false)");
    await pool.query(read("0050_tenant_groups.sql"));
  }, 30000);
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await admin.end(); } });
  it("preserves every existing Tenant and Runner pool while assigning exactly one Default group", async () => {
    expect((await pool.query("SELECT id,group_id FROM tenant ORDER BY id")).rows).toEqual([
      { id: "tenantA", group_id: "default" }, { id: "tenantB", group_id: "default" }, { id: "tenantC", group_id: "default" } ]);
    expect((await pool.query("SELECT id,group_id,runtime_url,public_url FROM runner_pool ORDER BY id")).rows).toEqual([
      { id: "default", group_id: "default", runtime_url: null, public_url: null },
      { id: "legacy-extra", group_id: "default", runtime_url: null, public_url: null } ]);
  });
  it("can be replayed without overwriting later group allocations", async () => {
    await pool.query("INSERT INTO tenant_group(id,name) VALUES ('team-a','A'); UPDATE tenant SET group_id='team-a' WHERE id='tenantB'; UPDATE runner_pool SET group_id='team-a' WHERE id='legacy-extra'");
    await pool.query(read("0050_tenant_groups.sql"));
    expect((await pool.query("SELECT group_id FROM tenant WHERE id='tenantB'")).rows).toEqual([{ group_id: "team-a" }]);
    expect((await pool.query("SELECT group_id FROM runner_pool WHERE id='legacy-extra'")).rows).toEqual([{ group_id: "team-a" }]);
  });
});
