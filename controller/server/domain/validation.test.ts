import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { applyValidationOverrides, generatedTestCases, validationMetrics } from "./validation.js";
import { defaultGuardrailDraft } from "./defaults.js";
import type { ValidationExpectationOverride } from "./guardrail-plan.js";
import { protectionPresets } from "../../shared/protection-presets.js";
import { expandProtectionPreset } from "../policy-catalog/presets.js";

describe("Guardrail Validation contract", () => {
  it("inherits a multi-Rule scenario only when every covered Rule is enabled, through both catalog paths", async () => {
    const { DeclarativeCompiler } = await import("../policy-studio/declarative.js");
    const directory = resolve("../runner/toolkit/policy_library/assets");
    const compiler = new DeclarativeCompiler(directory);
    const asset = PolicyCatalog.load(directory).get("local-credentials")!;
    const authored = compiler.compile(compiler.shipped(asset.id)!);
    for (const policy of [asset, authored]) {
      const scenario = policy.test_cases.find(test => test.covered_rule_ids.length > 1)!;
      expect(scenario).toBeDefined();
      const binding = { policyId: policy.id, policyVersion: policy.version, action: "transform" as const,
        parameterValues: {}, enabledRuleIds: scenario.covered_rule_ids.slice(0, 1), ruleActions: {},
        enabledRails: [scenario.phase as "input" | "output"], reasoningPolicy: null };
      const draft = { allowedTopics: [], restrictedTopics: [], safetyLevel: "balanced" as const,
        outputDelivery: "full_buffered" as const, policyBindings: [binding] };
      expect(generatedTestCases("partial", draft, [policy]).some(test => test.sourceCaseId === scenario.id)).toBe(false);
      binding.enabledRuleIds = [...scenario.covered_rule_ids];
      expect(generatedTestCases("complete", draft, [policy]).some(test => test.sourceCaseId === scenario.id)).toBe(true);
    }
  });

  it("requires explicit pass actions, the original match and unchanged output for observation-only acceptance", () => {
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const draft = defaultGuardrailDraft(policies);
    const cases = generatedTestCases("guardrail-1", draft, policies);
    const observed = applyValidationOverrides(cases, draft).filter(item => item.sourcePolicyId === "local-content-safety" && item.coveredRuleIds.includes("category/denied_insults"));
    expect(observed.map(item => item.phase)).toEqual(["input", "output"]);
    for (const test of observed) {
      expect(test.expectedDecision).toBe("block");
      expect(test.expectationOverride).toMatchObject({ expectedDecision: "allow", expectedOutputContent: test.content,
        expectedMatches: [{ policyId: "local-content-safety", ruleId: "category/denied_insults" }] });
    }
    for (const change of ["action", "match", "content"] as const) {
      const changed = structuredClone(draft);
      const binding = changed.policyBindings.find(item => item.policyId === "local-content-safety")!;
      const overlay = binding.testCaseOverrides!["filter-denied-insults/accept/denied_insults"]!;
      if (change === "action") binding.ruleActions = {};
      if (change === "match") overlay.expectedMatches = [{ policyId: "local-credentials", ruleId: "unrelated" }];
      if (change === "content") overlay.expectedOutputContent = "changed";
      expect(() => applyValidationOverrides(cases, changed)).toThrow(/Cannot weaken/);
    }
  });
  it("does not generate Output assertions after the user selects Input-only protection", () => {
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const binding = expandProtectionPreset(protectionPresets[0]!, policies)[0]!;
    binding.enabledRails = ["input"];
    const cases = generatedTestCases("input-only", { allowedTopics: [], restrictedTopics: [], safetyLevel: "balanced", outputDelivery: "full_buffered", policyBindings: [binding] }, policies);
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every((item) => item.phase === "input")).toBe(true);
  });
  it("preserves template assertions while applying version-pinned local composition expectations", () => {
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const draft = defaultGuardrailDraft(policies);
    const cases = generatedTestCases("guardrail-1", draft, policies);
    const original = structuredClone(cases);
    const reviewed = applyValidationOverrides(cases, draft);
    const overlap = reviewed.find((item) => item.sourcePolicyId === "local-risk-content-terms" && item.sourceCaseId === "accept/weapons_firearms/input")!;
    expect(overlap.expectedDecision).toBe("transform");
    expect(overlap.expectationOverride).toMatchObject({
      sourcePolicyVersion: "1.0.0", expectedDecision: "block", expectedOutputContent: "",
      expectedMatches: [{ policyId: "local-content-safety", ruleId: "category/harmful_illegal_weapons" }],
    });
    expect(reviewed.length).toBeGreaterThanOrEqual(385);
    expect(reviewed.every((item) => item.required)).toBe(true);
    expect(cases).toEqual(original);
  });

  it("rejects stale, unreviewed, missing-evidence and incomplete-output overrides", () => {
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const changes: Array<[(item: ValidationExpectationOverride) => void, RegExp]> = [
      [(item) => { item.sourcePolicyVersion = "old"; }, /stale/],
      [(item) => { item.reason = ""; }, /Invalid reviewed/],
      [(item) => { item.expectedMatches = []; }, /Invalid reviewed/],
      [(item) => { delete item.expectedOutputContent; }, /complete output/],
      [(item) => { item.expectedMatches[0]!.ruleId = "unknown"; }, /not enabled/],
      [(item) => { item.expectedDecision = "allow"; }, /Cannot weaken/],
    ];
    for (const [mutate, message] of changes) {
      const draft = defaultGuardrailDraft(policies);
      mutate(draft.policyBindings.find((item) => item.policyId === "local-government-identifiers")!.testCaseOverrides!["accept/uae_emirates_id/input"]!);
      expect(() => applyValidationOverrides(generatedTestCases("guardrail-1", draft, policies), draft)).toThrow(message);
    }
    const draft = defaultGuardrailDraft(policies);
    const cases = generatedTestCases("guardrail-1", draft, policies).filter((item) => item.sourceCaseId !== "accept/uae_emirates_id/input");
    expect(() => applyValidationOverrides(cases, draft)).toThrow(/unavailable Test Case/);
  });
  it("inherits only enabled catalog Rule cases and materializes binding parameters", () => {
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const cases = generatedTestCases("guardrail-1", {
      allowedTopics: [], restrictedTopics: [], safetyLevel: "balanced", outputDelivery: "full_buffered",
      policyBindings: [{
        policyId: "keyword-blocking", policyVersion: "1.0.0", action: "block",
        parameterValues: { blocked_words: "restricted phrase" }, enabledRuleIds: ["keyword/blocked-words"],
        ruleActions: {}, enabledRails: ["input"], reasoningPolicy: null,
      }],
    }, policies);

    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      guardrailId: "guardrail-1",
      origin: "generated",
      sourcePolicyId: "keyword-blocking",
      sourcePolicyVersion: "1.0.0",
      sourceCaseId: "accept/blocked-words",
      content: "The phrase restricted phrase is prohibited.",
      expectedDecision: "block",
      coveredRuleIds: ["keyword/blocked-words"],
    });
  });

  it("generates mode-aware unmatched and denied-topic cases", () => {
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const binding = { policyId: "builtin-topic-safety", policyVersion: "1.0.0", action: "block" as const,
      parameterValues: { allowed_topics: "Order support", denied_topics: "Fabricating refund evidence", topic_mode: "strict" }, enabledRuleIds: ["topic/denylist", "topic/allowlist"], ruleActions: {}, enabledRails: ["input" as const], reasoningPolicy: null };
    const draft = { allowedTopics: ["Order support"], restrictedTopics: ["Fabricating refund evidence"], safetyLevel: "balanced" as const, outputDelivery: "full_buffered" as const, policyBindings: [binding] };
    for (const mode of ["strict", "permissive"] as const) {
      binding.parameterValues.topic_mode = mode;
      const cases = generatedTestCases("topic", { ...draft, topicControlMode: mode }, policies);
      expect(cases.find(item => item.sourceCaseId === "topic-unlisted")?.expectedDecision).toBe(mode === "strict" ? "block" : "allow");
      expect(cases.find(item => item.sourceCaseId === "topic-denied/1")).toMatchObject({ expectedDecision: "block", content: "Please help me with this task: Fabricating refund evidence" });
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

it.each(["builtin-contextual-grounding", "builtin-automated-reasoning"])("preserves real positive/negative context for %s through both catalog paths", async (id) => {
  const { DeclarativeCompiler } = await import("../policy-studio/declarative.js");
  const { buildGuardrailPlan, normalizeGuardrailDraft } = await import("./guardrail-plan.js");
  const directory = resolve("../runner/toolkit/policy_library/assets");
  const compiler = new DeclarativeCompiler(directory);
  const asset = PolicyCatalog.load(directory).get(id)!;
  const authored = compiler.compile(compiler.shipped(id)!);
  for (const policy of [asset, authored]) {
    const draft = normalizeGuardrailDraft({ policyBindings: [{ policyId: id, policyVersion: policy.version,
      enabledRuleIds: policy.rules.map(rule => rule.id), enabledRails: ["output"],
      reasoningPolicy: id === "builtin-automated-reasoning" ? { policyId: "warranty-duration", policyVersion: "1", confidenceThreshold: .8 } : null }] });
    const cases = generatedTestCases("correctness", draft, [policy]);
    expect(cases).toHaveLength(2);
    expect(cases.map(test => test.expectedDecision)).toEqual(["block", "allow"]);
    expect(cases.every(test => test.query === "How long is the warranty?" && test.targetSource === "model_output")).toBe(true);
    expect(cases.map(test => test.content)).toEqual(["The warranty lasts ten years.", "The warranty lasts one year."]);
    if (id === "builtin-contextual-grounding") {
      expect(cases.every(test => test.groundingSources[0] === "The product warranty lasts one year.")).toBe(true);
    } else {
      expect(cases.map(test => test.expectedReasoningResult)).toEqual(["invalid", "valid"]);
    }
    const plan = buildGuardrailPlan({ guardrailId: "correctness", guardrailVersion: "20261013-130000.001Z", policies: [policy], draft });
    expect(plan.steps).toEqual([expect.objectContaining({ on_unsafe: "block" })]);
  }
});
