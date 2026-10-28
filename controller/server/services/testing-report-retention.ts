import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { latestTestEvidence, TESTING_REPORT_RETENTION, type VersionTestEvidence } from "../../shared/testing-report-retention.js";
import type { ControllerDatabase } from "../db/client.js";
import { artifacts, auditEvents, guardrails, guardrailVersions, outboxEvents, validationRuns } from "../db/schema.js";
import { testSuiteDigest } from "../domain/test-suite.js";

type Transaction = Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0];
export const reportCompletionTime = sql<Date>`coalesce(${validationRuns.completedAt}, ${validationRuns.createdAt})`;
export const testEvidenceColumns = {
  testModelRules: validationRuns.testModelRules, testScope: validationRuns.testScope,
  id: validationRuns.id, status: validationRuns.status, candidateDigest: validationRuns.candidateDigest,
  testSuiteDigest: validationRuns.testSuiteDigest, createdAt: validationRuns.createdAt, completedAt: validationRuns.completedAt,
};
export function toTestEvidence(run: { testModelRules?: boolean; testScope?: VersionTestEvidence["testScope"]; id: string; status: string; candidateDigest: string | null; testSuiteDigest: string | null; createdAt: Date; completedAt: Date | null }): VersionTestEvidence | null {
  if (run.status !== "passed" && run.status !== "failed") return null;
  return { testModelRules: run.testModelRules ?? true, testScope: run.testScope ?? null, id: run.id, status: run.status, candidateDigest: run.candidateDigest, testSuiteDigest: run.testSuiteDigest, createdAt: run.createdAt.toISOString(), completedAt: (run.completedAt ?? run.createdAt).toISOString() };
}

/** Caller holds the Guardrail row lock, including during completion and startup cleanup. */
export async function pruneTestingReports(tx: Transaction, guardrailId: string): Promise<number> {
  let removed = 0;
  for (const status of ["passed", "failed", "cancelled"] as const) {
    for (;;) {
      // The persisted immutable version defines the bucket, including its original draft publication report.
      // Draft candidates and deleted versions share the null bucket so creating version IDs cannot grow history forever.
      // Rank in SQL; only bounded, small projections cross the database boundary.
      const ranked = tx.select({ ...testEvidenceColumns, version: validationRuns.guardrailVersion, subject: validationRuns.subject,
        rank: sql<number>`row_number() over (partition by ${guardrailVersions.version} order by ${reportCompletionTime} desc, ${validationRuns.id} desc)`.as("retention_rank"),
      }).from(validationRuns).leftJoin(guardrailVersions, and(
        eq(guardrailVersions.guardrailId, validationRuns.guardrailId), eq(guardrailVersions.version, validationRuns.guardrailVersion),
      )).where(and(eq(validationRuns.guardrailId, guardrailId), eq(validationRuns.status, status))).as("ranked_reports");
      const expired = await tx.select({ testModelRules: ranked.testModelRules, testScope: ranked.testScope, id: ranked.id, status: ranked.status, candidateDigest: ranked.candidateDigest,
        testSuiteDigest: ranked.testSuiteDigest, createdAt: ranked.createdAt, completedAt: ranked.completedAt,
        version: ranked.version, subject: ranked.subject,
      }).from(ranked).where(gt(ranked.rank, status === "cancelled" ? 1 : TESTING_REPORT_RETENTION[status])).orderBy(desc(ranked.rank), ranked.id).limit(200);
      if (!expired.length) break;
      const versions = await tx.select({ version: guardrailVersions.version, status: guardrailVersions.status,
        runId: guardrailVersions.validationRunId, evidence: guardrailVersions.testingEvidence,
        suite: guardrailVersions.testSuite, checksum: artifacts.checksum })
        .from(guardrailVersions).leftJoin(artifacts, eq(artifacts.id, guardrailVersions.artifactId))
        .where(and(eq(guardrailVersions.guardrailId, guardrailId), inArray(guardrailVersions.version, [...new Set(expired.map(run => run.version))])));
      for (const version of versions) {
        const evidence = { ...version.evidence };
        for (const run of expired.filter(run => run.version === version.version)) {
          const compact = toTestEvidence(run);
          if (!compact) continue; // Cancellation is not evidence of execution.
          if (run.subject === "version") evidence.latest = latestTestEvidence(evidence.latest, compact)!;
          if (version.status === "ready" && run.id === version.runId
            && compact.candidateDigest === version.checksum && version.suite
            && compact.testSuiteDigest === testSuiteDigest(version.suite)) {
            evidence.release = compact;
          }
        }
        await tx.update(guardrailVersions).set({ testingEvidence: evidence }).where(and(
          eq(guardrailVersions.guardrailId, guardrailId), eq(guardrailVersions.version, version.version)));
      }
      const ids = expired.map(run => run.id);
      await tx.delete(outboxEvents).where(and(inArray(outboxEvents.id, ids), eq(outboxEvents.kind, "guardrail.validation_requested")));
      await tx.delete(validationRuns).where(inArray(validationRuns.id, ids));
      await tx.insert(auditEvents).values({ id: randomUUID(), kind: "guardrail.testing_reports_pruned", actorId: null,
        resourceType: "guardrail", resourceId: guardrailId,
        detail: { status, count: ids.length, runIds: ids, retention: TESTING_REPORT_RETENTION, scope: "per_immutable_version", unversionedHistory: "separate_shared_bucket" } });
      removed += ids.length;
    }
  }
  return removed;
}

/** Apply the same policy to existing data on every Controller startup. */
export async function pruneTestingReportHistory(db: ControllerDatabase): Promise<number> {
  let after: string | undefined;
  let removed = 0;
  for (;;) {
    const page = await db.select({ id: guardrails.id }).from(guardrails).where(after ? gt(guardrails.id, after) : undefined).orderBy(guardrails.id).limit(100);
    if (!page.length) return removed;
    for (const { id } of page) removed += await db.transaction(async tx => {
      const [guardrail] = await tx.select({ id: guardrails.id }).from(guardrails).where(eq(guardrails.id, id)).for("update");
      return guardrail ? pruneTestingReports(tx, id) : 0;
    });
    after = page.at(-1)!.id;
  }
}
