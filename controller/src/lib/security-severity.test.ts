import { describe, expect, it } from "vitest";
import { runtimeFindings } from "./controller-api-mappers";
import { highestSeverity } from "../../shared/security-severity";
import type { RuntimeEvent } from "./controller-api";
const event = (findings: unknown[]): RuntimeEvent => ({ id: "event", requestId: "request", occurredAt: "2026-09-29T00:00:00Z", runnerId: "runner", guardrailId: "guard", guardrailVersion: "20260929-000000.000Z", routerId: null, endpointId: null, direction: "incoming", decision: "allow", durationMs: 1, metadata: { findings } });
describe("Rule risk snapshots", () => {
  it.each(["allow", "block", "transform", "transform", "block", "block", "block", "block"])("keeps high risk with %s regardless of confidence", recommendedAction => {
    const findings = runtimeFindings(event([0.1, 0.99, null].map(confidence => ({ verdict: "matched", riskSeverity: "high", confidence, recommendedAction, policyVersion: "7" }))));
    expect(findings.map(f => f.severity)).toEqual(["high", "high", "high"]);
    expect(findings.every(f => f.policy_version === "7" && f.recommended_action === recommendedAction)).toBe(true);
  });
  it("does not reclassify old evidence or trust the old derived severity", () => {
    expect(runtimeFindings(event([{ verdict: "matched", severity: "critical", confidence: 1, recommendedAction: "block" }]))[0]?.severity).toBe("unclassified");
  });
  it("separates safe and failed checks from events while preserving uncertain detections", () => {
    const findings = runtimeFindings(event(["not_matched", "error", "matched", "unknown"].map(verdict => ({ verdict, riskSeverity: "informational" }))));
    expect(findings.map(f => f.verdict)).toEqual(["matched", "unknown"]);
    expect(findings.map(f => f.severity)).toEqual(["informational", "informational"]);
  });
  it("summarizes the highest risk instead of the first match", () => {
    expect(highestSeverity(["low", "critical", "high", "unclassified"])).toBe("critical");
    expect(highestSeverity(["unclassified"])).toBe("unclassified");
    expect(highestSeverity([])).toBeNull();
  });
});
