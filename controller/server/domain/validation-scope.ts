import type { ValidationTestScope } from "../../shared/validation-scope.js";
import type { FrozenTestCase } from "./test-suite.js";
import type { ValidationCaseResult, ValidationMetrics } from "./models.js";

/** Scope is frozen when requested. Missing/contradictory local-only evidence fails closed. */
export function validateTestScope(
  run: { testModelRules: boolean; testSuite: FrozenTestCase[] | null },
  result: { status: string; metrics: ValidationMetrics; results: Array<Pick<ValidationCaseResult, "caseId" | "passed" | "skipped" | "skipReason" | "modelInvocations"> & { trace?: unknown[]; traceCount?: number }>; testScope?: ValidationTestScope },
): string | null {
  const scope = result.testScope;
  const testModelRules = run.testModelRules !== false;
  if (!scope && testModelRules) {
    return result.results.some(r => r.skipped) ? "Full testing cannot skip model-dependent cases." : null;
  }
  if (!scope || scope.testModelRules !== testModelRules || !scope.fullArtifactLoaded || !/^[a-f0-9]{64}$/.test(scope.executionDigest)) {
    return "The Runner did not confirm the requested test scope and full Artifact load. Upgrade the Runner and test again.";
  }
  const cases = run.testSuite ?? [];
  const byId = new Map(result.results.map(r => [r.caseId, r]));
  if (byId.size !== cases.length || result.results.length !== cases.length || cases.some(c => !byId.has(c.id))) {
    return "The test report does not account for every frozen Test Case.";
  }
  const skipped = result.results.filter(r => r.skipped);
  const executed = result.results.filter(r => !r.skipped);
  const calls = result.results.reduce((n, r) => n + r.modelInvocations, 0);
  if (calls !== scope.modelInvocations || (!testModelRules && calls !== 0)
    || (testModelRules && (skipped.length || scope.skippedRules.length))) {
    return "Model execution or skipped evidence contradicts the requested test scope.";
  }
  for (const c of cases) {
    const r = byId.get(c.id)!;
    const refs = scope.skippedRules;
    const expectedSkipped = refs.some(ref => ref.policyId === (c.sourcePolicyId || c.policyId)
      && (!c.coveredRuleIds.length || c.coveredRuleIds.includes(ref.ruleId)))
      || c.expectationOverride?.expectedMatches.some(m => refs.some(ref => ref.policyId === m.policyId && ref.ruleId === m.ruleId));
    if (Boolean(r.skipped) !== Boolean(expectedSkipped) || (r.skipped && (r.passed || !r.skipReason || (r.trace?.length ?? r.traceCount ?? 0) || r.modelInvocations))) {
      return "Skipped cases must match the excluded Rules and cannot be reported as passed or executed.";
    }
  }
  if (result.metrics.total !== cases.length || result.metrics.skipped !== skipped.length
    || result.metrics.executed !== executed.length || result.metrics.passed !== executed.filter(r => r.passed).length) {
    return "Test metrics do not match the executed and skipped cases.";
  }
  if (result.status === "passed" && (!cases.some(c => c.required && !byId.get(c.id)!.skipped)
    || cases.some(c => c.required && !byId.get(c.id)!.skipped && !byId.get(c.id)!.passed))) {
    return "Publication requires at least one executed required case and all required cases to pass.";
  }
  return null;
}
