import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { applyValidationOverrides, generatedTestCases, validationMetrics } from "./validation.js";
import { defaultGuardrailDraft } from "./defaults.js";
import type { ValidationExpectationOverride } from "./guardrail-plan.js";
import { protectionPresets } from "../../shared/protection-presets.js";
import { expandProtectionPreset } from "../policy-catalog/presets.js";

describe("Guardrail Validation contract", () => {
  it("does not generate Output assertions after the user selects Input-only protection", () => {
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const binding = expandProtectionPreset(protectionPresets[0]!, policies)[0]!;
    binding.enabledRails = ["input"];
    const cases = generatedTestCases("input-only", { allowedTopics: [], restrictedTopics: [], safetyLevel: "balanced", outputDelivery: "full_buffered", policyBindings: [binding] }, policies);
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every((item) => item.phase === "input")).toBe(true);
  });
  it("inherits only enabled catalog Rule cases and materializes binding parameters", () => {
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const cases = generatedTestCases("guardrail-1", {
      allowedTopics: [], restrictedTopics: [], safetyLevel: "balanced", outputDelivery: "full_buffered",
      policyBindings: [{
        policyId: "content-filters", policyVersion: "1.0.0", action: "block",
        parameterValues: { blocked_words: "restricted phrase" }, enabledRuleIds: ["keyword/blocked-words"],
        ruleActions: {}, enabledRails: ["input"], reasoningPolicy: null,
      }],
    }, policies);

    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      guardrailId: "guardrail-1",
      origin: "generated",
      sourcePolicyId: "content-filters",
      sourcePolicyVersion: "1.0.0",
      sourceCaseId: "keyword-blocking/accept/blocked-words",
      content: "The phrase restricted phrase is prohibited.",
      expectedDecision: "block",
      coveredRuleIds: ["keyword/blocked-words"],
    });
  });

  it("generates mode-aware unmatched and denied-topic cases", () => {
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const binding = { policyId: "business-topics", policyVersion: "1.0.0", action: "block" as const,
      parameterValues: { allowed_topics: "Order support", denied_topics: "Fabricating refund evidence", topic_mode: "strict" }, enabledRuleIds: ["topic/denylist", "topic/allowlist"], ruleActions: {}, enabledRails: ["input" as const], reasoningPolicy: null };
    const draft = { allowedTopics: ["Order support"], restrictedTopics: ["Fabricating refund evidence"], safetyLevel: "balanced" as const, outputDelivery: "full_buffered" as const, policyBindings: [binding] };
    for (const mode of ["strict", "permissive"] as const) {
      binding.parameterValues.topic_mode = mode;
      const cases = generatedTestCases("topic", { ...draft, topicControlMode: mode }, policies);
      expect(cases.find(item => item.coveredRuleIds.includes("topic/allowlist"))?.expectedDecision).toBe(mode === "strict" ? "block" : "allow");
      expect(cases.find(item => item.coveredRuleIds.includes("topic/denylist"))).toMatchObject({ expectedDecision: "block", content: "Please help me with this task: Fabricating refund evidence" });
    }
  });

  it("reports rates and p95 from actual case results", () => {
    const base = {
      caseId: "", name: "", policyId: "", expectedDecision: "allow", actualDecision: "allow",
      passed: true, evaluatorIds: ["local-rules"], evaluationContracts: ["tali.guard.content-filter.rules.v1"],
      escalated: false, modelInvocations: 0, latencyMs: 10, reason: "", phase: "input",
      inputContent: "", action: null, outputContent: "", findings: [], trace: [], trustedInstruction: "",
      targetSource: "user_input", query: "", groundingSources: [], expectedReasoningResult: null,
      actualReasoningResult: null, caseType: "scenario", required: true, expectedFailure: null,
      actualFailure: null, concurrencyGroup: null, sourcePolicyId: null, sourcePolicyVersion: null,
      sourceCaseId: null, coveredRuleIds: [], matchedRuleIds: [],
    } as const;
    const metrics = validationMetrics([
      { ...base, caseId: "one", latencyMs: 10 },
      { ...base, caseId: "two", expectedDecision: "block", actualDecision: "allow", passed: false, escalated: true, modelInvocations: 1, latencyMs: 100 },
    ]);
    expect(metrics).toEqual({
      total: 2, passed: 1, complianceRate: 50, falsePositiveRate: 0,
      falseNegativeRate: 50, escalationRate: 50, p95LatencyMs: 100,
    });
    const unavailable = { ...base, passed: false, actualDecision: "block" as const, escalated: true };
    expect(validationMetrics([
      { ...unavailable, actualFailure: "timeout", latencyMs: 30000 },
      { ...unavailable, actualFailure: "provider_failure", expectedDecision: "block", actualDecision: "allow" },
      { ...unavailable, findings: [{ verdict: "unknown" }] },
      { ...unavailable, expectedDecision: "block", actualDecision: "allow", trace: [{ verdict: "unknown" }] },
      { ...unavailable, findings: [{ verdict: "matched" }] },
      { ...unavailable, expectedDecision: "block", actualDecision: "allow" },
      { ...base }, { ...base },
    ])).toEqual({ total: 8, passed: 2, complianceRate: 25, falsePositiveRate: 12.5,
      falseNegativeRate: 12.5, escalationRate: 75, p95LatencyMs: 30000 });

  });
});

