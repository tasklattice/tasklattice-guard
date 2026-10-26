// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { localBaseline } from "../../shared/local-baseline.js";
import { defaultGuardrailProfiles } from "../../shared/guardrail-profiles.js";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { expandProtectionPreset } from "../policy-catalog/presets.js";

it("ships database Profile seeds that match current capability selections and unique default categories", () => {
  const sql = readFileSync(new URL("../db/migrations/0043_capability_profiles.sql", import.meta.url), "utf8");
  const topicMigration = readFileSync(new URL("../db/migrations/0044_topic_binding_parameters.sql", import.meta.url), "utf8");
  expect(topicMigration).toContain('DELETE FROM "guardrail_profile" WHERE "id" = \'restricted-general-topics\'');
  const baselineSql = readFileSync(new URL("../db/migrations/0049_full_feature_baseline.sql", import.meta.url), "utf8");
  const seeds = [...JSON.parse(sql.split("$profiles$")[1]!), ...JSON.parse(baselineSql.split("$profiles$")[1]!)].filter((seed: { id: string }) => seed.id !== "restricted-general-topics")
    .map((seed: Record<string, unknown>, sortOrder: number) => ({ ...seed, sortOrder }));
  const localSql = readFileSync(new URL("../db/migrations/0051_local_baseline_profile.sql", import.meta.url), "utf8");
  seeds.push({ id: localBaseline.id, category: localBaseline.category, categoryName: localBaseline.categoryName, isDefault: true, sortOrder: seeds.length, definition: JSON.parse(localSql.split("$profile$")[1]!) });
  const expected = defaultGuardrailProfiles.map(({ id, category, categoryName, isDefault, ...definition }, sortOrder) =>
    ({ id, category, categoryName, isDefault, sortOrder, definition }));
  expect(seeds).toEqual(expected);
  expect(new Set(seeds.map((seed: { category: string }) => seed.category)).size).toBe(seeds.length);
  const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
  for (const profile of defaultGuardrailProfiles) {
    const bindings = expandProtectionPreset(profile, policies);
    expect(bindings.length).toBeGreaterThan(0);
    for (const binding of bindings) {
      const reference = profile.policies.find(policy => policy.policyId === binding.policyId)!;
      expect(binding.policyVersion).toBe(reference.policyVersion);
      const policy = policies.flatMap(item => [item, ...item.published_versions ?? []])
        .find(item => item.id === binding.policyId && item.version === reference.policyVersion);
      expect(policy, `${binding.policyId}@${reference.policyVersion}`).toBeDefined();
      expect(binding.enabledRuleIds.length).toBeGreaterThan(0);
      expect(binding.enabledRuleIds).toEqual(reference.enabledRuleIds ?? policy!.rules.map(rule => rule.id));
      expect(binding.enabledRuleIds.every(id => policy!.rules.some(rule => rule.id === id))).toBe(true);
    }
  }
});
