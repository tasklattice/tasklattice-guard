import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { buildGuardrailPlan, type GuardrailDraftConfig } from "./guardrail-plan.js";
import { generatedTestCases } from "./validation.js";
import { parsePhraseEntries, PHRASE_POLICY_ID, PHRASE_RULE_ID } from "../../shared/phrase-policy.js";

const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
const entries = [{ id: "mask", phrase: "internal-name", action: "redact", replacement: "public-name" }, { id: "block", phrase: "confidential", action: "reject" }];
const draft: GuardrailDraftConfig = { allowedTopics: [], restrictedTopics: [], safetyLevel: "balanced", outputDelivery: "full_buffered", policyBindings: [{
  policyId: PHRASE_POLICY_ID, policyVersion: "1.0.0", action: null, parameterValues: { phrase_entries: JSON.stringify(entries) },
  enabledRuleIds: [PHRASE_RULE_ID], ruleActions: {}, enabledRails: ["input", "output"], reasoningPolicy: null,
}] };

describe("Policy-owned phrase configuration", () => {
  it("compiles independently with stable ownership, directions, and no anonymous rules", () => {
    const plan = buildGuardrailPlan({ guardrailId: "phrases", guardrailVersion: "20260906-010000.001Z", draft, policies });
    const steps = plan.steps as Array<{ parameters: Array<[string, string]>; phases: string[] }>;
    expect(steps).toHaveLength(1);
    expect(steps[0]!.phases).toEqual(["input", "output"]);
    const params = Object.fromEntries(steps[0]!.parameters);
    expect(params.policy_id).toBe(PHRASE_POLICY_ID);
    expect(params).not.toHaveProperty("custom_rules_json");
    expect(JSON.parse(params.rule_actions_json!)).toEqual({ [PHRASE_POLICY_ID]: { [`${PHRASE_RULE_ID}/mask`]: "redact", [`${PHRASE_RULE_ID}/block`]: "reject" } });
    expect(JSON.parse(params.policy_parameters_json!)[PHRASE_POLICY_ID]).toEqual(draft.policyBindings[0]!.parameterValues);
    expect(plan.policy_bindings).toEqual([expect.objectContaining({ policy_id: PHRASE_POLICY_ID })]);
  });
  it("pins each expanded Rule risk independently from its directive", () => {
    const candidate = structuredClone(draft);
    candidate.policyBindings[0]!.parameterValues.phrase_entries = JSON.stringify([
      entries[0], entries[1],
    ]);
    candidate.policyBindings[0]!.ruleActions = { [PHRASE_RULE_ID]: "pass" };
    const plan = buildGuardrailPlan({ guardrailId: "risk", guardrailVersion: "v1", draft: candidate, policies });
    expect(plan.policy_bindings).toEqual([expect.objectContaining({
      enabled_rule_ids: [`${PHRASE_RULE_ID}/mask`, `${PHRASE_RULE_ID}/block`],
      rule_severities: [[`${PHRASE_RULE_ID}/mask`, "low"], [`${PHRASE_RULE_ID}/block`, "low"]],
      rule_actions: [[`${PHRASE_RULE_ID}/block`, "pass"], [`${PHRASE_RULE_ID}/mask`, "pass"]],
    })]);
    expect(candidate.policyBindings[0]!.enabledRuleIds).toEqual([PHRASE_RULE_ID]);
  });
  it("rejects severity overrides inside binding parameters", () => {
    expect(() => parsePhraseEntries(JSON.stringify([{ ...entries[0], risk_level: "informational" }]))).toThrow();
  });
  it("generates acceptance tests for every phrase in both selected directions", () => {
    const cases = generatedTestCases("phrases", draft, policies);
    expect(cases).toHaveLength(4);
    expect(cases.map(c => [c.phase, c.content, c.expectedDecision])).toEqual([
      ["input", "internal-name", "transform"], ["input", "confidential", "block"],
      ["output", "internal-name", "transform"], ["output", "confidential", "block"],
    ]);
    expect(cases.every(c => c.sourcePolicyId === PHRASE_POLICY_ID && c.coveredRuleIds.includes(PHRASE_RULE_ID))).toBe(true);
  });
  it("keeps template-shaped phrases literal in acceptance inputs", () => {
    const candidate = structuredClone(draft);
    candidate.policyBindings[0]!.parameterValues.phrase_entries = JSON.stringify([{ id: "literal", phrase: "{{phrase_entries}}", action: "reject" }]);
    const cases = generatedTestCases("phrases", candidate, policies);
    expect(cases).toHaveLength(2);
    expect(cases.every(c => c.content === "{{phrase_entries}}" && c.name.endsWith("{{phrase_entries}}"))).toBe(true);
  });
  it.each(["", "[]", "{}", '[{"id":"a","phrase":"","action":"reject"}]', JSON.stringify([entries[0], entries[0]])])("rejects missing or malformed configuration %s", value => {
    expect(() => parsePhraseEntries(value)).toThrow();
    const candidate = structuredClone(draft);
    candidate.policyBindings[0]!.parameterValues.phrase_entries = value;
    expect(() => buildGuardrailPlan({ guardrailId: "invalid", guardrailVersion: "v1", draft: candidate, policies })).toThrow();
  });
});
