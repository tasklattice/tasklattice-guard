// @vitest-environment node
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDatabase, withTestProject } from "../db/postgres-test-database.js";
import { stageCases } from "../db/report-test-utils.js";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { preparePolicyVersionTest } from "../domain/policy-version-test.js";
import type { ValidationCaseResult } from "../domain/models.js";
import { PolicyResourceService } from "./policy-resources.js";
import { ReportResults } from "./report-results.js";
import { ControlPlaneService } from "./control-plane.js";
import { runWithProjectContext } from "./project-context.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("project-scoped Policy version reports", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let service: PolicyResourceService;
  let reports: ReportResults;
  const directory = resolve("../runner/toolkit/policy_library/assets");
  const environment = { poolId: "default", modelRevisionId: "revision-1", models: [] };
  beforeAll(async () => {
    database = await createTestDatabase(url!, "policy_version_tests");
    reports = new ReportResults(database.db);
    service = new PolicyResourceService(database.db, directory, () => [], reports);
    await database.pool.query("INSERT INTO auth_user(id,username,email,role) VALUES('tester','Tester','tester@example.test','user')");
  });
  afterAll(async () => database?.drop());
  const prepare = (id = "business-topics") => preparePolicyVersionTest(service.compiler.catalogView(PolicyCatalog.load(directory).get(id)!));

  it("tests catalog versions without editable resources and isolates concurrent runs by project", async () => {
    const prepared = prepare();
    const run = await withTestProject(() => service.validateVersion(prepared, environment, "tester"));
    expect(run).toMatchObject({ status: "queued", total: prepared.tests.length, snapshot: { version: prepared.version, environment } });
    expect((await database.pool.query("SELECT count(*)::int n FROM policy_resource")).rows[0].n).toBe(0);
    await expect(withTestProject(() => service.validateVersion(prepared, environment, "tester"))).rejects.toThrow("already being tested");
    await runWithProjectContext({ projectId: "projectB", role: "user" }, async () => {
      expect(await service.versionReport(prepared.policyId, prepared.version, run.id)).toBeNull();
      const getPolicy = vi.fn();
      await expect(ControlPlaneService.prototype.authorizeReportRead.call({ db: database.db, getPolicy } as unknown as ControlPlaneService, run.id)).rejects.toThrow("Testing Report");
      expect(getPolicy).not.toHaveBeenCalled();
      const other = await service.validateVersion(prepared, environment, "tester");
      expect(other.id).not.toBe(run.id);
    });
    const jobs = (await database.pool.query("SELECT v.id, v.tests, o.aggregate_id, o.payload FROM policy_resource_validation v JOIN controller_outbox o ON o.id=v.id WHERE v.parent_id=$1", [run.id])).rows;
    expect(jobs).toHaveLength(prepared.jobs.length);
    expect(jobs.every(j => j.aggregate_id === j.id && j.payload.testPoolId === "default" && j.payload.testModelRevisionId === "revision-1")).toBe(true);
    for (const job of jobs) {
      await service.running(job.id);
      await service.complete({ runId: job.id, status: "failed", executionFailed: true, reason: "Model configuration changed" });
    }
    const result = await withTestProject(() => service.versionReport(prepared.policyId, prepared.version, run.id));
    expect(result).toMatchObject({ status: "failed", completed: prepared.tests.length, passed: 0 });
    const page = await reports.page(run.id, {});
    expect(page.items).toHaveLength(prepared.tests.length);
    expect((await reports.detail(run.id, 0)).reason).toContain("Model configuration changed");
  });

  it("keeps passed and failed cases with full evidence past the trace page boundary", async () => {
    const prepared = prepare("content-safety-model");
    const run = await withTestProject(() => service.validateVersion(prepared, environment, "tester"));
    const jobs = (await database.pool.query("SELECT * FROM policy_resource_validation WHERE parent_id=$1 ORDER BY id", [run.id])).rows;
    let index = 0;
    for (const job of jobs) {
      const results = job.tests.map((test: typeof prepared.tests[number]) => {
        const passed = index++ === 0;
        return { caseId: test.id, name: test.name, policyId: prepared.policyId, passed, actualDecision: passed ? test.expected_decision : "allow", expectedDecision: test.expected_decision,
          sourcePolicyId: prepared.policyId, reason: passed ? "Passed" : "Model did not detect the unsafe sample", inputContent: test.content, outputContent: "",
          findings: passed ? test.covered_rule_ids.map(rule_id => ({ rule_id, policy_id: prepared.policyId, verdict: "matched" })) : [],
          trace: Array.from({ length: 105 }, (_, n) => ({ kind: "model_http_evidence", detail: `exchange-${n}`, evidence: JSON.stringify({ response: { status: 200 }, request: { method: "POST" } }) })),
        } as unknown as ValidationCaseResult;
      });
      await stageCases(reports, job.id, results);
      await service.complete({ runId: job.id, status: results.every(r => r.passed) ? "passed" : "failed" });
    }
    const result = await withTestProject(() => service.versionReport(prepared.policyId, prepared.version, run.id));
    expect(result).toMatchObject({ status: "failed", passed: 1, completed: prepared.tests.length });
    expect((await reports.detail(run.id, 0)).trace).toHaveLength(100);
    const exported = [];
    for await (const item of reports.exportCases(run.id)) exported.push(item);
    expect(exported).toHaveLength(prepared.tests.length);
    expect(exported.every(item => item.trace.length === 105)).toBe(true);
    expect(exported.map(item => item.passed).sort()).toEqual([false, true]);
    expect(exported.every(item => item.sourcePolicyVersion === prepared.version)).toBe(true);
    for (const item of exported) expect(item).toMatchObject({ testDefinition: prepared.tests.find(test => test.id === item.caseId) });
  });
});
