import { stageCases } from "../db/report-test-utils.js";
// @vitest-environment node
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "../db/postgres-test-database.js";
import type { ValidationCaseResult } from "../domain/models.js";
import { ReportResults, type ReportChunk } from "./report-results.js";
import { validationRuns } from "../db/schema.js";
import { validationSnapshotColumns, storeValidationSnapshot } from "./testing-reports.js";
import { eq } from "drizzle-orm";

const url = process.env.GUARD_TEST_POSTGRES_URL;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function result(index: number): ValidationCaseResult {
  return { caseId: `case-${index}`, name: `Case ${index}`, policyId: "test", passed: index % 3 !== 0, skipped: false,
    actualDecision: "allow", expectedDecision: "allow", actualFailure: null, expectedFailure: null, phase: "input", caseType: "scenario", required: true,
    reason: "PRIVATE_REPORT_SENTINEL", latencyMs: 1, modelInvocations: 0, trace: [{ name: "test", detail: "x".repeat(40000) }],
    inputContent: "private input", outputContent: "private output", ruleContractSatisfied: true,
  } as ValidationCaseResult;
}
describe.skipIf(!url)("Bounded report storage and replay", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>, reports: ReportResults;
  beforeAll(async () => {
    database = await createTestDatabase(url!, "bounded_reports");
    reports = new ReportResults(database.db);
    await database.pool.query("INSERT INTO guardrail(id,name,draft_config) VALUES('guard','Fixture','{}')");
  });
  beforeEach(async () => {
    await database.pool.query("DELETE FROM guardrail_validation_run");
    await database.pool.query("INSERT INTO guardrail_validation_run(id,guardrail_id,guardrail_version,source_draft_revision,status) VALUES('run','guard','1',1,'running')");
  });
  afterAll(async () => database?.drop());

  it("stores 800 cases in bounded transactions, filters before paging, and lazily reads one trace", async () => {
    await stageCases(reports, "run", Array.from({ length: 800 }, (_, i) => result(i)));
    expect((await reports.page("run", {})).items).toHaveLength(0); // Partial uploads stay hidden.
    await database.pool.query("UPDATE guardrail_validation_run SET status='passed' WHERE id='run'");
    const first = await reports.page("run", {});
    expect(first.items).toHaveLength(50);
    expect(first.counts).toMatchObject({ all: 800, failed: 267, passed: 533 });
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(512 * 1024);
    expect(JSON.stringify(first)).not.toContain("private input");
    expect(first.items.every(item => !("trace" in item) && !("inputContent" in item))).toBe(true);
    const second = await reports.page("run", { cursor: first.nextCursor! });
    expect(new Set([...first.items, ...second.items].map(item => item.caseId)).size).toBe(100);
    await expect(reports.page("run", { filter: "passed", cursor: first.nextCursor! })).rejects.toThrow("cursor");
    const detail = await reports.detail("run", 7);
    expect(detail.trace).toEqual(result(7).trace);
    expect((await database.pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='guardrail_validation_run' AND column_name='results'")).rows).toEqual([]);
    expect(database.pool.waitingCount).toBe(0);
  });

  it("releases all database connections after parallel bounded reads", async () => {
    await stageCases(reports,"run",[result(0),result(1)]);
    await database.pool.query("UPDATE guardrail_validation_run SET status='passed' WHERE id='run'");
    let active=0,peak=0;
    const acquired=()=>{active++;peak=Math.max(peak,active);},released=()=>{active--;};
    database.pool.on("acquire",acquired);database.pool.on("release",released);
    try {await Promise.all(Array.from({length:20},(_,n)=>n%2?reports.detail("run",0):reports.page("run",{})));}
    finally {database.pool.off("acquire",acquired);database.pool.off("release",released);}
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(4); // Includes readiness SQL, not just body reads.
    expect(active).toBe(0);
    expect(database.pool.totalCount).toBe(database.pool.idleCount);
    expect(reports.state().read).toEqual({active:0,queued:0,in_flight_bytes:0});
  });

  it("deduplicates frozen snapshots while preserving publication reads and referenced evidence", async () => {
    const snapshot = { candidate_artifact: { guardrailId: "guard", plan: { immutable: true } }, test_suite: [{ id: "case", required: true }] };
    await database.db.transaction(async tx => {
      const payload = { candidateArtifact: snapshot.candidate_artifact, testSuite: snapshot.test_suite, candidatePolicies: null, candidateInspection: null } as never;
      const digest = await storeValidationSnapshot(tx,payload);
      expect(await storeValidationSnapshot(tx,payload)).toBe(digest);
      await tx.update(validationRuns).set({status:"passed",snapshotDigest:digest}).where(eq(validationRuns.id,"run"));
      await tx.insert(validationRuns).values({id:"same",guardrailId:"guard",guardrailVersion:"1",sourceDraftRevision:1,status:"passed",snapshotDigest:digest});
    });
    expect((await database.pool.query("SELECT count(*)::int n FROM guardrail_validation_snapshot")).rows[0].n).toBe(1);
    const [restored] = await database.db.select(validationSnapshotColumns).from(validationRuns).where(eq(validationRuns.id, "run"));
    expect(restored).toMatchObject({ candidateArtifact: snapshot.candidate_artifact, testSuite: snapshot.test_suite });
    await database.pool.query("DELETE FROM guardrail_validation_run WHERE id='run'");
    expect((await database.pool.query("SELECT count(*)::int n FROM guardrail_validation_snapshot")).rows[0].n).toBe(1);
    const [other] = await database.db.select(validationSnapshotColumns).from(validationRuns).where(eq(validationRuns.id, "same"));
    expect(other).toEqual(restored);
  });

  it("commits chunk retries once, rejects gaps and changed evidence, and verifies the final manifest", async () => {
    const digests = [digest("one"), digest("two"), digest("final")];
    const part = (sequence: number): ReportChunk => ({ runId: "run", runnerBootId: "fixture", uploadId: "upload-1", manifestDigest: digest(digests.join("\n")), chunks: 3, cases: 2,
      sequence, caseOffset: sequence, rawBytes: 100, digest: digests[sequence]!, final: sequence === 2, results: sequence === 2 ? [] : [result(sequence)] });
    await expect(reports.stage(part(1))).rejects.toThrow("order");
    expect(await reports.stage(part(0))).toBe(false);
    expect(await reports.stage(part(0))).toBe(false);
    await expect(reports.stage({ ...part(0), digest: digest("changed") })).rejects.toThrow("changed");
    expect(await reports.stage(part(1))).toBe(false);
    expect(await reports.stage(part(2))).toBe(true);
    expect(await reports.stage(part(2))).toBe(true);
    expect((await database.pool.query("SELECT count(*)::int n FROM validation_report_case")).rows[0].n).toBe(2);
    expect((await reports.page("run", {})).items).toHaveLength(0);
  });

  it("never recreates deleted or cancelled runs when a delayed chunk arrives", async () => {
    const chunk: ReportChunk = { runId: "run", runnerBootId: "fixture", uploadId: "late", manifestDigest: digest(digest("final")), chunks: 1, cases: 0, sequence: 0,
      caseOffset: 0, rawBytes: 100, digest: digest("final"), final: true, results: [] };
    await database.pool.query("UPDATE guardrail_validation_run SET status='cancelled' WHERE id='run'");
    expect(await reports.stage(chunk)).toBe(false);
    await database.pool.query("DELETE FROM guardrail_validation_run WHERE id='run'");
    expect(await reports.stage(chunk)).toBe(false);
    expect((await database.pool.query("SELECT count(*)::int n FROM validation_report_upload")).rows[0].n).toBe(0);
  });

  it("enforces database-wide read slots across service instances and releases connections after rejection", async () => {
    await stageCases(reports, "run", [result(0)]);
    await database.pool.query("UPDATE guardrail_validation_run SET status='passed' WHERE id='run'");
    const blockers = await Promise.all(Array.from({ length: 4 }, () => database.pool.connect()));
    try {
      for (const [slot, client] of blockers.entries()) await client.query("SELECT pg_advisory_lock(hashtext(current_schema()),$1)", [1735101 * 16 + slot]);
      await expect(new ReportResults(database.db).detail("run", 0)).rejects.toMatchObject({ status: 429, code: "report_busy" });
    } finally {
      for (const client of blockers) { await client.query("SELECT pg_advisory_unlock_all()"); client.release(); }
    }
    expect((await reports.detail("run", 0)).caseId).toBe("case-0");
    expect(database.pool.waitingCount).toBe(0);
  });

  it("pages a large per-case trace and rejects oversized new evidence without acknowledging it", async () => {
    await stageCases(reports, "run", [{ ...result(0), trace: Array.from({ length: 210 }, (_, n) => ({ name: `step-${n}` })) }]);
    await database.pool.query("UPDATE guardrail_validation_run SET status='passed' WHERE id='run'");
    expect(await reports.detail("run", 0)).toMatchObject({ traceCount: 210, nextTraceOffset: 100 });
    expect((await reports.detail("run", 0, 200)).trace).toHaveLength(10);
    await database.pool.query("UPDATE guardrail_validation_run SET status='running' WHERE id='run'");
    await database.pool.query("DELETE FROM validation_report_upload WHERE run_id='run'");
    await expect(stageCases(reports, "run", [{ ...result(1), outputContent: "x".repeat(4 * 1024 * 1024) }])).rejects.toMatchObject({ status: 413 });
  });
  it("restarts unfinished uploads, fences stale finalization, and protects terminal evidence",async()=>{
    const first=digest("old-data"), oldFinal=digest("old-final");
    const old:ReportChunk={runId:"run",runnerBootId:"old-boot",uploadId:"old",manifestDigest:digest([first,oldFinal].join("\n")),sequence:0,chunks:2,cases:1,caseOffset:0,rawBytes:100,digest:first,final:false,results:[result(0)]};
    await reports.stage(old);
    // Final data can be durable while its old Controller is still assessing it.
    await reports.stage({...old,sequence:1,caseOffset:1,final:true,digest:oldFinal,results:[]});
    const nextDigest=digest("new-data"),finalDigest=digest("new-final"),replacement={...old,runnerBootId:"new-boot",uploadId:"new",manifestDigest:digest([nextDigest,finalDigest].join("\n")),digest:nextDigest,results:[result(1)]};
    await expect(reports.stage({...replacement,sequence:1,final:true,caseOffset:1,digest:finalDigest,results:[]})).rejects.toThrow("identity changed");
    await reports.stage(replacement);
    const stale={runnerBootId:old.runnerBootId,uploadId:old.uploadId};
    await expect(reports.assess("run",[{id:"case-1"}],()=>({passed:false}),stale)).rejects.toThrow("upload changed before finalization");
    await expect(database.db.transaction(tx=>reports.assertUpload(tx,"run",stale))).rejects.toThrow("upload changed before finalization");
    expect((await database.pool.query("SELECT assessment FROM validation_report_case WHERE run_id='run'")).rows[0].assessment).toEqual({});
    await expect(reports.stage(old)).rejects.toThrow("identity changed");
    expect(await reports.stage({...replacement,sequence:1,final:true,caseOffset:1,digest:finalDigest,results:[]})).toBe(true);
    await database.pool.query("UPDATE guardrail_validation_run SET status='passed' WHERE id='run'");
    expect(await reports.stage(old)).toBe(false);
    expect((await reports.page("run",{})).count).toBe(1);
    expect((await reports.detail("run",0)).caseId).toBe("case-1");
  });

  it("keeps raw Policy evidence immutable across assertion retries and shares the parent detail",async()=>{
    const {assertPolicyTest}=await import("./policy-resources.js");
    const test={id:"case-0",name:"Policy case",phase:"input",kind:"scenario",required:true,expected_decision:"block",covered_rule_ids:[]} as never;
    await database.pool.query("INSERT INTO policy_resource(id,definition,maintainer) VALUES('policy','{}','fixture')");
    await database.pool.query("INSERT INTO policy_resource_validation(id,policy_id,revision,status,tests) VALUES('parent','policy',1,'running',$1)",[JSON.stringify([test])]);
    await database.pool.query("INSERT INTO policy_resource_validation(id,parent_id,policy_id,revision,status,tests) VALUES('child','parent','policy',1,'running',$1)",[JSON.stringify([test])]);
    const raw={...result(0),passed:true};
    await stageCases(reports,"child",[raw]);
    await reports.assess("child",[test],assertPolicyTest);
    const first=(await database.pool.query("SELECT assessment FROM validation_report_case WHERE run_id='child'")).rows[0].assessment;
    await reports.assess("child",[test],assertPolicyTest);
    expect((await database.pool.query("SELECT assessment FROM validation_report_case WHERE run_id='child'")).rows[0].assessment).toEqual(first);
    expect((await database.pool.query("SELECT body FROM validation_report_detail WHERE owner_id='child'")).rows[0].body).toEqual(raw);
    await database.db.transaction(tx=>reports.linkPolicyParent(tx,"parent"));
    await database.pool.query("UPDATE policy_resource_validation SET status='failed'");
    expect((await reports.page("parent",{})).counts.failed).toBe(1);
    expect((await reports.detail("parent",0)).reason).toContain("Expected block");
    expect((await database.pool.query("SELECT count(*)::int n FROM validation_report_detail WHERE owner_id IN ('child','parent')")).rows[0].n).toBe(1);
  });

});
