import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { defaultGuardrailDraft, DEFAULT_GUARDRAIL_ID } from "./defaults.js";
import { buildGuardrailPlan } from "./guardrail-plan.js";
import { generatedTestCases } from "./validation.js";

const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
const expectedPolicyIds = [
  "filter-denied-insults",
  "filter-harm-toxic-abuse",
  "filter-harmful-violence",
  "filter-harmful-self-harm",
  "filter-harmful-child-safety",
  "filter-harmful-illegal-weapons",
  "filter-bias-gender",
  "filter-bias-racial",
  "filter-bias-religious",
  "filter-bias-sexual-orientation",
  "prompt-injection-protection",
  "filter-prompt-injection-jailbreak",
  "filter-prompt-injection-data-exfiltration",
  "filter-prompt-injection-sql",
  "filter-prompt-injection-malicious-code",
  "filter-prompt-injection-system-prompt",
  "baseline-pii-protection",
  "pattern-matching",
];

describe("Default Guardrail baseline", () => {
  it("unbinds Advanced PII only from Default while preserving the catalog and retained Policies", () => {
    const originalCatalog = structuredClone(policies);
    const draft = defaultGuardrailDraft(policies);
    const cases = generatedTestCases(DEFAULT_GUARDRAIL_ID, draft, policies);

    expect(draft.policyBindings).toHaveLength(18);
    expect(draft.policyBindings.slice(-2).map((binding) => binding.policyId)).toEqual([
      "baseline-pii-protection", "pattern-matching",
    ]);
    expect(draft.policyBindings.some((binding) => binding.policyId === "advanced-au-pii-protection")).toBe(false);
    expect(cases).toHaveLength(140);
    expect(cases.some((item) => item.sourcePolicyId === "advanced-au-pii-protection")).toBe(false);
    expect(policies.find((item) => item.id === "advanced-au-pii-protection")?.rules).toHaveLength(47);
    expect(policies).toEqual(originalCatalog);
  });

  it("composes complete Policies without disabling Rules or changing template actions", () => {
    const draft = defaultGuardrailDraft(policies);

    expect(draft.policyBindings.map((binding) => binding.policyId)).toEqual(expectedPolicyIds);
    for (const binding of draft.policyBindings) {
      const policy = policies.find((item) => item.id === binding.policyId)!;
      expect(binding).toEqual({
        policyId: policy.id,
        policyVersion: policy.version,
        action: null,
        parameterValues: {},
        enabledRuleIds: policy.rules.map((rule) => rule.id),
        ruleOrder: binding.ruleOrder,
        testCaseOverrides: binding.testCaseOverrides,
        ruleActions: {},
        enabledRails: policy.rails,
        reasoningPolicy: null,
      });
      expect(binding.enabledRuleIds.length).toBeGreaterThan(0);
      expect(new Set(binding.enabledRuleIds).size).toBe(policy.rules.length);
      expect(policy.parameters.filter((parameter) => parameter.required && !parameter.default?.trim())).toEqual([]);
    }
  });

  it("inherits every selected Policy's Test Cases with observable source identity", () => {
    const draft = defaultGuardrailDraft(policies);
    const cases = generatedTestCases(DEFAULT_GUARDRAIL_ID, draft, policies);

    for (const binding of draft.policyBindings) {
      const policy = policies.find((item) => item.id === binding.policyId)!;
      const inherited = cases.filter((item) => item.policyId === policy.id);
      expect(inherited.map((item) => item.sourceCaseId)).toEqual(policy.test_cases.map((item) => item.id));
      for (const source of policy.test_cases) {
        expect(inherited.find((item) => item.sourceCaseId === source.id)).toMatchObject({
          guardrailId: DEFAULT_GUARDRAIL_ID,
          policyId: policy.id,
          sourcePolicyId: policy.id,
          sourcePolicyVersion: policy.version,
          sourceCaseId: source.id,
          content: source.content,
          phase: source.phase,
          expectedDecision: source.expected_decision,
          coveredRuleIds: source.covered_rule_ids,
          required: source.required,
        });
      }
      const covered = new Set(inherited.flatMap((item) => item.coveredRuleIds));
      expect(policy.rules.every((rule) => covered.has(rule.id))).toBe(true);
    }
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length);
  });

  it("includes new Policy Rules and Test Cases when rebuilding from an updated catalog", () => {
    const originalDraft = defaultGuardrailDraft(policies);
    const updatedPolicies = structuredClone(policies);
    const policy = updatedPolicies.find((item) => item.id === "pattern-matching")!;
    const ruleId = "pattern/new-policy-rule";
    const caseId = "new-policy-acceptance-case";
    policy.version = "next-catalog-version";
    policy.rules.push({ ...policy.rules[0]!, id: ruleId });
    policy.test_cases.push({ ...policy.test_cases[0]!, id: caseId, covered_rule_ids: [ruleId] });
    const draft = defaultGuardrailDraft(updatedPolicies);

    expect(draft.policyBindings.map((binding) => binding.policyId)).toEqual(expectedPolicyIds);
    expect(draft.policyBindings.find((binding) => binding.policyId === policy.id)).toMatchObject({
      policyVersion: policy.version,
      enabledRuleIds: policy.rules.map((rule) => rule.id),
    });
    expect(generatedTestCases(DEFAULT_GUARDRAIL_ID, draft, updatedPolicies)).toContainEqual(expect.objectContaining({
      policyId: policy.id,
      sourcePolicyVersion: policy.version,
      sourceCaseId: caseId,
      coveredRuleIds: [ruleId],
    }));
    expect(originalDraft.policyBindings.find((binding) => binding.policyId === policy.id)?.enabledRuleIds).not.toContain(ruleId);
    expect(defaultGuardrailDraft(policies)).toEqual(originalDraft);
  });

  it("fails explicitly when an entire selected Policy is missing or empty", () => {
    expect(() => defaultGuardrailDraft(policies.filter((policy) => policy.id !== "pattern-matching")))
      .toThrow("Default Guardrail Policy pattern-matching is missing");
    expect(() => defaultGuardrailDraft(policies.map((policy) => policy.id === "pattern-matching" ? { ...policy, rules: [] } : policy)))
      .toThrow("Default Guardrail Policy pattern-matching has no Rules");
  });

  it("compiles locally while retaining every Policy binding for runtime inspection", () => {
    const draft = defaultGuardrailDraft(policies);
    const plan = buildGuardrailPlan({
      guardrailId: DEFAULT_GUARDRAIL_ID,
      guardrailVersion: "20260904-010000.001Z",
      purpose: "Protect unmatched traffic with complete local Policies.",
      draft,
      policies,
    });
    const steps = plan.steps as Array<{ capability: string; contract_ref: string; phases: string[]; parameters: Array<[string, string]> }>;

    expect(steps).toHaveLength(expectedPolicyIds.length);
    expect(steps).toEqual(draft.policyBindings.map((binding) => expect.objectContaining({
      capability: "builtin_content_filter",
      contract_ref: "tali.guard.content-filter.rules.v1",
      phases: binding.enabledRails,
    })));
    steps.forEach((step, index) => {
      const binding = draft.policyBindings[index]!;
      const parameters = Object.fromEntries(step.parameters);
      expect(parameters.policy_ids).toBe(binding.policyId);
      expect(JSON.parse(parameters.enabled_rules_json!)).toEqual({ [binding.policyId]: binding.enabledRuleIds });
      expect(JSON.parse(parameters.custom_rules_json!)).toEqual([]);
    });
    expect(plan.policy_bindings).toEqual(draft.policyBindings.map((binding) => ({
      policy_id: binding.policyId,
      policy_version: binding.policyVersion,
      action: binding.action,
      parameter_values: Object.entries(binding.parameterValues),
      enabled_rule_ids: binding.enabledRuleIds,
      rule_order: binding.ruleOrder ?? [],
      rule_actions: [],
      enabled_rails: binding.enabledRails,
    })));
    expect(plan.modules.map((item) => item.phase)).toEqual(draft.policyBindings.flatMap((binding) => binding.enabledRails));
  });
});
