import { describe, expect, it } from "vitest";
import { describeDraftChanges, sameDraftContent, type DraftSnapshot } from "./guardrail-draft-changes.js";

const binding = (policyId: string) => ({ policyId, policyVersion: "1", action: null, parameterValues: { a: "1", b: "2" }, enabledRuleIds: ["a", "b"], enabledRails: ["input" as const], ruleActions: {}, ruleOrder: ["a", "b"], reasoningPolicy: null });
const baseline: DraftSnapshot = {
  draftConfig: { policyBindings: [binding("credentials"), binding("contact")], allowedTopics: [], restrictedTopics: [], safetyLevel: "balanced", outputDelivery: "full_buffered" },
  runtimeProfile: "auto", loggingLevel: "info", excludedTestCaseIds: ["case-2", "case-1"],
  testCases: [{ id: "custom", guardrailId: "guard", name: "Test", phase: "input", content: "example", policyId: "custom", expectedDecision: "block", origin: "custom", updatedAt: new Date(0) }],
};

describe("Meaningful Guardrail draft changes", () => {
  it("ignores storage timestamps, logging, object key order and unordered sets", () => {
    const current = structuredClone(baseline);
    current.loggingLevel = "trace";
    current.excludedTestCaseIds.reverse();
    current.testCases![0]!.updatedAt = new Date();
    current.draftConfig.policyBindings[0]!.parameterValues = { b: "2", a: "1" };
    current.draftConfig.policyBindings[0]!.enabledRuleIds.reverse();
    expect(sameDraftContent(baseline, current)).toBe(true);
    expect(describeDraftChanges(baseline, current)).toEqual([]);
  });

  it("detects Policy and Rule order changes even with the same members", () => {
    const current = structuredClone(baseline);
    current.draftConfig.policyBindings.reverse();
    current.draftConfig.policyBindings[0]!.ruleOrder!.reverse();
    expect(sameDraftContent(baseline, current)).toBe(false);
    expect(describeDraftChanges(baseline, current)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "policyOrder", before: "credentials\ncontact", after: "contact\ncredentials" }),
      expect.objectContaining({ kind: "policyUpdated", field: "ruleOrder" }),
    ]));
  });

  it("includes custom test expectations and exclusions in the publication state", () => {
    const current = structuredClone(baseline);
    current.testCases![0]!.expectedDecision = "allow";
    current.excludedTestCaseIds = [];
    expect(sameDraftContent(baseline, current)).toBe(false);
    expect(describeDraftChanges(baseline, current).map(c => c.kind)).toEqual(["caseUpdated", "testScope"]);
  });

  it("distinguishes excluded inherited cases with identical names", () => {
    const before = structuredClone(baseline);
    before.testCases = ["input", "output"].map(phase => ({ ...baseline.testCases![0]!, id: phase, phase, origin: "generated" }));
    before.excludedTestCaseIds = ["input"];
    const after = { ...before, excludedTestCaseIds: ["output"] };
    expect(describeDraftChanges(before, after)).toEqual([expect.objectContaining({ kind: "testScope", before: "Test · input · input", after: "Test · output · output" })]);
  });
});
