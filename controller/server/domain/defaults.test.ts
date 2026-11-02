import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { defaultGuardrailDraft, DEFAULT_GUARDRAIL_ID } from "./defaults.js";
import { buildGuardrailPlan } from "./guardrail-plan.js";
import { isModelIndependent, publishedProtectionCoverage } from "./protection-readiness.js";
import { applyValidationOverrides, generatedTestCases } from "./validation.js";
import { DeclarativeCompiler } from "../policy-studio/declarative.js";

const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
const expectedPolicyIds = [
  "builtin-indirect-prompt-injection", "builtin-memory-poisoning",
  "local-content-safety", "local-injection-protection", "local-credentials", "local-payment-data",
  "local-government-identifiers", "local-passports", "local-contact-data", "local-network-addresses",
  "local-sensitive-attribute-terms", "local-risk-content-terms",
];

describe("Default Guardrail capability composition", () => {
  it("runs the full Default with local providers and no model dependencies", () => {
    const draft = defaultGuardrailDraft(policies);
    const plan = buildGuardrailPlan({ guardrailId: DEFAULT_GUARDRAIL_ID, guardrailVersion: "20261019-000000.001Z", draft, policies });
    const coverage = publishedProtectionCoverage(plan)!;
    expect(draft.outputDelivery).toBe("full_buffered");
    expect(coverage.requiredModelBindings).toEqual([]);
    expect(coverage.hasUnknownDependencies).toBe(false);
    expect(isModelIndependent(coverage)).toBe(true);
    expect(plan.steps.map(s => s.capability).slice(0, 2)).toEqual(["indirect_prompt_injection", "memory_poisoning"]);
    expect(plan.policy_bindings.map(b => b.policy_id)).toEqual(expectedPolicyIds);
  });

  it("retains 122 distinct reviewed Rules and the insults observation override", () => {
    const original = structuredClone(policies);
    const draft = defaultGuardrailDraft(policies);
    expect(draft.policyBindings.map(b => b.policyId)).toEqual(expectedPolicyIds);
    expect(draft.policyBindings.reduce((n, b) => n + b.enabledRuleIds.length, 0)).toBe(122);
    const content = draft.policyBindings.find(b => b.policyId === "local-content-safety")!;
    expect(content.enabledRuleIds).toHaveLength(10);
    expect(content.ruleActions).toEqual({ "category/denied_insults": "allow" });
    for (const binding of draft.policyBindings) {
      expect(binding.ruleOrder).toEqual(binding.enabledRuleIds);
      if (binding !== content) expect(binding.ruleActions).toEqual({});
      expect(new Set(binding.enabledRuleIds).size).toBe(binding.enabledRuleIds.length);
    }
    expect(policies).toEqual(original);
  });


  it("does not enable new catalog Rules or their acceptance cases implicitly", () => {
    const changed = structuredClone(policies);
    const policy = changed.find(p => p.id === "local-contact-data")!;
    policy.rules.push({ ...policy.rules[0]!, id: "new/detection" });
    policy.test_cases.push({ ...policy.test_cases[0]!, id: "new/acceptance", covered_rule_ids: ["new/detection"] });
    const draft = defaultGuardrailDraft(changed);
    expect(draft.policyBindings.find(b => b.policyId === policy.id)!.enabledRuleIds).not.toContain("new/detection");
    expect(generatedTestCases(DEFAULT_GUARDRAIL_ID, draft, changed).some(t => t.sourceCaseId === "new/acceptance")).toBe(false);
  });

  it("resolves every Default binding and test expectation through the current Policy Studio catalog", () => {
    const compiler = new DeclarativeCompiler(resolve("../runner/toolkit/policy_library/assets"));
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
      for (const [caseId, override] of Object.entries(binding.testCaseOverrides ?? {})) {
        expect(override.sourcePolicyVersion).toBe(binding.policyVersion);
        expect(cases.some(test => test.sourcePolicyId === policy.id && test.sourceCaseId === caseId)).toBe(true);
        for (const match of override.expectedMatches) {
          expect(draft.policyBindings.find(item => item.policyId === match.policyId)?.enabledRuleIds).toContain(match.ruleId);
        }
      }
    }
    const plan = buildGuardrailPlan({ guardrailId: DEFAULT_GUARDRAIL_ID, guardrailVersion: "20261020-000000.001Z", draft, policies: current });
    expect(publishedProtectionCoverage(plan)?.requiredModelBindings).toEqual([]);
  });

  it("fails closed when a reviewed Policy, Rule or executable contract is unavailable", () => {
    expect(() => defaultGuardrailDraft(policies.filter(p => p.id !== "local-government-identifiers"))).toThrow(/is missing/);
    for (const mutation of ["empty", "missing", "flow", "custom", "model"]) {
      const changed = structuredClone(policies);
      const policy = changed.find(p => p.id === "local-government-identifiers")!;
      if (mutation === "empty") policy.rules = [];
      if (mutation === "missing") policy.rules.shift();
      if (mutation === "flow") policy.rules[0]!.implementation.execution = "programmable";
      if (mutation === "model") policy.protection.execution = "model";
      if (mutation === "custom") policy.protection.execution = "custom";
      expect(() => defaultGuardrailDraft(changed)).toThrow();
    }
  });
});
