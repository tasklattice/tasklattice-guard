import { describe, expect, it } from "vitest";
import { hasRuntimeError } from "./runtime-outcome.js";

const failedTrace = [{ id: "sibling", status: "error", verdict: "error", timedOut: true }];
describe("Guardrail execution outcome", () => {
  it.each(["complete", "degraded", "bypassed"])("trusts %s despite independent failed evidence", executionStatus => {
    expect(hasRuntimeError({ decision: "block", metadata: {
      executionStatus, trace: failedTrace,
      findings: [{ verdict: "error" }], timedOut: true,
    } })).toBe(false);
  });
  it.each(["error", "timeout"])("recognizes %s even without an error span", executionStatus => {
    expect(hasRuntimeError({ decision: "block", metadata: { executionStatus } })).toBe(true);
  });
  it("does not derive execution status from findings, trace or disposition", () => {
    expect(hasRuntimeError({ decision: "block", metadata: { trace: failedTrace } })).toBe(false);
    expect(hasRuntimeError({ decision: "error", metadata: { executionStatus: "complete" } })).toBe(false);
  });
});
