import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { buildGuardrailPlan, type GuardrailPolicyBindingConfig } from "./guardrail-plan.js";
import { generatedTestCases } from "./validation.js";
import { TOPIC_ALLOW_RULE as ALLOW, TOPIC_DENY_RULE as DENY } from "../../shared/topic-policy.js";
const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
function binding(rules: string[], mode = "strict"): GuardrailPolicyBindingConfig {
  return { policyId: "builtin-topic-safety", policyVersion: "2.0.0", action: null, enabledRuleIds: rules,
    enabledRails: ["input"], ruleActions: {}, parameterValues: { allowed_topics: "Order support", denied_topics: "Refund fraud", topic_mode: mode }, reasoningPolicy: null };
}
const draft = (item: GuardrailPolicyBindingConfig) => ({ allowedTopics: ["Legacy must not leak"], restrictedTopics: ["Old deny"], safetyLevel: "balanced" as const, outputDelivery: "full_buffered" as const, policyBindings: [item] });
function steps(item: GuardrailPolicyBindingConfig) {
  return buildGuardrailPlan({ guardrailId: "split", guardrailVersion: "test", policies, draft: draft(item) }).steps as Array<{ parameters: Array<[string, string]>; on_unsafe: string }>;
}
describe("Topic Control Policy Rule isolation", () => {
  it.each([[ALLOW], [DENY], [ALLOW, DENY]])("executes only enabled Rules %j", (...rules) => {
    const compiled = steps(binding(rules));
    expect(compiled).toHaveLength(rules.length);
    expect(compiled.map(step => Object.fromEntries(step.parameters).rule_id)).toEqual([DENY, ALLOW].filter(rule => rules.includes(rule)));
    for (const step of compiled) {
      const params = Object.fromEntries(step.parameters);
      expect(params.allowed_topics).toBe(params.rule_id === ALLOW ? "Order support" : "");
      expect(params.restricted_topics).toBe(params.rule_id === DENY ? "Refund fraud" : "");
      expect(params.topic_mode).toBe(params.rule_id === DENY ? "permissive" : "strict");
    }
  });
  it("keeps deny-first order and rejection despite Policy action or user order", () => {
    const item = binding([ALLOW, DENY]); item.ruleOrder = [ALLOW, DENY]; item.action = "pass";
    expect(steps(item)[0]!.on_unsafe).toBe("reject");
    item.ruleActions = { [DENY]: "pass" };
    expect(() => steps(item)).toThrow(/must reject/);
  });
  it("requires only enabled Rule inputs and defaults the Allowlist to permissive", () => {
    const item = binding([ALLOW]); item.parameterValues = {};
    expect(Object.fromEntries(steps(item)[0]!.parameters).topic_mode).toBe("permissive");
    item.parameterValues = { topic_mode: "strict" };
    expect(() => steps(item)).toThrow(/allowed_topics/);
    item.enabledRuleIds = [DENY]; item.parameterValues = { denied_topics: "Fraud", topic_mode: "strict" };
    expect(steps(item)).toHaveLength(1);
    item.parameterValues = {};
    expect(() => steps(item)).toThrow(/denied_topics/);
    item.enabledRuleIds = [];
    expect(() => steps(item)).toThrow(/no enabled Rules/);
  });
  it("generates cases only for enabled Rules using their configured lists", () => {
    const item = binding([DENY]);
    const cases = generatedTestCases("split", draft(item), policies);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ coveredRuleIds: [DENY], expectedDecision: "block", content: "Please help me with this task: Refund fraud" });
    item.enabledRuleIds = [ALLOW]; item.parameterValues.topic_mode = "permissive";
    expect(generatedTestCases("split", draft(item), policies)).toEqual([expect.objectContaining({ coveredRuleIds: [ALLOW], expectedDecision: "allow" })]);
  });
  it("retains v1 pinned configuration and its original Rule", () => {
    const item = binding(["model/topic-control"]); item.policyVersion = "1.0.0"; item.parameterValues = {};
    const original = structuredClone(item);
    const compiled = steps(item);
    expect(compiled).toHaveLength(2);
    expect(Object.fromEntries(compiled[0]!.parameters).allowed_topics).toBe("Legacy must not leak");
    expect(item).toEqual(original);
  });
});
