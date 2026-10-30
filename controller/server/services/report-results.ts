import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { ControllerDatabase } from "../db/client.js";
import type { ValidationCaseResult } from "../domain/models.js";
import { ConflictError, ControllerError, NotFoundError, ValidationError } from "../domain/errors.js";
import { REPORT_BATCH_CASES, REPORT_CASE_BYTES, REPORT_TOTAL_BYTES, REPORT_PAGE_BYTES, ReportBudget, reportDatabaseWork, type ReportTransaction } from "./report-budget.js";

const strings = ["caseId", "name", "policyId", "expectedDecision", "actualDecision", "phase", "caseType", "actualFailure", "expectedFailure", "sourcePolicyId", "sourcePolicyVersion", "sourceCaseId", "reason", "skipReason"] as const;
const scalars = ["passed", "skipped", "required", "latencyMs", "modelInvocations", "ruleContractSatisfied"] as const;
export type CaseSummary = Pick<ValidationCaseResult, "caseId" | "passed" | "skipped" | "skipReason" | "modelInvocations"> & Record<string, unknown> & { traceCount: number };
export function caseSummary(value: ValidationCaseResult): CaseSummary {
  const summary: Record<string, unknown> = {};
  for (const key of strings) { const field = value[key]; summary[key] = typeof field === "string" ? field.slice(0, 512) : field ?? null; }
  for (const key of scalars) summary[key] = value[key] ?? (key === "modelInvocations" || key === "latencyMs" ? 0 : false);
  summary.traceCount = value.trace?.length ?? 0;
  // A character cap alone does not bound UTF-8 responses. Only previews are
  // shortened; identities and the complete immutable detail are preserved.
  for (const cap of [256, 128, 64]) {
    if (Buffer.byteLength(JSON.stringify(summary)) <= 8192) break;
    for (const key of strings) if (key !== "caseId" && typeof summary[key] === "string") summary[key] = (summary[key] as string).slice(0, cap);
  }
  return summary as CaseSummary;
}
export function casePriority(value: Pick<ValidationCaseResult, "skipped" | "actualFailure" | "actualDecision" | "passed">) {
  return value.skipped ? 3 : value.actualFailure || value.actualDecision?.toLowerCase() === "error" ? 0 : value.passed ? 2 : 1;
}
const caseStatus = (value: ValidationCaseResult) => value.skipped ? "skipped" : value.passed ? "passed" : "failed";

export const casePageQuery = z.object({
  filter: z.enum(["all", "failed", "passed", "skipped"]).default("all"),
  limit: z.coerce.number().int().min(1).max(50).default(50),
  cursor: z.string().max(2000).optional(),
});
export type ReportChunk = {
  runId: string; runnerBootId: string; uploadId: string; manifestDigest: string; sequence: number; chunks: number;
  cases: number; caseOffset: number; rawBytes: number; digest: string; final: boolean;
  results: ValidationCaseResult[];
};

async function insertCases(tx: ReportTransaction, runId: string, offset: number, results: ValidationCaseResult[]) {
  if (!results.length) return;
  const values = results.map((result, index) => {
    if (!result.caseId || result.caseId.length > 512) throw new ValidationError("Invalid report case identity.");
    const detail = JSON.stringify(result);
    const size = Buffer.byteLength(detail);
    if (size > REPORT_CASE_BYTES) throw new ControllerError("A test case exceeds the 4 MiB detail budget.", 413, "report_case_too_large");
    return sql`(${runId}, ${offset + index}, ${result.caseId}, ${caseStatus(result)}, ${casePriority(result)}, ${JSON.stringify(caseSummary(result))}::jsonb, ${detail}::jsonb, ${size})`;
  });
  await tx.execute(sql`WITH incoming(run_id,ordinal,case_id,status,priority,summary,detail,detail_bytes) AS (VALUES ${sql.join(values, sql`, `)}),
    bodies AS (INSERT INTO validation_report_detail(id,owner_id,body,bytes)
      SELECT run_id||'/'||ordinal,run_id,detail,detail_bytes::int FROM incoming
      ON CONFLICT(id) DO NOTHING RETURNING id)
    INSERT INTO validation_report_case(run_id,ordinal,case_id,status,priority,summary,detail_id,detail_bytes)
      SELECT run_id,ordinal::int,case_id,status,priority::int,summary,run_id||'/'||ordinal,detail_bytes::int FROM incoming
      ON CONFLICT(run_id,ordinal) DO UPDATE SET status=excluded.status,priority=excluded.priority,summary=excluded.summary,detail_id=excluded.detail_id,detail_bytes=excluded.detail_bytes`);
}

