import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { defaultGuardrailDraft, DEFAULT_GUARDRAIL_ID } from "./defaults.js";
import { buildGuardrailPlan } from "./guardrail-plan.js";
import { isModelIndependent, publishedProtectionCoverage } from "./protection-readiness.js";
import { applyValidationOverrides, generatedTestCases } from "./validation.js";
import { DeclarativeCompiler } from "../policy-studio/declarative.js";
import { protectionPresets } from "../../shared/protection-presets.js";

const directory = resolve("../runner/toolkit/policy_library/assets");
const policies = PolicyCatalog.load(directory).list();
const profile = protectionPresets.find(item => item.id === "default")!;
const expectedPolicyIds = profile.policies.map(item => item.policyId);

describe("Default Guardrail capability composition", () => {
  it("runs the full Default with local providers and no model dependencies", () => {
    const draft = defaultGuardrailDraft(policies);
    const plan = buildGuardrailPlan({ guardrailId: DEFAULT_GUARDRAIL_ID, guardrailVersion: "20261019-000000.001Z", draft, policies });
    const coverage = publishedProtectionCoverage(plan)!;
    expect(draft.outputDelivery).toBe("full_buffered");
    expect(coverage.requiredModelBindings).toEqual([]);
    expect(coverage.hasUnknownDependencies).toBe(false);
    expect(isModelIndependent(coverage)).toBe(true);
    expect(draft.profileOrigin).toEqual({ id: profile.id, version: profile.version });
    expect(plan.policy_bindings.map(b => b.policy_id)).toEqual(expectedPolicyIds);
  });

  it("retains the reviewed Default Profile Rule selection", () => {
    const original = structuredClone(policies);
    const draft = defaultGuardrailDraft(policies);
    expect(draft.policyBindings.map(b => b.policyId)).toEqual(expectedPolicyIds);
    const expectedRules = profile.policies.reduce((count, binding) => count + (binding.enabledRuleIds?.length ?? 0), 0);
    expect(draft.policyBindings.reduce((count, binding) => count + binding.enabledRuleIds.length, 0)).toBe(expectedRules);
    for (const binding of draft.policyBindings) {
      expect(binding.ruleOrder).toEqual(binding.enabledRuleIds);
      expect(new Set(binding.enabledRuleIds).size).toBe(binding.enabledRuleIds.length);
    }
    expect(policies).toEqual(original);
  });

  it("does not enable new catalog Rules or their acceptance cases implicitly", () => {
    const changed = structuredClone(policies);
    const policy = changed.find(p => p.id === "contact-data")!;
    policy.rules.push({ ...policy.rules[0]!, id: "new/detection" });
    policy.test_cases.push({ ...policy.test_cases[0]!, id: "new/acceptance", covered_rule_ids: ["new/detection"] });
    const draft = defaultGuardrailDraft(changed);
    expect(draft.policyBindings.find(b => b.policyId === policy.id)!.enabledRuleIds).not.toContain("new/detection");
    expect(generatedTestCases(DEFAULT_GUARDRAIL_ID, draft, changed).some(t => t.sourceCaseId === "new/acceptance")).toBe(false);
  });

  it("resolves every Default binding and test expectation through the current Policy Studio catalog", () => {
    const compiler = new DeclarativeCompiler(directory);
    const current = policies.map(policy => {
      const definition = compiler.shipped(policy.id);
      return definition ? compiler.compile(definition) : policy;
    });
    const draft = defaultGuardrailDraft(policies);
    const cases = generatedTestCases(DEFAULT_GUARDRAIL_ID, draft, current);
    expect(cases.length).toBeGreaterThan(0);
    expect(() => applyValidationOverrides(cases, draft)).not.toThrow();
    for (const binding of draft.policyBindings) {
      const policy = current.find(item => item.id === binding.policyId && item.version === binding.policyVersion)!;
      expect(policy).toBeDefined();
      const rules = new Set(policy.rules.map(rule => rule.id));
      for (const id of [...binding.enabledRuleIds, ...binding.ruleOrder ?? [], ...Object.keys(binding.ruleActions)]) expect(rules.has(id)).toBe(true);
    }
    const plan = buildGuardrailPlan({ guardrailId: DEFAULT_GUARDRAIL_ID, guardrailVersion: "20261020-000000.001Z", draft, policies: current });
    expect(publishedProtectionCoverage(plan)?.requiredModelBindings).toEqual([]);
  });

  it("fails closed when a reviewed Policy, Rule or executable contract is unavailable", () => {
    expect(() => defaultGuardrailDraft(policies.filter(p => p.id !== "identity-documents"))).toThrow();
    for (const mutation of ["missing", "flow"]) {
      const changed = structuredClone(policies);
      const policy = changed.find(p => p.id === "identity-documents")!;
      if (mutation === "missing") policy.rules.shift();
      if (mutation === "flow") policy.rules[0]!.implementation.execution = "programmable";
      expect(() => defaultGuardrailDraft(changed)).toThrow();
    }
  });
});
