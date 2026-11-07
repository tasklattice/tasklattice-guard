import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { protectionPresets } from "../../shared/protection-presets.js";
import { buildGuardrailPlan } from "../domain/guardrail-plan.js";
import { PolicyCatalog } from "./catalog.js";
import { expandProtectionPreset, profileRequiresModels } from "./presets.js";

const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();

function regionalPreset(ruleIds: string[]) {
  return { ...protectionPresets[0]!, policies: [{ policyId: "identity-documents", policyVersion: "1.0.0",
    enabledRuleIds: ruleIds, ruleOrder: ruleIds, enabledRails: ["input" as const], parameterValues: {} }] };
}

describe("Protection presets", () => {
  it("adds Singapore identifier Rules to an existing China capability selection without losing either region", () => {
    const china = expandProtectionPreset(regionalPreset(["cn-personal-information/resident-identity-card"]), policies);
    const singapore = regionalPreset(["pattern/sg_nric"]);
    const combined = expandProtectionPreset(singapore, policies, china);
    const identifiers = combined.find(b => b.policyId === "identity-documents")!;
    expect(identifiers.enabledRuleIds).toContain("cn-personal-information/resident-identity-card");
    for (const id of singapore.policies.find(p => p.policyId === identifiers.policyId)!.enabledRuleIds!) {
      expect(identifiers.enabledRuleIds).toContain(id);
    }
    expect(identifiers.ruleOrder![0]).toBe("cn-personal-information/resident-identity-card");
    expect(expandProtectionPreset(singapore, policies, combined)).toEqual(combined);
    expect(china.find(b => b.policyId === identifiers.policyId)!.enabledRuleIds).toHaveLength(1);
  });


  it("derives model dependency from selected Rule detectors", () => {
    const keyword = policies.find(policy => policy.id === "content-filters")!;
    const preset = {
      ...protectionPresets[0]!,
      policies: [{ policyId: keyword.id, policyVersion: keyword.version, enabledRuleIds: [keyword.rules[0]!.id],
        ruleOrder: [keyword.rules[0]!.id], enabledRails: ["input" as const], parameterValues: {} }],
    };
    expect(profileRequiresModels(preset, policies)).toBe(false);
    const modeled = { ...keyword, rules: [{ ...keyword.rules[0]!, detector: { ref: "model/classifier" } }] };
    expect(profileRequiresModels(preset, [modeled])).toBe(true);
  });

  it("selects a Rule by binding identity and applies a parameter pack", () => {
    const preset = {
      ...protectionPresets[0]!,
      parameterPacks: [{ id: "profile-pack", version: "1.0.0", values: { blocked_words: "PROFILE_TERM", brand_name: "TaskLattice", competitors: "Example", phrase_entries: "[]" } }],
      policies: [{
        policyId: "content-filters", policyVersion: "1.0.0",
        enabledBindingIds: ["content-filters/keyword/blocked-words"],
        bindingOrder: ["content-filters/keyword/blocked-words"],
        enabledRails: ["input" as const], parameterValues: {},
      }],
    };
    const expanded = expandProtectionPreset(preset, policies);
    expect(expanded).toHaveLength(1);
    expect(expanded[0]!.enabledRuleIds).toEqual(["keyword/blocked-words"]);
    expect(expanded[0]!.ruleOrder).toEqual(["keyword/blocked-words"]);
    expect(expanded[0]!.parameterValues).toMatchObject({ blocked_words: "PROFILE_TERM" });
  });

  it("selects regional identifiers explicitly without enabling every identifier format", () => {
    const china = expandProtectionPreset(regionalPreset(["cn-personal-information/resident-identity-card"]), policies);
    const identifiers = china.find(b => b.policyId === "identity-documents")!;
    expect(identifiers.enabledRuleIds).toEqual(["cn-personal-information/resident-identity-card"]);
    expect(identifiers.enabledRuleIds).not.toContain("pattern/au_abn");
  });

  it.each(protectionPresets)("$name expands selected, pinned, model-free Policies in reviewed order", (preset) => {
    const bindings = expandProtectionPreset(preset, policies);
    expect(bindings.map((binding) => binding.policyId)).toEqual(preset.policies.map((reference) => reference.policyId));
    for (const binding of bindings) {
      const policy = policies.flatMap(item => [item, ...item.published_versions ?? []])
        .find(item => item.id === binding.policyId && item.version === binding.policyVersion)!;
      expect(binding.policyVersion).toBe(policy.version);
      const reference = preset.policies.find(r => r.policyId === binding.policyId)!;
      expect(binding.enabledRuleIds).toEqual(reference.enabledRuleIds ?? policy.rules.map(rule => rule.id));
      expect(binding.ruleOrder).toEqual(reference.ruleOrder ?? []);
      expect(binding.testCaseOverrides).toEqual(preset.policies.find(r => r.policyId === binding.policyId)!.testCaseOverrides ?? {});
    }
    const plan = buildGuardrailPlan({ guardrailId: preset.id, guardrailVersion: "20260906-010000.001Z", policies, draft: {
      allowedTopics: [], restrictedTopics: [], safetyLevel: "balanced", outputDelivery: "full_buffered", policyBindings: bindings,
    } });
    expect(plan.steps.length).toBeGreaterThanOrEqual(bindings.length);
    expect(plan.policy_bindings).toHaveLength(bindings.length);
  });

  it("does not offer retired, unverified MAS-labelled phrase collections", () => {
    const retired = new Set(["mas-ai-risk-management", "singapore-financial-conduct"]);
    expect(policies.some(policy => retired.has(policy.id))).toBe(false);
    for (const preset of protectionPresets) {
      expect(preset.policies.some(policy => retired.has(policy.policyId))).toBe(false);
      expect(preset.optionalPolicyIds.some(policyId => retired.has(policyId))).toBe(false);
    }
  });

  it("shares the baseline without overwriting user changes when switching scenarios", () => {
    const bank = expandProtectionPreset(protectionPresets[0]!, policies);
    bank[0]!.ruleActions[bank[0]!.enabledRuleIds[0]!] = "transform";
    bank[0]!.enabledRails = ["output"];
    bank.reverse();
    const before = structuredClone(bank);
    const combined = expandProtectionPreset(protectionPresets[1]!, policies, bank);
    expect(combined.slice(0, bank.length).map(b => b.policyId)).toEqual(before.map(b => b.policyId));
    for (const previous of before) {
      const next = combined.find(b => b.policyId === previous.policyId)!;
      expect(next).toMatchObject({ policyVersion: previous.policyVersion, ruleActions: previous.ruleActions,
        enabledRails: previous.enabledRails, parameterValues: previous.parameterValues });
      expect(next.enabledRuleIds.slice(0, previous.enabledRuleIds.length)).toEqual(previous.enabledRuleIds);
    }
    expect(bank).toEqual(before);
    expect(new Set(combined.map((binding) => binding.policyId)).size).toBe(combined.length);
    expect(expandProtectionPreset(protectionPresets[1]!, policies, combined)).toEqual(combined);
  });

  it("fails on missing, stale, misdirected or incomplete references", () => {
    const preset = structuredClone(protectionPresets[0]!);
    expect(() => expandProtectionPreset(preset, [])).toThrow(/unavailable/);
    preset.policies[0]!.policyVersion = "unknown";
    expect(() => expandProtectionPreset(preset, policies)).toThrow(/requires version/);
    preset.policies = [{ policyId: "business-topics", policyVersion: "1.0.0", enabledRails: ["output"], parameterValues: {} }];
    expect(() => expandProtectionPreset(preset, policies)).toThrow(/unsupported Rails/);
    preset.policies = [{ policyId: "content-filters", policyVersion: "1.0.0", enabledRails: ["input"], parameterValues: {} }];
    expect(() => expandProtectionPreset(preset, policies)).toThrow(/needs /);
  });
});
