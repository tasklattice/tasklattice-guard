import type { ValidationExpectationOverride } from "./guardrail-plan.js";
import reviewed from "./default-expectations.json" with { type: "json" };

// Reviewed cross-Rule outcomes: first block wins and earlier redactions remain authoritative.
// These expectations retain the pre-consolidation Default behavior.
export function defaultTestCaseOverrides(policyId: string): Record<string, ValidationExpectationOverride> {
  const overrides = structuredClone((reviewed as Record<string, Record<string, ValidationExpectationOverride>>)[policyId] ?? {});
  return overrides;
}
