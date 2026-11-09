import { describe, expect, it } from "vitest";
import { validateTestScope } from "./validation-scope.js";
import type { FrozenTestCase } from "./test-suite.js";
import type { ValidationCaseResult } from "./models.js";

function fixture() {
  const testSuite = ["local", "model"].map(id => ({ id, policyId: id, coveredRuleIds: [id], required: true })) as FrozenTestCase[];
  return { run: { testModelRules: false, testSuite }, result: { status: "passed",
    metrics: { total: 2, skipped: 1, executed: 1, passed: 1, complianceRate: 100, falsePositiveRate: 0, falseNegativeRate: 0, escalationRate: 0, p95LatencyMs: 1 },
    testScope: { testModelRules: false, skippedRules: [{ policyId: "model", ruleId: "model", reason: "model" }], modelInvocations: 0, executionDigest: "a".repeat(64), fullArtifactLoaded: true },
    results: [ { caseId: "local", passed: true, trace: [], modelInvocations: 0 }, { caseId: "model", passed: false, skipped: true, skipReason: "model", trace: [], modelInvocations: 0 } ] as ValidationCaseResult[],
  } };
}
describe("Frozen local test scope", () => {
  it("accepts all required local cases passed with model cases explicitly skipped", () => {
    const { run, result } = fixture(); expect(validateTestScope(run, result)).toBeNull();
  });
  it.each(["missing", "wrong scope", "unloaded", "missing case", "duplicate case", "model call", "local skipped", "skipped passed", "local failure", "all skipped", "metrics"])("rejects %s evidence", kind => {
    const { run, result } = fixture();
    if (kind === "missing") delete (result as { testScope?: unknown }).testScope;
    if (kind === "wrong scope") result.testScope.testModelRules = true;
    if (kind === "unloaded") result.testScope.fullArtifactLoaded = false;
    if (kind === "missing case") result.results.pop();
    if (kind === "duplicate case") result.results[1]!.caseId = "local";
    if (kind === "model call") result.results[0]!.modelInvocations = result.testScope.modelInvocations = 1;
    if (kind === "local skipped") result.results[0]!.skipped = true;
    if (kind === "skipped passed") result.results[1]!.passed = true;
    if (kind === "local failure") { result.results[0]!.passed = false; result.metrics.passed = 0; }
    if (kind === "all skipped") { run.testSuite.shift(); result.results.shift(); result.metrics = { ...result.metrics, total: 1, executed: 0, passed: 0 }; }
    if (kind === "metrics") result.metrics.passed = 2;
    expect(validateTestScope(run, result)).not.toBeNull();
  });
});
