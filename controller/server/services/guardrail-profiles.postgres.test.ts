// @vitest-environment node
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { readGuardrailProfiles } from "./guardrail-profiles.js";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { expandProtectionPreset } from "../policy-catalog/presets.js";
import { defaultGuardrailProfiles } from "../../shared/guardrail-profiles.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("Database-backed Guardrail Profiles", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => { database = await createTestDatabase(url!, "profiles"); });
  afterAll(async () => { await database?.drop(); });
  it("seeds exactly the five current pinned Profiles with resolvable Policies", async () => {
    const profiles = await readGuardrailProfiles(database.db);
    expect(profiles).toEqual(defaultGuardrailProfiles);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM guardrail_profile")).rows[0].count).toBe(5);
    const catalog = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets"));
    for (const profile of profiles) {
      expect(expandProtectionPreset(profile, catalog.list()).map(binding => binding.policyId)).toEqual(profile.policies.map(policy => policy.policyId));
    }
  });
  it("honors disabled and user-owned definitions when reading the catalog", async () => {
    await database.pool.query("UPDATE guardrail_profile SET enabled=false WHERE id='banking-assistant'");
    await database.pool.query(`UPDATE guardrail_profile SET is_default=false, definition=jsonb_set(definition, '{name}', '"User profile"') WHERE id='securities-assistant'`);
    const profiles = await readGuardrailProfiles(database.db);
    expect(profiles.some(profile => profile.id === "banking-assistant")).toBe(false);
    expect(profiles.find(profile => profile.id === "securities-assistant")).toMatchObject({ name: "User profile", isDefault: false });
  });
});
