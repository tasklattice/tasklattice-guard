import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { protectionPresets } from "../../shared/protection-presets.js";
import { buildGuardrailPlan } from "../domain/guardrail-plan.js";
import { PolicyCatalog } from "./catalog.js";
import { expandProtectionPreset } from "./presets.js";

const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();

describe("Protection presets", () => {
  it("keeps broad disclosure filters opt-in instead of silently enabling them for every industry", () => {
    const reviewedOnly = new Set([
      "local-government-identifiers", "local-passport-formats", "local-regional-contact-formats",
      "local-bank-account-formats", "local-travel-identifiers", "local-network-addresses",
      "local-sensitive-attribute-terms", "local-risk-content-terms", "local-australian-tax-health-identifiers",
    ]);
    expect(policies.filter((policy) => reviewedOnly.has(policy.id))).toHaveLength(reviewedOnly.size);
    for (const preset of protectionPresets) {
      expect(expandProtectionPreset(preset, policies).filter((binding) => reviewedOnly.has(binding.policyId))).toEqual([]);
    }
  });

  it.each(protectionPresets)("$name expands complete, pinned, model-free Policies in reviewed order", (preset) => {
    const bindings = expandProtectionPreset(preset, policies);
    expect(bindings.map((binding) => binding.policyId)).toEqual(preset.policies.map((reference) => reference.policyId));
    for (const binding of bindings) {
      const policy = policies.find((item) => item.id === binding.policyId)!;
      expect(binding.policyVersion).toBe(policy.version);
      expect(binding.enabledRuleIds).toEqual(policy.rules.map((rule) => rule.id));
      expect(policy.protection.execution).toBe("local");
      expect(binding.testCaseOverrides).toEqual({});
    }
    const plan = buildGuardrailPlan({ guardrailId: preset.id, guardrailVersion: "20260906-010000.001Z", policies, draft: {
      allowedTopics: [], restrictedTopics: [], safetyLevel: "balanced", outputDelivery: "full_buffered", policyBindings: bindings,
    } });
    expect(plan.steps).toHaveLength(bindings.length);
    expect(plan.policy_bindings).toHaveLength(bindings.length);
  });

  it("does not offer retired, unverified MAS-labelled phrase collections", () => {
    const retired = new Set(["mas-ai-risk-management", "singapore-financial-conduct"]);
    expect(policies.some(policy => retired.has(policy.id))).toBe(false);
    for (const preset of protectionPresets) {
      expect(preset.policies.some(policy => retired.has(policy.policyId))).toBe(false);
      expect(preset.optionalPolicyIds.some(policyId => retired.has(policyId))).toBe(false);
    }
    const singapore = protectionPresets.find(preset => preset.id === "singapore-financial-assistant")!;
    expect(singapore.version).toBe("1.0.1");
    expect(singapore.limitations.join(" ")).toContain("No MAS-specific control");
  });

  it("keeps China mainland Profiles runtime-bounded and model integrations optional", () => {
    const general = protectionPresets.find(preset => preset.id === "china-mainland-runtime")!;
    const banking = protectionPresets.find(preset => preset.id === "china-banking-assistant")!;
    expect(expandProtectionPreset(general, policies).map(binding => binding.policyId)).toEqual([
      "local-credentials", "local-passports", "china-personal-identifiers", "china-prompt-manipulation",
    ]);
    expect(expandProtectionPreset(banking, policies).map(binding => binding.policyId)).toEqual([
      "local-credentials", "local-passports", "china-personal-identifiers", "china-prompt-manipulation", "china-banking-assistant-boundaries",
    ]);
    expect(general.optionalPolicyIds).toEqual(expect.arrayContaining(["builtin-content-safety", "builtin-contextual-grounding", "china-organization-identifiers"]));
    expect(general.limitations.join(" ")).toContain("Runtime Enforced");
    expect(general.limitations.join(" ")).toContain("Requires Integration");
    expect(general.limitations.join(" ")).toContain("Governance Only");
  });

  it("shares the baseline without overwriting user changes when switching scenarios", () => {
    const bank = expandProtectionPreset(protectionPresets[1]!, policies);
    bank[0]!.ruleActions[bank[0]!.enabledRuleIds[0]!] = "redact";
    bank[0]!.enabledRails = ["output"];
    bank.reverse();
    const before = structuredClone(bank);
    const combined = expandProtectionPreset(protectionPresets[2]!, policies, bank);
    expect(combined.slice(0, bank.length)).toEqual(before);
    expect(bank).toEqual(before);
    expect(new Set(combined.map((binding) => binding.policyId)).size).toBe(combined.length);
    expect(expandProtectionPreset(protectionPresets[2]!, policies, combined)).toEqual(combined);
  });

  it("fails on missing, stale, misdirected or incomplete references", () => {
    const preset = structuredClone(protectionPresets[0]!);
    expect(() => expandProtectionPreset(preset, [])).toThrow(/unavailable/);
    preset.policies[0]!.policyVersion = "unknown";
    expect(() => expandProtectionPreset(preset, policies)).toThrow(/requires version/);
    preset.policies = [{ policyId: "builtin-jailbreak", policyVersion: "1.0.0", enabledRails: ["output"], parameterValues: {} }];
    expect(() => expandProtectionPreset(preset, policies)).toThrow(/unsupported Rails/);
    preset.policies = [{ policyId: "keyword-blocking", policyVersion: "1.95.0", enabledRails: ["input"], parameterValues: {} }];
    expect(() => expandProtectionPreset(preset, policies)).toThrow(/needs blocked_words/);
  });
});
