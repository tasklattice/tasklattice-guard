import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { buildGuardrailPlan, type GuardrailPolicyBindingConfig } from "./guardrail-plan.js";
import { generatedTestCases } from "./validation.js";
import { TOPIC_ALLOW_RULE as ALLOW, TOPIC_DENY_RULE as DENY } from "../../shared/topic-policy.js";
const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
function binding(rules: string[], mode = "strict"): GuardrailPolicyBindingConfig {
  return { policyId: "business-topics", policyVersion: "1.0.0", action: null, enabledRuleIds: rules,
    enabledRails: ["input"], ruleActions: {}, parameterValues: { allowed_topics: "Order support", denied_topics: "Refund fraud", topic_mode: mode }, reasoningPolicy: null };
}
const draft = (item: GuardrailPolicyBindingConfig) => ({ allowedTopics: ["Root values must not leak"], restrictedTopics: ["Old deny"], safetyLevel: "balanced" as const, outputDelivery: "full_buffered" as const, policyBindings: [item] });
function steps(item: GuardrailPolicyBindingConfig) {
  return buildGuardrailPlan({ guardrailId: "split", guardrailVersion: "test", policies, draft: draft(item) }).steps as Array<{ parameters: Array<[string, string]>; on_unsafe: string }>;
}
describe("Topic Control Policy Rule isolation", () => {
  it("exposes one model Policy for topic and company boundaries", () => {
    const modelTopics = policies.filter(policy => policy.id === "business-topics");
    expect(modelTopics.map(policy => policy.id)).toEqual(["business-topics"]);
    expect(modelTopics[0]!.rules.map(rule => rule.id)).toEqual([DENY, ALLOW]);
  });
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
    const item = binding([ALLOW, DENY]); item.ruleOrder = [ALLOW, DENY]; item.action = "allow";
    expect(steps(item)[0]!.on_unsafe).toBe("block");
    item.ruleActions = { [DENY]: "allow" };
    expect(() => steps(item)).toThrow(/must reject/);
  });
  it("keeps local Rules ahead of Topic checks while enforcing deny before allow", () => {
    const base = policies.find(policy => policy.id === "business-topics")!;
    const contact = policies.find(policy => policy.id === "contact-data")!;
    const emailRule = contact.rules.find(rule => rule.id === "pattern/email")!;
    const emailDefinition = contact.definition!.rules.find(rule => rule.id === "pattern/email")!;
    const mixed = structuredClone(base);
    mixed.id = "mixed-topic";
    mixed.name = "Mixed topic and redaction";
    mixed.rules = [...mixed.rules, emailRule];
    mixed.rails = ["input", "output"];
    mixed.definition = { ...mixed.definition!, rules: [...mixed.definition!.rules, emailDefinition] };
    const catalog = [...policies, mixed];
    const item: GuardrailPolicyBindingConfig = {
      policyId: mixed.id, policyVersion: mixed.version, action: null,
      enabledRuleIds: [emailRule.id, ALLOW, DENY], ruleOrder: [emailRule.id, ALLOW, DENY],
      enabledRails: ["input", "output"], ruleActions: {},
      parameterValues: { allowed_topics: "Order support", denied_topics: "Refund fraud", topic_mode: "strict" }, reasoningPolicy: null,
    };
    const compile = () => buildGuardrailPlan({ guardrailId: "mixed", guardrailVersion: "test", policies: catalog,
      draft: { allowedTopics: [], restrictedTopics: [], safetyLevel: "balanced", outputDelivery: "full_buffered", policyBindings: [item] } })
      .steps.map(step => {
        const parameters = Object.fromEntries(step.parameters);
        if (parameters.enabled_rules_json) return JSON.parse(parameters.enabled_rules_json)[mixed.id][0];
        return parameters.rule_id;
      });
    expect(compile()).toEqual([emailRule.id, DENY, ALLOW]);
    item.ruleOrder = [emailRule.id, DENY, ALLOW];
    expect(compile()).toEqual([emailRule.id, DENY, ALLOW]);
    item.ruleOrder = [ALLOW, emailRule.id, DENY];
    expect(compile()).toEqual([DENY, emailRule.id, ALLOW]);
    item.enabledRuleIds = [emailRule.id, DENY];
    item.ruleOrder = [ALLOW, emailRule.id, DENY];
    expect(compile()).toEqual([emailRule.id, DENY]);
  });
  it("keeps non-topic acceptance cases when a Policy also has Topic Rules", () => {
    const base = policies.find(policy => policy.id === "business-topics")!;
    const contact = policies.find(policy => policy.id === "contact-data")!;
    const emailRule = contact.rules.find(rule => rule.id === "pattern/email")!;
    const emailDefinition = contact.definition!.rules.find(rule => rule.id === "pattern/email")!;
    const emailTest = contact.definition!.tests.find(test => test.covered_rule_ids.includes(emailRule.id))!;
    const mixed = structuredClone(base);
    mixed.id = "mixed-cases";
    mixed.name = "Mixed cases";
    mixed.rails = ["input", "output"];
    mixed.rules = [...mixed.rules, emailRule];
    const scenario = { ...emailTest, id: "mixed-policy-scenario", name: "Mixed policy scenario", covered_rule_ids: [emailRule.id, DENY], expected_decision: "block" as const };
    mixed.definition = { ...mixed.definition!, rules: [...mixed.definition!.rules, emailDefinition], tests: [...mixed.definition!.tests, emailTest, scenario] };
    const item = { policyId: mixed.id, policyVersion: mixed.version, action: null,
      enabledRuleIds: [emailRule.id, ALLOW, DENY], ruleOrder: [emailRule.id, DENY, ALLOW], enabledRails: ["input", "output"], ruleActions: {},
      parameterValues: { allowed_topics: "Order support", denied_topics: "Refund fraud", topic_mode: "strict" }, reasoningPolicy: null };
    const cases = generatedTestCases("mixed-cases", { allowedTopics: [], restrictedTopics: [], safetyLevel: "balanced", outputDelivery: "full_buffered", policyBindings: [item] }, [...policies, mixed]);
    expect(cases.some(test => test.coveredRuleIds.includes(DENY))).toBe(true);
    expect(cases.some(test => test.coveredRuleIds.includes(ALLOW))).toBe(true);
    expect(cases.filter(test => test.coveredRuleIds.includes(emailRule.id))).toHaveLength(2);
    expect(cases.some(test => test.sourceCaseId === "mixed-policy-scenario")).toBe(true);
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

});
