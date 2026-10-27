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
import { defaultGuardrailProfiles } from "../../shared/guardrail-profiles.js";

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
    await pool.query(readFileSync(new URL("../db/migrations/0042_credential_policy_profile_version.sql", import.meta.url), "utf8"));
    await pool.query(readFileSync(new URL("../db/migrations/0043_capability_profiles.sql", import.meta.url), "utf8"));
    await pool.query(readFileSync(new URL("../db/migrations/0044_topic_binding_parameters.sql", import.meta.url), "utf8"));
    await pool.query(readFileSync(new URL("../db/migrations/0049_full_feature_baseline.sql", import.meta.url), "utf8"));
    await pool.query(readFileSync(new URL("../db/migrations/0051_local_baseline_profile.sql", import.meta.url), "utf8"));
    await pool.query(readFileSync(new URL("../db/migrations/0052_curated_guardrail_profiles.sql", import.meta.url), "utf8"));
    await pool.query(readFileSync(new URL("../db/migrations/0053_full_feature_baseline_v2.sql", import.meta.url), "utf8"));
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await admin?.end();
  });
  it("migrates fresh databases to exactly the five curated, pinned Profiles", async () => {
    const profiles = await readGuardrailProfiles(drizzle(pool, { schema }));
    expect(profiles).toEqual(defaultGuardrailProfiles);
    expect((await pool.query("SELECT count(*)::int AS count FROM guardrail_profile WHERE NOT enabled")).rows[0].count).toBe(11);
    for (const profile of profiles) expect(expandProtectionPreset(profile, catalog.list()).map(binding => binding.policyId)).toEqual(profile.policies.map(policy => policy.policyId));
  });
  it("can repeat the capability migration without re-enabling disabled Profiles or changing user-owned definitions", async () => {
    await pool.query("UPDATE guardrail_profile SET enabled=false WHERE id='banking-assistant'");
    await pool.query("UPDATE guardrail_profile SET is_default=false, definition=jsonb_set(definition, '{name}', '\"User-owned Profile\"') WHERE id='claims-assistant'");
    const customBefore = (await pool.query("SELECT definition FROM guardrail_profile WHERE id='claims-assistant'")).rows[0].definition;
    await pool.query(readFileSync(new URL("../db/migrations/0043_capability_profiles.sql", import.meta.url), "utf8"));
    await pool.query(readFileSync(new URL("../db/migrations/0044_topic_binding_parameters.sql", import.meta.url), "utf8"));
    await pool.query(readFileSync(new URL("../db/migrations/0049_full_feature_baseline.sql", import.meta.url), "utf8"));
    expect((await pool.query("SELECT enabled FROM guardrail_profile WHERE id='banking-assistant'")).rows[0].enabled).toBe(false);
    expect((await pool.query("SELECT definition FROM guardrail_profile WHERE id='claims-assistant'")).rows[0].definition).toEqual(customBefore);
    await pool.query(readFileSync(new URL("../db/migrations/0052_curated_guardrail_profiles.sql", import.meta.url), "utf8"));
  });
  it("preserves edits and disabled state when the baseline seed is replayed", async () => {
    await pool.query("UPDATE guardrail_profile SET enabled=false, definition=jsonb_set(definition, '{name}', '\"Edited baseline\"') WHERE id='full-feature-baseline'");
    await pool.query(readFileSync(new URL("../db/migrations/0049_full_feature_baseline.sql", import.meta.url), "utf8"));
    const row = (await pool.query("SELECT enabled, definition FROM guardrail_profile WHERE id='full-feature-baseline'")).rows[0];
    expect(row.enabled).toBe(false);
    expect(row.definition.name).toBe("Edited baseline");
  });
  it("upgrades only the untouched v1 baseline and never re-enables or overwrites custom definitions", async () => {
    const previous = JSON.parse(readFileSync(new URL("../db/migrations/0049_full_feature_baseline.sql", import.meta.url), "utf8").split("$profiles$")[1]!)[0].definition;
    const migration = readFileSync(new URL("../db/migrations/0053_full_feature_baseline_v2.sql", import.meta.url), "utf8");
    await pool.query("BEGIN");
    try {
      await pool.query("UPDATE guardrail_profile SET definition=$1, enabled=false WHERE id='full-feature-baseline'", [JSON.stringify(previous)]);
      await pool.query(migration);
      const upgraded = (await pool.query("SELECT * FROM guardrail_profile WHERE id='full-feature-baseline'")).rows[0];
      expect(upgraded).toMatchObject({ enabled: false, definition: { version: "2.0.0" } });
      await pool.query(migration);
      expect((await pool.query("SELECT * FROM guardrail_profile WHERE id='full-feature-baseline'")).rows[0]).toEqual(upgraded);
      const customized = structuredClone(previous);
      customized.policies.pop();
      for (const [isDefault, definition] of [[true, customized], [false, previous]] as const) {
        await pool.query("UPDATE guardrail_profile SET definition=$1, is_default=$2 WHERE id='full-feature-baseline'", [JSON.stringify(definition), isDefault]);
        await pool.query(migration);
        expect((await pool.query("SELECT definition FROM guardrail_profile WHERE id='full-feature-baseline'")).rows[0].definition).toEqual(definition);
      }
    } finally { await pool.query("ROLLBACK"); }
  });
  it("retires only built-ins and preserves disabled choices, custom rows and replayed state", async () => {
    await pool.query("UPDATE guardrail_profile SET enabled=true WHERE id='claims-assistant'");
    await pool.query("INSERT INTO guardrail_profile (id,category,category_name,is_default,definition) SELECT 'customer-profile','customer','Customer',false,definition FROM guardrail_profile WHERE id='local-baseline'");
    const before = (await pool.query("SELECT * FROM guardrail_profile ORDER BY id")).rows;
    const migration = readFileSync(new URL("../db/migrations/0052_curated_guardrail_profiles.sql", import.meta.url), "utf8");
    await pool.query(migration);
    await pool.query(migration);
    expect((await pool.query("SELECT * FROM guardrail_profile ORDER BY id")).rows).toEqual(before);
    expect((await readGuardrailProfiles(drizzle(pool, { schema }))).map(profile => profile.id)).toContain("customer-profile");
    await pool.query("DELETE FROM guardrail_profile WHERE id='customer-profile'");
    await pool.query("UPDATE guardrail_profile SET enabled=false WHERE id='claims-assistant'");
  });
  it("enforces one enabled default per category", async () => {
    await expect(pool.query("INSERT INTO guardrail_profile (id,category,category_name,is_default,definition) SELECT 'duplicate',category,category_name,true,definition FROM guardrail_profile WHERE id='local-baseline'"))
      .rejects.toMatchObject({ code: "23505", constraint: "guardrail_profile_category_default_idx" });
  });
  it("loads edited configuration and disabled state from the database on every read", async () => {
    await pool.query("UPDATE guardrail_profile SET definition = jsonb_set(jsonb_set(definition, '{name}', '\"Database edited Profile\"'), '{policies}', (definition->'policies') - 0) WHERE id='local-baseline'");
    await pool.query("UPDATE guardrail_profile SET enabled=false WHERE id='banking-assistant'");
    const profiles = await readGuardrailProfiles(drizzle(pool, { schema }));
    expect(profiles.some(profile => profile.id === "banking-assistant")).toBe(false);
    const general = profiles.find(profile => profile.id === "local-baseline")!;
    expect(general.name).toBe("Database edited Profile");
    expect(expandProtectionPreset(general, catalog.list())).toHaveLength(defaultGuardrailProfiles[0]!.policies.length - 1);
    // A fresh reader cannot reseed/overwrite database edits.
    expect((await readGuardrailProfiles(drizzle(pool, { schema })))[0]!.name).toBe("Database edited Profile");
  });
});
