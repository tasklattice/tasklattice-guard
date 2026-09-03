import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { applyValidationOverrides, generatedTestCases, validationMetrics } from "./validation.js";
import { defaultGuardrailDraft } from "./defaults.js";
import type { ValidationExpectationOverride } from "./guardrail-plan.js";

describe("Guardrail Validation contract", () => {
  it("preserves template assertions while applying version-pinned local composition expectations", () => {
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const draft = defaultGuardrailDraft(policies);
    const cases = generatedTestCases("guardrail-1", draft, policies);
    const original = structuredClone(cases);
    const reviewed = applyValidationOverrides(cases, draft);
    const credential = reviewed.find((item) => item.sourcePolicyId === "pattern-matching" && item.sourceCaseId === "accept/slack_token")!;
    expect(credential.expectedDecision).toBe("transform");
    expect(credential.expectationOverride).toMatchObject({
      sourcePolicyVersion: "1.95.0", expectedDecision: "block", expectedOutputContent: "",
      expectedMatches: [{ policyId: "baseline-pii-protection", ruleId: "credentials-api-keys/slack_token" }],
    });
    expect(reviewed).toHaveLength(140);
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
      mutate(draft.policyBindings.find((item) => item.policyId === "pattern-matching")!.testCaseOverrides!["accept/uae_emirates_id"]!);
      expect(() => applyValidationOverrides(generatedTestCases("guardrail-1", draft, policies), draft)).toThrow(message);
    }
    const draft = defaultGuardrailDraft(policies);
    const cases = generatedTestCases("guardrail-1", draft, policies).filter((item) => item.sourceCaseId !== "accept/uae_emirates_id");
    expect(() => applyValidationOverrides(cases, draft)).toThrow(/unavailable Test Case/);
  });
  it("inherits only enabled catalog Rule cases and materializes binding parameters", () => {
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const cases = generatedTestCases("guardrail-1", {
      purposeDetails: { audience: "", tasks: "", protect: "", outOfScope: "" },
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