it.each([
  ["model/contextual-grounding", false],
  ["model/automated-reasoning", true],
])("preserves real positive/negative context for %s through both catalog paths", async (ruleId, reasoning) => {
  const { DeclarativeCompiler } = await import("../policy-studio/declarative.js");
  const { buildGuardrailPlan, normalizeGuardrailDraft } = await import("./guardrail-plan.js");
  const directory = resolve("../runner/toolkit/policy_library/assets");
  const compiler = new DeclarativeCompiler(directory);
  const id = "answer-reliability";
  const asset = PolicyCatalog.load(directory).get(id)!;
  const filter = (rules: typeof asset.rules, tests: typeof asset.test_cases) => ({
    rules: rules.filter(rule => rule.id === ruleId),
    tests: tests.filter(test => test.covered_rule_ids.every(covered => covered === ruleId)),
  });
  const shipped = compiler.shipped(id)!;
  shipped.rules = shipped.rules.filter(rule => rule.id === ruleId);
  shipped.tests = shipped.tests.filter(test => test.covered_rule_ids.every(covered => covered === ruleId));
  const assetView = { ...asset, ...filter(asset.rules, asset.test_cases) } as typeof asset;
  const authored = compiler.compile(shipped);
  for (const policy of [assetView, authored]) {
    const draft = normalizeGuardrailDraft({ policyBindings: [{ policyId: id, policyVersion: policy.version,
      enabledRuleIds: policy.rules.map(rule => rule.id), enabledRails: ["output"],
      reasoningPolicy: reasoning ? { policyId: "warranty-duration", policyVersion: "1", confidenceThreshold: .8 } : null }] });
    const cases = generatedTestCases("correctness", draft, [policy]);
    expect(cases).toHaveLength(1);
    expect(cases.map(test => test.expectedDecision)).toEqual(["block"]);
    expect(cases.every(test => test.query === "How long is the warranty?" && test.targetSource === "model_output")).toBe(true);
    expect(cases.map(test => test.content)).toEqual(["The warranty lasts ten years."]);
    if (reasoning) expect(cases.map(test => test.expectedReasoningResult)).toEqual(["invalid"]);
    else expect(cases.every(test => test.groundingSources[0] === "The product warranty lasts one year.")).toBe(true);
    const plan = buildGuardrailPlan({ guardrailId: "correctness", guardrailVersion: "20261013-130000.001Z", policies: [policy], draft });
    expect(plan.steps).toEqual([expect.objectContaining({ on_unsafe: "block" })]);
  }
});
