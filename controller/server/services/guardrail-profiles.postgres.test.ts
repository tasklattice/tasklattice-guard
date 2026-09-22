// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../db/schema.js";
import { readGuardrailProfiles } from "./guardrail-profiles.js";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { expandProtectionPreset } from "../policy-catalog/presets.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("Database-backed Guardrail Profiles", () => {
  const namespace = `guard_profiles_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool;
  let pool: Pool;
  const catalog = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets"));
  beforeAll(async () => {
    expect(["localhost", "127.0.0.1", "[::1]"]).toContain(new URL(url!).hostname);
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA "${namespace}"`);
    pool = new Pool({ connectionString: url, max: 1, options: `-c search_path=${namespace}` });
    await pool.query(readFileSync(new URL("../db/migrations/0013_guardrail_profiles.sql", import.meta.url), "utf8"));
    await pool.query(readFileSync(new URL("../db/migrations/0015_china_mainland_guardrail_profiles.sql", import.meta.url), "utf8"));
    await pool.query(readFileSync(new URL("../db/migrations/0016_retire_unverified_singapore_financial_policies.sql", import.meta.url), "utf8"));
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await admin?.end();
  });
  it("seeds one default for each supported industry or use case with pinned executable bindings", async () => {
    const profiles = await readGuardrailProfiles(drizzle(pool, { schema }));
    expect(profiles).toHaveLength(7);
    expect(new Set(profiles.map(profile => profile.category)).size).toBe(7);
    expect(profiles.every(profile => profile.isDefault)).toBe(true);
    for (const profile of profiles) expect(expandProtectionPreset(profile, catalog.list()).map(binding => binding.policyId)).toEqual(profile.policies.map(policy => policy.policyId));
    const singapore = profiles.find(profile => profile.id === "singapore-financial-assistant")!;
    expect(singapore.version).toBe("1.0.1");
    expect(singapore.policies.some(policy => policy.policyId === "singapore-financial-conduct")).toBe(false);
    expect(singapore.limitations.join(" ")).toContain("No MAS-specific control");
  });
  it("enforces one enabled default per category", async () => {
    await expect(pool.query("INSERT INTO guardrail_profile (id,category,category_name,is_default,definition) SELECT 'duplicate',category,category_name,true,definition FROM guardrail_profile WHERE id='common-baseline'"))
      .rejects.toMatchObject({ code: "23505", constraint: "guardrail_profile_category_default_idx" });
  });
  it("loads edited configuration and disabled state from the database on every read", async () => {
    await pool.query("UPDATE guardrail_profile SET definition = jsonb_set(jsonb_set(definition, '{name}', '\"Database edited Profile\"'), '{policies}', (definition->'policies') - 0) WHERE id='common-baseline'");
    await pool.query("UPDATE guardrail_profile SET enabled=false WHERE id='banking-assistant'");
    const profiles = await readGuardrailProfiles(drizzle(pool, { schema }));
    expect(profiles.some(profile => profile.id === "banking-assistant")).toBe(false);
    const general = profiles.find(profile => profile.id === "common-baseline")!;
    expect(general.name).toBe("Database edited Profile");
    expect(expandProtectionPreset(general, catalog.list())).toHaveLength(15);
    // A fresh reader cannot reseed/overwrite database edits.
    expect((await readGuardrailProfiles(drizzle(pool, { schema })))[0]!.name).toBe("Database edited Profile");
  });
});
