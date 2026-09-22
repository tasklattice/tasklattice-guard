import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { applyValidationOverrides, generatedTestCases, validationMetrics } from "./validation.js";
import { defaultGuardrailDraft } from "./defaults.js";
import type { ValidationExpectationOverride } from "./guardrail-plan.js";
import { protectionPresets } from "../../shared/protection-presets.js";
import { expandProtectionPreset } from "../policy-catalog/presets.js";

describe("Guardrail Validation contract", () => {
  it("requires explicit pass actions, the original match and unchanged output for observation-only acceptance", () => {
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const draft = defaultGuardrailDraft(policies);
    const cases = generatedTestCases("guardrail-1", draft, policies);
    const observed = applyValidationOverrides(cases, draft).find(item => item.sourcePolicyId === "filter-denied-insults")!;
    expect(observed.expectedDecision).toBe("block");
    expect(observed.expectationOverride).toMatchObject({ expectedDecision: "allow", expectedOutputContent: observed.content,
      expectedMatches: [{ policyId: "filter-denied-insults", ruleId: "category/denied_insults" }] });
    for (const change of ["action", "match", "content"] as const) {
      const changed = structuredClone(draft);
      const binding = changed.policyBindings.find(item => item.policyId === "filter-denied-insults")!;
      const overlay = binding.testCaseOverrides!["accept/denied_insults"]!;
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
      sourcePolicyVersion: "2.0.0", expectedDecision: "block", expectedOutputContent: "",
      expectedMatches: [{ policyId: "filter-harmful-illegal-weapons", ruleId: "category/harmful_illegal_weapons" }],
    });
    expect(reviewed).toHaveLength(321);
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
        policyId: "keyword-blocking", policyVersion: "1.95.0", action: "reject",
        parameterValues: { blocked_words: "restricted phrase" }, enabledRuleIds: ["keyword/blocked-words"],
        ruleActions: {}, enabledRails: ["input"], reasoningPolicy: null,
      }],
    }, policies);

    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      guardrailId: "guardrail-1",
      origin: "generated",
      sourcePolicyId: "keyword-blocking",
      sourcePolicyVersion: "1.95.0",
      sourceCaseId: "accept/blocked-words",
      content: "The phrase restricted phrase is prohibited.",
      expectedDecision: "block",
      coveredRuleIds: ["keyword/blocked-words"],
    });
  });

  it("generates mode-aware unmatched and denied-topic cases", () => {
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const binding = { policyId: "builtin-topic-safety", policyVersion: "1.0.0", action: "reject" as const,
      parameterValues: {}, enabledRuleIds: ["model/topic-control"], ruleActions: {}, enabledRails: ["input" as const], reasoningPolicy: null };
    const draft = { allowedTopics: ["Order support"], restrictedTopics: ["Fabricating refund evidence"], safetyLevel: "balanced" as const, outputDelivery: "full_buffered" as const, policyBindings: [binding] };
    for (const mode of ["strict", "permissive"] as const) {
      const cases = generatedTestCases("topic", { ...draft, topicControlMode: mode }, policies);
      expect(cases.find(item => item.sourceCaseId === "topic-input")?.expectedDecision).toBe(mode === "strict" ? "block" : "allow");
      expect(cases.find(item => item.sourceCaseId === "topic-input/deny-1")).toMatchObject({ expectedDecision: "block", content: "Please help me with this task: Fabricating refund evidence" });
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
  });
});
