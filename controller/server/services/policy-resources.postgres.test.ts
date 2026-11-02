import { createTestDatabase } from "../db/postgres-test-database.js";
import { ReportResults } from "./report-results.js";
import { stageCases } from "../db/report-test-utils.js";
// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../db/schema.js";
import { emptyPolicyDefinition } from "../../shared/policy-definition.js";
import type { ValidationCaseResult } from "../domain/models.js";
import { PolicyResourceService } from "./policy-resources.js";
import { buildGuardrailPlan, normalizeGuardrailDraft } from "../domain/guardrail-plan.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("declarative Policy transactions", () => {
  const namespace = `policy_resources_${randomUUID().replaceAll("-", "")}`;
  let database:Awaited<ReturnType<typeof createTestDatabase>>; let pool: Pool; let service: PolicyResourceService; let reports:ReportResults;
  async function complete(input:Parameters<PolicyResourceService["complete"]>[0] & {results:ValidationCaseResult[]}) { await stageCases(reports,input.runId,input.results); const {results:_results,...metadata}=input;return service.complete(metadata); }
  beforeAll(async () => {
    expect(["localhost", "127.0.0.1"]).toContain(new URL(url!).hostname);
    database=await createTestDatabase(url!,"policy_reports");pool=database.pool;reports=new ReportResults(database.db);
    await pool.query("INSERT INTO auth_user(id,name,email,role) VALUES('test','Test','test@example.test','admin')");
    service = new PolicyResourceService(database.db,resolve("../runner/toolkit/policy_library/assets"),()=>[],reports);
  });
  afterAll(async()=>database?.drop());
  it("saves a card, isolates each Rule, publishes idempotently and invalidates edited drafts", async () => {
    const definition = emptyPolicyDefinition(); definition.metadata.name = "Two Rules";
    definition.rules = ["first", "second"].map(id => ({ id, name: id, description: "", stages: ["input"], detector: { ref: "text/keyword", version: "1.0.0", parameters: { detector_options: { terms: [id] } } }, on_match: { action: "block" }, risk_level: "medium", metadata: { taxonomy_ids: ["TALI-BUSINESS-POLICY"] } }));
    definition.tests = definition.rules.map(r => ({ id: r.id, name: r.name, description: "", phase: "input", content: r.id, expected_decision: "block", covered_rule_ids: [r.id], kind: "rule_acceptance", scope: "rule", required: true, group: "Tests", parameter_names: [] }));
    const id = definition.metadata.id;
    const first = await service.save({ definition, maintainer: "Test", expectedRevision: 0, actorId: "test", create: true });
    expect(first.revision).toBe(1); expect((await service.views([]))[0]!.version).toBe("0");
    expect((await service.save({ definition, maintainer: "Test", expectedRevision: 1, actorId: "test" })).revision).toBe(1);
    await expect(service.publish(id, 1, "test")).rejects.toThrow("must pass");
    const report = await service.validate(id, "test", true);
    const jobs = (await pool.query("SELECT * FROM policy_resource_validation WHERE parent_id=$1", [report.id])).rows;
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      const test = job.tests[0];
      const actual = { caseId: test.id, name: test.name, actualDecision: "block", passed: true, modelInvocations: 1, sourcePolicyId: id, outputContent: "", findings: [{ policy_id: id, rule_id: test.id, verdict: "matched" }] } as ValidationCaseResult;
      await service.running(job.id); await complete({ runId: job.id, status: "passed", results: [actual] });
    }
    expect((await service.report(id))?.status).toBe("passed");
    const completed=(await service.report(id))!;
    const page=await reports.page(completed.id,{});
    expect(page.items.map(result=>result.modelInvocations)).toEqual([1,1]);
    expect(page.items.every(result=>result.caseType==="rule_acceptance" && result.ruleContractSatisfied===true)).toBe(true);
    expect((await pool.query("SELECT count(*)::int n FROM validation_report_detail")).rows[0].n).toBe(2);
    const published = await Promise.all(Array.from({ length: 6 }, () => service.publish(id, 1, "test")));
    expect(new Set(published.map(p => p.version)).size).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM policy_resource_version")).rows[0].count).toBe(1);
    const changed = { ...definition, metadata: { ...definition.metadata, name: "Changed draft" } };
    const attempts = await Promise.allSettled([1, 2].map(() => service.save({ definition: changed, maintainer: "Test", expectedRevision: 1, actorId: "test" })));
    expect(attempts.filter(r => r.status === "fulfilled")).toHaveLength(1);
    await expect(service.publish(id, 2, "test")).rejects.toThrow("must pass");
    expect((await service.publish(id, 1, "test")).version).toBe(published[0]!.version);
    const views = await service.views([]); expect(views[0]!.name).toBe("Two Rules"); expect(views[0]!.maintenance?.revision).toBe(2);
  });
  it("uses declared test parameters to isolate generated phrase Rules", async () => {
    const definition = service.compiler.shipped("configured-phrase-filter")!;
    definition.metadata.id = "test-phrases";
    definition.testing = { parameters: { phrase_entries: JSON.stringify([{ id: "a", phrase: "alpha", action: "block" }, { id: "b", phrase: "beta", action: "transform", replacement: "[hidden]" }]) } };
    await service.save({ definition, maintainer: "Test", expectedRevision: 0, actorId: "test", create: true });
    const report = await service.validate(definition.metadata.id, "test", true);
    const jobs = (await pool.query("SELECT v.tests, o.payload FROM policy_resource_validation v JOIN controller_outbox o ON o.id=v.id WHERE v.parent_id=$1", [report.id])).rows;
    expect(jobs).toHaveLength(2);
    expect(jobs.flatMap(j => j.tests)).toHaveLength(4);
    const transform = jobs.find(j => j.tests[0].expected_decision === "transform");
    expect(transform.tests[0]).toMatchObject({ content: "beta", expected_text: "[hidden]", covered_rule_ids: ["configured/phrases/b"] });
    expect(transform.payload.plan.policy_bindings[0].enabled_rule_ids).toEqual(["configured/phrases/b"]);
  });
  it("uses model test values only in validation jobs and publishes reusable references", async () => {
    const definition = service.compiler.shipped("builtin-topic-safety")!;
    definition.metadata.id = "parameterized-topic";
    definition.testing = { parameters: { denied_topics: "Synthetic test topic", allowed_topics: "Synthetic support", topic_mode: "strict" } };
    await service.save({ definition, maintainer: "Test", expectedRevision: 0, actorId: "test", create: true });
    const report = await service.validate(definition.metadata.id, "test", true);
    const jobs = (await pool.query("SELECT v.id, v.tests, o.payload FROM policy_resource_validation v JOIN controller_outbox o ON o.id=v.id WHERE v.parent_id=$1", [report.id])).rows;
    expect(jobs).toHaveLength(2);
    expect(jobs.flatMap(j => j.payload.plan.steps).some(step => Object.fromEntries(step.parameters).restricted_topics === "Synthetic test topic")).toBe(true);
    for (const job of jobs) {
      await complete({ runId: job.id, status: "passed", results: job.tests.map((test: { id: string; expected_decision: string; covered_rule_ids: string[] }) => ({
        caseId: test.id, actualDecision: test.expected_decision, passed: true, sourcePolicyId: definition.metadata.id, modelInvocations: 1,
        findings: test.covered_rule_ids.map(rule_id => ({ rule_id, policy_id: definition.metadata.id, verdict: "matched" })),
      } as ValidationCaseResult)) });
    }
    const published = await service.publish(definition.metadata.id, 1, "test");
    expect(published.definition?.rules[0]!.detector.parameters.restricted_topics).toBe("{{denied_topics}}");
    const plan = buildGuardrailPlan({ guardrailId: "live-binding", guardrailVersion: "1", policies: [published], draft: normalizeGuardrailDraft({ policyBindings: [{ policyId: published.id, policyVersion: published.version, enabledRuleIds: published.rules.map(r => r.id), parameterValues: { denied_topics: "Business restriction", allowed_topics: "Business support" } }] }) });
    const parameters = (plan.steps as Array<{ parameters: Array<[string, string]> }>).map(s => Object.fromEntries(s.parameters));
    expect(parameters.some(p => p.restricted_topics === "Business restriction")).toBe(true);
    expect(JSON.stringify(parameters)).not.toContain("Synthetic");
    definition.testing.parameters.denied_topics = "Changed example";
    await service.save({ definition, maintainer: "Test", expectedRevision: 1, actorId: "test" });
    expect((await service.publish(definition.metadata.id, 1, "test")).definition?.testing?.parameters.denied_topics).toBe("Synthetic test topic");
  });
});
