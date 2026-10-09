// @vitest-environment node
import { describe, expect, it } from "vitest";
import { freezeTestSuite, testSuiteDigest } from "./test-suite.js";

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: `Case ${id}`, origin: "generated", policyId: "pii", phase: "input", content: `content ${id}`, expectedDecision: "block",
  trustedInstruction: "", targetSource: "user_input", query: "", groundingSources: [], expectedReasoningResult: null, caseType: "scenario",
  required: true, expectedFailure: null, concurrencyGroup: null, sourcePolicyId: "pii", sourcePolicyVersion: "1.0.0", sourceCaseId: id,
  coveredRuleIds: ["pii/email"], guardrailId: "guard", updatedAt: new Date(), ...extra,
});

describe("frozen test suite", () => {
  it("keeps only the definition, in a stable order", () => {
    const suite = freezeTestSuite([row("b"), row("a")]);
    expect(suite.map(item => item.id)).toEqual(["a", "b"]);
    expect(suite[0]).not.toHaveProperty("updatedAt");
    expect(suite[0]).not.toHaveProperty("guardrailId");
    expect(suite[0]).toMatchObject({ expectationOverride: null, sourcePolicyVersion: "1.0.0" });
  });

  it("digests the definition: edit times and row order do not change it, content does", () => {
    const digest = testSuiteDigest(freezeTestSuite([row("a"), row("b")]));
    expect(testSuiteDigest(freezeTestSuite([row("b", { updatedAt: new Date(0) }), row("a")]))).toBe(digest);
    expect(testSuiteDigest(freezeTestSuite([row("a", { expectedDecision: "allow" }), row("b")]))).not.toBe(digest);
    const override = { sourcePolicyVersion: "1.0.0", reason: "Reviewed", expectedDecision: "allow" as const, expectedMatches: [] };
    expect(testSuiteDigest(freezeTestSuite([row("a", { expectationOverride: override }), row("b")]))).not.toBe(digest);
  });
});
