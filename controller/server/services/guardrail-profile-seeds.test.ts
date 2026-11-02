// @vitest-environment node
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { defaultGuardrailProfiles } from "../../shared/guardrail-profiles.js";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { expandProtectionPreset } from "../policy-catalog/presets.js";

it("ships database Profile seeds that match current capability selections and unique default categories", () => {
  expect(defaultGuardrailProfiles.map(({ id, name }) => ({ id, name }))).toEqual([
    { id: "local-baseline", name: "Default" },
    { id: "full-feature-baseline", name: "Full-feature baseline" },
    { id: "banking-assistant", name: "Bank" },
    { id: "securities-assistant", name: "Securities & brokerage" },
    { id: "internet-customer-support", name: "Internet platform support" },
  ]);
  expect(new Set(defaultGuardrailProfiles.map(profile => profile.category)).size).toBe(5);
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
