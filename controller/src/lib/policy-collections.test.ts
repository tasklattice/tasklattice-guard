import { describe, expect, it } from "vitest";
import { PolicyCatalog } from "../../server/policy-catalog/catalog";
import { expandProtectionPreset } from "../../server/policy-catalog/presets";
import { defaultGuardrailProfiles } from "../../shared/guardrail-profiles";
import type { Policy } from "./api";
import { collectionAsPolicy, policyCollections } from "./policy-collections";
import { policyComplianceSchema } from "../../shared/policy-compliance";

const catalog = PolicyCatalog.load("../runner/toolkit/policy_library/assets").list();
const policies = catalog as unknown as Policy[];
const profiles = defaultGuardrailProfiles.map(profile => ({ ...profile,
  bindings: expandProtectionPreset(profile, catalog).map(binding => ({
    policy_id: binding.policyId, policy_version: binding.policyVersion, enabled_rule_ids: binding.enabledRuleIds,
    rule_order: binding.ruleOrder, enabled_rails: binding.enabledRails, parameter_values: binding.parameterValues,
    rule_actions: binding.ruleActions ?? {}, action: binding.action,
  })),
}));

describe("Policy set discovery", () => {
  it("resolves every enabled Profile to its exact canonical Rules, retaining all 5 regions and reviewed frameworks", () => {
    const sets = policyCollections(profiles, policies);
    expect(sets).toHaveLength(defaultGuardrailProfiles.length);
    expect(sets.flatMap(set => set.unavailable)).toEqual([]);
    expect([...new Set(sets.flatMap(set => set.tags.filter(tag => tag.namespace === "jurisdiction").map(tag => tag.value)))].sort()).toEqual(["au", "cn", "eu", "sg", "uae"]);
    for (const set of sets) {
      expect(set.ruleCount).toBe(set.profile.bindings.reduce((count, binding) => count + binding.enabled_rule_ids.length, 0));
      for (const group of set.groups) expect(group.rules.map(rule => rule.id)).toEqual(group.binding.rule_order);
    }
    expect(sets.find(set => set.id === "singapore-data-protection")?.tags.map(tag => tag.id)).toEqual(["jurisdiction:sg", "framework:pdpa"]);
    expect(sets.find(set => set.id === "eu-data-protection")?.tags.map(tag => tag.id)).toEqual(["jurisdiction:eu", "framework:gdpr"]);
  });

  it("does not inherit other regions/frameworks from broadly shared capability Policies", () => {
    const singapore = policyCollections(profiles, policies).find(set => set.id === "singapore-data-protection")!;
    expect(singapore.groups.some(group => group.policy?.tags.some(tag => tag.value === "eu"))).toBe(true);
    expect(singapore.tags.some(tag => ["eu", "gdpr"].includes(tag.value))).toBe(false);
    const unknown = policyCollections([{ ...profiles[0], id: "customer-set", jurisdictions: ["singapore"], bindings: singapore.profile.bindings }], policies)[0];
    expect(unknown.tags.map(tag => tag.id)).toEqual(["jurisdiction:sg"]);
  });

  it("never substitutes latest Rules for missing pinned versions and reports missing Rule IDs", () => {
    const profile = structuredClone(profiles[0]);
    profile.bindings[0].policy_version = "unavailable";
    profile.bindings[1].enabled_rule_ids.push("missing-rule");
    const set = policyCollections([profile], policies)[0];
    expect(set.unavailable).toEqual([`${profile.bindings[0].policy_id}@unavailable`, `${profile.bindings[1].policy_id}/missing-rule`]);
    expect(set.groups[0].rules).toEqual([]);
  });

  it("presents regional Policies as flat Rules, selected tests and version-matched compliance", () => {
    for (const collection of policyCollections(profiles, policies)) {
      const before = JSON.stringify(collection);
      const detail = collectionAsPolicy(collection);
      expect(detail.rules).toHaveLength(collection.ruleCount);
      expect(detail.tags).toEqual(collection.tags);
      expect(detail.rules.map(rule => rule.id)).toEqual(collection.groups.flatMap(group => group.rules.map(rule => rule.id)));
      const ids = new Set(detail.rules.map(rule => rule.id));
      expect(detail.test_count).toBe(detail.test_cases.length);
      for (const test of detail.test_cases) expect(test.covered_rule_ids.every(id => ids.has(id))).toBe(true);
      expect(policyComplianceSchema.safeParse(detail.compliance).success).toBe(true);
      expect(detail.compliance?.policy_version).toBe(detail.version);
      expect(detail.compliance?.review.status).toBe("pending");
      for (const entry of [...detail.compliance!.coverage, ...detail.compliance!.references]) expect(entry.rule_ids.every(id => ids.has(id))).toBe(true);
      expect(JSON.stringify(collection)).toBe(before);
    }
    const singapore = collectionAsPolicy(policyCollections(profiles, policies).find(set => set.id === "singapore-financial-assistant")!);
    expect(singapore.rules).toHaveLength(49);
    expect(singapore.test_count).toBeGreaterThan(49);
    expect(singapore.test_cases.some(test => test.covered_rule_ids.includes("pattern/sg_nric"))).toBe(true);
    expect(singapore.test_cases.some(test => test.covered_rule_ids.includes("au-pii-tax-identifiers/au_tfn"))).toBe(false);
    expect(singapore.compliance!.references.some(ref => ref.title === "Personal Data Protection Act")).toBe(true);
  });

  it("retains effective actions, rails and unambiguous Rule/test identities across source Policies", () => {
    const source = policies.find(policy => policy.id === "local-data-use-boundaries")!;
    const first = source.rules[0]!;
    const local = { ...source, id: "first", rules: [first], test_cases: [
      { ...source.test_cases[0]!, id: "case", phase: "input" as const, covered_rule_ids: [first.id] },
      { ...source.test_cases[0]!, id: "output", phase: "output" as const, covered_rule_ids: [first.id] },
      { ...source.test_cases[0]!, id: "partial", phase: "input" as const, covered_rule_ids: [first.id, "unselected"] },
    ] };
    const binding = { policy_id: local.id, policy_version: local.version, enabled_rule_ids: [first.id], rule_order: [first.id], enabled_rails: ["input" as const], parameter_values: {}, rule_actions: { [first.id]: "intervene" as const } };
    const profile = { ...profiles[0]!, bindings: [binding, { ...binding, policy_id: "second" }] };
    const detail = collectionAsPolicy(policyCollections([profile], [local, { ...local, id: "second" }])[0]!);
    expect(detail.rules).toHaveLength(2);
    expect(new Set(detail.rules.map(rule => rule.id)).size).toBe(2);
    expect(detail.rules.every(rule => rule.effect === "intervene" && rule.rails.join() === "input")).toBe(true);
    expect(detail.test_cases).toHaveLength(2);
    expect(new Set(detail.test_cases.map(test => test.id)).size).toBe(2);
    expect(detail.test_cases.map(test => test.covered_rule_ids[0])).toEqual(detail.rules.map(rule => rule.id));
    const mismatched = { ...local, compliance: { ...local.compliance!, policy_version: "different" } };
    expect(collectionAsPolicy(policyCollections([{ ...profile, bindings: [binding] }], [mismatched])[0]!).compliance).toBeUndefined();
  });
});
