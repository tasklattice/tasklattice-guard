import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { generatedTestCases, validationMetrics } from "./validation.js";

describe("Guardrail Validation contract", () => {
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
      passed: true, stageReached: "deterministic", latencyMs: 10, reason: "", phase: "input",
      inputContent: "", action: null, outputContent: "", findings: [], trace: [], trustedInstruction: "",
      targetSource: "user_input", query: "", groundingSources: [], expectedReasoningResult: null,
      actualReasoningResult: null, caseType: "scenario", required: true, expectedFailure: null,
      actualFailure: null, concurrencyGroup: null, sourcePolicyId: null, sourcePolicyVersion: null,
      sourceCaseId: null, coveredRuleIds: [], matchedRuleIds: [],
    } as const;
    const metrics = validationMetrics([
      { ...base, caseId: "one", latencyMs: 10 },
      { ...base, caseId: "two", expectedDecision: "block", actualDecision: "allow", passed: false, stageReached: "deep_judge", latencyMs: 100 },
    ]);
    expect(metrics).toEqual({
      total: 2, passed: 1, complianceRate: 50, falsePositiveRate: 0,
      falseNegativeRate: 50, deepEscalationRate: 50, p95LatencyMs: 100,
    });
  });
});