export type ReportUploadIdentity = { runnerBootId: string; uploadId: string };

export class ReportResults {
  private readonly reads = new ReportBudget(4, REPORT_TOTAL_BYTES, 16);
  private readonly writes = new ReportBudget(2, REPORT_TOTAL_BYTES, 8);
  constructor(private readonly db: ControllerDatabase) {}
  state() { return { read: this.reads.state(), write: this.writes.state() }; }

  private async ready(tx: ReportTransaction, runId: string) {
    const { rows: [run] } = await tx.execute<{ status: string }>(sql`SELECT status FROM validation_report_state WHERE id=${runId}`);
    if (!run) throw new NotFoundError("Testing Report", runId);
    return run.status !== "queued" && run.status !== "running";
  }
  async page(runId: string, input: z.input<typeof casePageQuery>) {
    const query = casePageQuery.parse(input);
    const empty = { items: [] as Array<CaseSummary & { ordinal: number }>, count: 0, counts: { all: 0, passed: 0, failed: 0, skipped: 0, warnings: 0 }, nextCursor: null as string | null };
    let before = sql`true`;
    if (query.cursor) {
      try {
        const cursor = z.object({ runId: z.literal(runId), filter: z.literal(query.filter), priority: z.number().int().min(0).max(3), ordinal: z.number().int().min(0) }).parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString()));
        before = sql`(priority,ordinal) > (${cursor.priority},${cursor.ordinal})`;
      } catch { throw new ValidationError("Invalid test case cursor."); }
    }
    return this.reads.run(0, () => reportDatabaseWork(this.db, "read", async tx => {
      if (!await this.ready(tx, runId)) return empty;
      const { rows } = await tx.execute<{ ordinal: number; priority: number; summary: CaseSummary }>(sql`SELECT ordinal,priority,summary FROM validation_report_case WHERE run_id=${runId} AND ${query.filter === "all" ? sql`true` : sql`status=${query.filter}`} AND ${before} ORDER BY priority,ordinal LIMIT ${query.limit + 1}`);
      const { rows: [counts] } = await tx.execute<typeof empty.counts>(sql`SELECT count(*)::integer AS "all", count(*) FILTER (WHERE status='passed')::integer AS passed, count(*) FILTER (WHERE status='failed')::integer AS failed, count(*) FILTER (WHERE status='skipped')::integer AS skipped, count(*) FILTER (WHERE status='passed' AND coalesce(summary->>'actualFailure','')<>'' AND coalesce(summary->>'expectedFailure','')='')::integer AS warnings FROM validation_report_case WHERE run_id=${runId}`);
      const page = rows.slice(0, query.limit);
      while (page.length > 1 && Buffer.byteLength(JSON.stringify(page)) > REPORT_PAGE_BYTES - 8192) page.pop();
      const last = page.at(-1);
      return { items: page.map(row => ({ ...row.summary, ordinal: row.ordinal })), count: counts?.[query.filter] ?? 0, counts: counts ?? empty.counts,
        nextCursor: rows.length > page.length && last ? Buffer.from(JSON.stringify({ runId, filter: query.filter, priority: last.priority, ordinal: last.ordinal })).toString("base64url") : null };
    }));
  }
  async detail(runId: string, ordinal: number, traceOffset = 0) {
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || !Number.isSafeInteger(traceOffset) || traceOffset < 0) throw new ValidationError("Invalid test case position.");
    return this.reads.run(REPORT_CASE_BYTES, () => reportDatabaseWork(this.db, "read", async tx => {
      if (!await this.ready(tx, runId)) throw new ConflictError("Report is still being saved.", "report_pending");
      const { rows: [row] } = await tx.execute<{ detail: ValidationCaseResult }>(sql`SELECT CASE WHEN c.detail_bytes <= ${REPORT_CASE_BYTES} THEN d.body || c.assessment ELSE NULL END AS detail FROM validation_report_case c JOIN validation_report_detail d ON d.id=c.detail_id WHERE run_id=${runId} AND ordinal=${ordinal}`);
      if (!row) throw new NotFoundError("Test Case Result", String(ordinal));
      if (!row.detail) throw new ControllerError("Test case exceeds the detail budget.", 413, "report_case_too_large");
      const trace = row.detail.trace ?? [], end = Math.min(trace.length, traceOffset + 100);
      return { ...row.detail, trace: trace.slice(traceOffset, end), traceCount: trace.length, nextTraceOffset: end < trace.length ? end : null };
    }));
  }
  /** Fence finalization against a replacement upload. The bridge lock is also
   * taken by stage(), so the identity cannot change before this commit. */
  async assertUpload(tx: ReportTransaction, runId: string, expected?: ReportUploadIdentity) {
    if (!expected) return; // Execution failures have no report upload.
    const {rows:[upload]} = await tx.execute<{runner_boot_id:string;upload_id:string}>(sql`
      SELECT u.runner_boot_id,u.upload_id FROM validation_report r
      LEFT JOIN validation_report_upload u ON u.run_id=r.id WHERE r.id=${runId} FOR UPDATE OF r`);
    if (upload?.runner_boot_id !== expected.runnerBootId || upload?.upload_id !== expected.uploadId)
      throw new ConflictError("Report upload changed before finalization.", "report_upload_conflict");
  }
  async evidence(tx: ReportTransaction, runId: string) {
    return (await tx.execute<{ summary: CaseSummary }>(sql`SELECT summary FROM validation_report_case WHERE run_id=${runId} ORDER BY ordinal`)).rows.map(row => row.summary);
  }
  /** Apply Policy assertions one bounded case at a time, outside the final
   * parent transaction. Parent reports reference these same immutable bodies. */
  async assess<T extends { id: string }>(runId: string, tests: T[], assertion: (test: T, actual?: ValidationCaseResult) => Partial<ValidationCaseResult>, upload?: ReportUploadIdentity) {
    let passed = 0;
    for (const test of tests) {
      const row = await this.writes.run(REPORT_CASE_BYTES, () => reportDatabaseWork(this.db, "write", async tx => {
        const { rows: [value] } = await tx.execute<{ ordinal: number; detail: ValidationCaseResult | null }>(sql`
          SELECT ordinal,CASE WHEN d.bytes <= ${REPORT_CASE_BYTES} THEN d.body ELSE NULL END AS detail
          FROM validation_report_case c JOIN validation_report_detail d ON d.id=c.detail_id WHERE run_id=${runId} AND case_id=${test.id}`);
        return value;
      }));
      if (row && !row.detail) throw new ControllerError("Test case exceeds the detail budget.", 413, "report_case_too_large");
      const result = { ...row?.detail, ...assertion(test, row?.detail?.caseId ? row.detail : undefined), caseId: test.id } as ValidationCaseResult;
      const bytes = Buffer.byteLength(JSON.stringify(result));
      if (bytes > REPORT_CASE_BYTES) throw new ControllerError("Assessed test case exceeds the detail budget.",413,"report_case_too_large");
      const assessment = Object.fromEntries(Object.entries(result).filter(([key,value]) => JSON.stringify(value) !== JSON.stringify(row?.detail?.[key as keyof ValidationCaseResult])));
      if (result.passed) passed++;
      await this.writes.run(REPORT_CASE_BYTES, () => reportDatabaseWork(this.db, "write", async tx => {
        if (upload) await this.assertUpload(tx, runId, upload);
        else await tx.execute(sql`SELECT id FROM validation_report WHERE id=${runId} FOR UPDATE`);
        const { rows: [owner] } = await tx.execute<{ status: string }>(sql`SELECT status FROM validation_report_state WHERE id=${runId}`);
        if (!owner || !["queued","running"].includes(owner.status)) return;
        const { rows: [position] } = row ? { rows: [row] } : await tx.execute<{ ordinal: number }>(sql`SELECT coalesce(max(ordinal)+1,0)::int ordinal FROM validation_report_case WHERE run_id=${runId}`);
        const ordinal=position!.ordinal;
        if (!row) {
          await tx.execute(sql`INSERT INTO validation_report_detail(id,owner_id,body,bytes) VALUES(${runId+"/"+ordinal},${runId},'{}',2)`);
          await tx.execute(sql`INSERT INTO validation_report_case(run_id,ordinal,case_id,status,priority,summary,detail_id,detail_bytes)
            VALUES(${runId},${ordinal},${test.id},'failed',1,'{}',${runId+"/"+ordinal},${bytes})`);
        }
        await tx.execute(sql`UPDATE validation_report_case SET assessment=${JSON.stringify(assessment)}::jsonb,
          summary=${JSON.stringify(caseSummary(result))}::jsonb,status=${caseStatus(result)},priority=${casePriority(result)},detail_bytes=${bytes}
          WHERE run_id=${runId} AND ordinal=${ordinal}`);
      }));
    }
    return passed;
  }
  async linkPolicyParent(tx: ReportTransaction, parentId: string) {
    await tx.execute(sql`INSERT INTO validation_report_case(run_id,ordinal,case_id,status,priority,summary,detail_id,detail_bytes,assessment)
      SELECT p.id,(test.n-1)::int,c.case_id,c.status,c.priority,c.summary,c.detail_id,c.detail_bytes,c.assessment
      FROM policy_resource_validation p CROSS JOIN LATERAL jsonb_array_elements(p.tests) WITH ORDINALITY test(item,n)
      JOIN policy_resource_validation child ON child.parent_id=p.id
      JOIN validation_report_case c ON c.run_id=child.id AND c.case_id=test.item->>'id' WHERE p.id=${parentId}
      ON CONFLICT(run_id,ordinal) DO UPDATE SET status=excluded.status,priority=excluded.priority,summary=excluded.summary,detail_id=excluded.detail_id,detail_bytes=excluded.detail_bytes,assessment=excluded.assessment`);
  }
  async stage(chunk: ReportChunk): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(chunk.manifestDigest) || !/^[a-f0-9]{64}$/.test(chunk.digest) || !/^[a-zA-Z0-9-]{1,80}$/.test(chunk.uploadId)
      || !Number.isSafeInteger(chunk.sequence) || chunk.sequence < 0 || chunk.sequence >= chunk.chunks || chunk.chunks > 10000
      || !Number.isSafeInteger(chunk.cases) || chunk.cases < 0 || chunk.cases > 10000 || chunk.caseOffset < 0
      || chunk.results.length > REPORT_BATCH_CASES || (chunk.final !== (chunk.sequence === chunk.chunks - 1)) || (chunk.final && chunk.results.length)) throw new ValidationError("Invalid report chunk manifest.");
    return this.writes.run(chunk.rawBytes, () => reportDatabaseWork(this.db, "write", async tx => {
      await tx.execute(sql`SELECT id FROM validation_report WHERE id=${chunk.runId} FOR UPDATE`);
      const { rows: [run] } = await tx.execute<{ status: string }>(sql`SELECT status FROM validation_report_state WHERE id=${chunk.runId}`);
      if (!run || !["queued", "running"].includes(run.status)) return false;
      const { rows: [previousUpload] } = await tx.execute<{ runner_boot_id: string; retired_boot_ids: string[] }>(sql`SELECT runner_boot_id,retired_boot_ids FROM validation_report_upload WHERE run_id=${chunk.runId}`);
      if (previousUpload && previousUpload.runner_boot_id !== chunk.runnerBootId && chunk.sequence === 0) {
        // A new Runner process cannot replay an anonymous spool from its prior
        // boot. The registered stream owns the retry; discard only partial data.
        if (previousUpload.retired_boot_ids.includes(chunk.runnerBootId)) throw new ConflictError("Report upload identity changed: retired Runner boot.","report_upload_conflict");
        if (previousUpload.retired_boot_ids.length >= 64) throw new ControllerError("Report exceeded its restart budget.",422,"report_restart_limit");
        await tx.execute(sql`DELETE FROM validation_report_chunk WHERE run_id=${chunk.runId}`);
        await tx.execute(sql`DELETE FROM validation_report_detail WHERE owner_id=${chunk.runId}`);
        await tx.execute(sql`UPDATE validation_report_upload SET runner_boot_id=${chunk.runnerBootId},
          retired_boot_ids=array_append(retired_boot_ids,runner_boot_id),upload_id=${chunk.uploadId},manifest_digest=${chunk.manifestDigest},chunks=${chunk.chunks},cases=${chunk.cases}
          WHERE run_id=${chunk.runId}`);
      }
      if (!previousUpload) await tx.execute(sql`DELETE FROM validation_report_detail WHERE owner_id=${chunk.runId}`);
      await tx.execute(sql`INSERT INTO validation_report_upload(run_id,runner_boot_id,upload_id,manifest_digest,chunks,cases) VALUES(${chunk.runId},${chunk.runnerBootId},${chunk.uploadId},${chunk.manifestDigest},${chunk.chunks},${chunk.cases}) ON CONFLICT DO NOTHING`);
      const { rows: [upload] } = await tx.execute<{ runner_boot_id: string; upload_id: string; manifest_digest: string; chunks: number; cases: number }>(sql`SELECT runner_boot_id,upload_id,manifest_digest,chunks,cases FROM validation_report_upload WHERE run_id=${chunk.runId}`);
      if (upload?.runner_boot_id !== chunk.runnerBootId || upload?.upload_id !== chunk.uploadId || upload.manifest_digest !== chunk.manifestDigest || upload.chunks !== chunk.chunks || upload.cases !== chunk.cases) throw new ConflictError("Report upload identity changed.", "report_upload_conflict");
      const { rows } = await tx.execute<{ sequence: number; digest: string; raw_bytes: number; case_count: number; case_offset: number }>(sql`SELECT sequence,digest,raw_bytes,case_count,case_offset FROM validation_report_chunk WHERE run_id=${chunk.runId} ORDER BY sequence`);
      const previous = rows.find(row => row.sequence === chunk.sequence);
      if (previous) {
        if (previous.digest !== chunk.digest || previous.raw_bytes !== chunk.rawBytes || previous.case_offset !== chunk.caseOffset || previous.case_count !== chunk.results.length) throw new ConflictError("Report chunk changed during retry.", "report_chunk_conflict");
        return chunk.final;
      }
      if (rows.length !== chunk.sequence || rows.reduce((sum, row) => sum + row.case_count, 0) !== chunk.caseOffset) throw new ConflictError("Report chunks must be acknowledged in order.", "report_chunk_gap");
      if (rows.reduce((sum, row) => sum + row.raw_bytes, chunk.rawBytes) > REPORT_TOTAL_BYTES) throw new ControllerError("Report exceeds the 128 MiB decoded budget.", 413, "report_too_large");
      if (chunk.caseOffset + chunk.results.length > chunk.cases) throw new ValidationError("Report contains too many cases.");
      if (chunk.final && (chunk.caseOffset !== chunk.cases || createHash("sha256").update([...rows.map(row => row.digest), chunk.digest].join("\n")).digest("hex") !== chunk.manifestDigest)) throw new ValidationError("Report manifest is incomplete or inconsistent.");
      await insertCases(tx, chunk.runId, chunk.caseOffset, chunk.results);
      await tx.execute(sql`INSERT INTO validation_report_chunk(run_id,sequence,digest,raw_bytes,case_offset,case_count) VALUES(${chunk.runId},${chunk.sequence},${chunk.digest},${chunk.rawBytes},${chunk.caseOffset},${chunk.results.length})`);
      console.info(JSON.stringify({ event: "validation.report_chunk_saved", run_id: chunk.runId, sequence: chunk.sequence, cases: chunk.results.length, raw_bytes: chunk.rawBytes }));
      return chunk.final;
    }));
  }
}
