import { createHash } from "node:crypto";
import { canonicalJson } from "../../shared/canonical-json.js";
import type { ValidationExpectationOverride } from "./guardrail-plan.js";

/**
 * One Test Case as frozen into a Guardrail version: the input and the expected
 * behaviour, nothing about who edited it or when. A version's test suite is
 * part of its static definition, next to its Policies, and travels with it.
 */
export type FrozenTestCase = {
  id: string;
  name: string;
  /** "generated" from a Policy, or "custom" for this Guardrail. */
  origin: string;
  policyId: string;
  phase: string;
  content: string;
  expectedDecision: string;
  trustedInstruction: string;
  targetSource: string;
  query: string;
  groundingSources: string[];
  expectedReasoningResult: string | null;
  caseType: string;
  required: boolean;
  expectedFailure: string | null;
  concurrencyGroup: string | null;
  sourcePolicyId: string | null;
  sourcePolicyVersion: string | null;
  sourceCaseId: string | null;
  coveredRuleIds: string[];
  expectationOverride: ValidationExpectationOverride | null;
};

type CaseRow = Omit<FrozenTestCase, "expectationOverride"> & { expectationOverride?: ValidationExpectationOverride };

/** The suite a test run executes, in a stable order and shape. */
export function freezeTestSuite(cases: readonly CaseRow[]): FrozenTestCase[] {
  return [...cases].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0).map(item => ({
    id: item.id, name: item.name, origin: item.origin, policyId: item.policyId, phase: item.phase, content: item.content,
    expectedDecision: item.expectedDecision, trustedInstruction: item.trustedInstruction, targetSource: item.targetSource,
    query: item.query, groundingSources: [...item.groundingSources], expectedReasoningResult: item.expectedReasoningResult ?? null,
    caseType: item.caseType, required: item.required, expectedFailure: item.expectedFailure ?? null,
    concurrencyGroup: item.concurrencyGroup ?? null, sourcePolicyId: item.sourcePolicyId ?? null,
    sourcePolicyVersion: item.sourcePolicyVersion ?? null, sourceCaseId: item.sourceCaseId ?? null,
    coveredRuleIds: [...item.coveredRuleIds], expectationOverride: item.expectationOverride ?? null,
  }));
}

export function testSuiteDigest(suite: readonly FrozenTestCase[]): string {
  return createHash("sha256").update(canonicalJson(suite)).digest("hex");
}
