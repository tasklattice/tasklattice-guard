import { reportCompletionTime } from "./testing-report-retention.js";
import { and, count, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { ControllerDatabase } from "../db/client.js";
import { guardrails, guardrailVersions, validationRuns } from "../db/schema.js";
import { ValidationError } from "../domain/errors.js";

// Keep large JSON columns out of PostgreSQL's result, not just out of the HTTP response.
const { results: _results, candidateArtifact: _artifact, candidatePolicies: _policies,
  candidateInspection: _inspection, testSuite: _suite, ...summary } = getTableColumns(validationRuns);
export const validationSummaryColumns = summary;
export const validationDetailColumns = { ...summary, results: validationRuns.results };

export const testingReportsQuery = z.object({
  guardrailId: z.string().max(200).optional(),
  q: z.string().trim().max(300).default(""),
  status: z.enum(["all", "passed", "failed", "cancelled", "incomplete"]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(1000).optional(),
});

export async function queryTestingReports(db: ControllerDatabase, input: z.input<typeof testingReportsQuery>) {
  const query = testingReportsQuery.parse(input);
  const filters = and(
    query.guardrailId ? eq(validationRuns.guardrailId, query.guardrailId) : undefined,
    query.status === "all" ? undefined : query.status === "incomplete"
      ? inArray(validationRuns.status, ["queued", "running"]) : eq(validationRuns.status, query.status),
    query.q ? sql`strpos(lower(${validationRuns.id} || ' ' || ${guardrails.name}), ${query.q.toLowerCase()}) > 0` : undefined,
  );
  let before;
  if (query.cursor) {
    try {
      const cursor = z.object({ at: z.iso.datetime(), id: z.string().min(1) })
        .parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString()));
      before = sql`(${validationRuns.createdAt}, ${validationRuns.id}) < (${cursor.at}::timestamptz, ${cursor.id})`;
    } catch { throw new ValidationError("Invalid testing report cursor."); }
  }
  const rows = await db.select({ ...summary,
    cursorTime: sql<string>`to_char(${validationRuns.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  }).from(validationRuns).innerJoin(guardrails, eq(guardrails.id, validationRuns.guardrailId))
    .where(and(filters, before)).orderBy(desc(validationRuns.createdAt), desc(validationRuns.id)).limit(query.limit + 1);
  const [total] = await db.select({ value: count() }).from(validationRuns).innerJoin(guardrails, eq(guardrails.id, validationRuns.guardrailId)).where(filters);
  const page = rows.slice(0, query.limit);
  const items = page.map(({ cursorTime: _cursorTime, ...item }) => item);
  const last = page.at(-1);
  // Release controls need evidence for retained versions even while viewing an older history page.
  // At most three small summaries per retained version, independent of history size.
  const versionReports = query.guardrailId ? await versionEvidence(db, query.guardrailId) : [];
  return { items, count: total?.value ?? 0, versionReports,
    nextCursor: rows.length > query.limit && last ? Buffer.from(JSON.stringify({ at: last.cursorTime, id: last.id })).toString("base64url") : null };
}

async function versionEvidence(db: ControllerDatabase, guardrailId: string) {
  const versions = await db.select({ version: guardrailVersions.version, runId: guardrailVersions.validationRunId })
    .from(guardrailVersions).where(eq(guardrailVersions.guardrailId, guardrailId));
  if (!versions.length) return [];
  const scope = and(eq(validationRuns.guardrailId, guardrailId), eq(validationRuns.subject, "version"),
    inArray(validationRuns.guardrailVersion, versions.map(item => item.version)));
  const latest = await db.selectDistinctOn([validationRuns.guardrailVersion], summary).from(validationRuns).where(scope)
    .orderBy(validationRuns.guardrailVersion, desc(validationRuns.createdAt), desc(validationRuns.id));
  const completed = await db.selectDistinctOn([validationRuns.guardrailVersion], summary).from(validationRuns)
    .where(and(scope, inArray(validationRuns.status, ["passed", "failed"])))
    .orderBy(validationRuns.guardrailVersion, desc(reportCompletionTime), desc(validationRuns.id));
  const releaseIds = versions.flatMap(item => item.runId ? [item.runId] : []);
  const released = releaseIds.length ? await db.select(summary).from(validationRuns)
    .where(and(eq(validationRuns.guardrailId, guardrailId), inArray(validationRuns.id, releaseIds))) : [];
  return [...new Map([...latest, ...completed, ...released].map(run => [run.id, run])).values()];
}
