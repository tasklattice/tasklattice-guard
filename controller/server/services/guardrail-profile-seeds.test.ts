// @vitest-environment node
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { guardrailProfiles } from "../../shared/guardrail-profiles.js";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { expandProtectionPreset } from "../policy-catalog/presets.js";

describe("Target Profile seeds", () => {
  it("provides exactly the five approved target Profiles with one platform default", () => {
    expect(guardrailProfiles.map(profile => profile.id)).toEqual([
      "default", "full-feature", "sg-bank", "cn-financial-services", "cn-internet",
    ]);
    expect(guardrailProfiles.filter(profile => profile.isDefault).map(profile => profile.id)).toEqual(["default"]);
    expect(guardrailProfiles.find(profile => profile.id === "full-feature")?.benchmarkOnly).toBe(true);
  });

  it("expands every seeded Profile against the shipped catalog", () => {
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    for (const profile of guardrailProfiles) {
      const bindings = expandProtectionPreset(profile, policies);
      expect(bindings.length).toBeGreaterThan(0);
      for (const binding of bindings) {
        const reference = profile.policies.find(policy => policy.policyId === binding.policyId)!;
        expect(binding.policyVersion).toBe(reference.policyVersion);
        const policy = policies.flatMap(item => [item, ...item.published_versions ?? []])
          .find(item => item.id === binding.policyId && item.version === reference.policyVersion);
        expect(policy, `${binding.policyId}@${reference.policyVersion}`).toBeDefined();
        expect(binding.enabledRuleIds.length).toBeGreaterThan(0);
        expect(binding.enabledRuleIds.every(id => policy!.rules.some(rule => rule.id === id))).toBe(true);
      }
    }
  });
});
