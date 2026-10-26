import { isValidationRunning } from "@/components/validation-run-progress";
import type { GuardrailVersion, ValidationRun } from "./api-types";
import { latestTestEvidence, type VersionTestEvidence } from "../../shared/testing-report-retention";

function evidenceOf(run: ValidationRun): VersionTestEvidence | null {
  if (run.status !== "passed" && run.status !== "failed") return null;
  return { testModelRules: run.test_model_rules ?? true, testScope: run.test_scope ?? null, id: run.id, status: run.status, candidateDigest: run.candidate_digest, testSuiteDigest: run.test_suite_digest,
    createdAt: run.created_at, completedAt: run.completed_at ?? run.created_at };
}

/** A compact outcome can be shown after its full report has expired, without a dead report link. */
export function latestVersionTestStatus(version: GuardrailVersion, runs: readonly ValidationRun[]): Pick<ValidationRun, "status"> | null {
  const own = runs.filter(run => run.guardrail_version === version.version);
  if (own.some(isValidationRunning)) return { status: "incomplete" };
  const evidence = latestVersionTestEvidence(version, own);
  return evidence ? { status: evidence.status } : null;
}

export function latestVersionTestEvidence(version: GuardrailVersion, runs: readonly ValidationRun[]): VersionTestEvidence | null {
  return runs.filter(run => run.guardrail_version === version.version)
    .reduce<VersionTestEvidence | null>((latest, run) => latestTestEvidence(latest, evidenceOf(run)),
      latestTestEvidence(version.testing_evidence?.latest, version.testing_evidence?.release));
}

/**
 * What a version's release looks like in this environment, derived for
 * display only. The persisted state is just pending or ready; whether a
 * testing is informational and never gates publication.
 */
export type VersionReleaseState =
  | "released_waiver"
  | "released"
  | "released_retest_failed"
  | "untested"
  | "testing"
  | "test_failed"
  | "releasable";

export function versionReleaseState(version: GuardrailVersion, runs: readonly ValidationRun[]): { state: VersionReleaseState; run: ValidationRun | null } {
  const own = runs.filter(run => run.subject === "version" && run.guardrail_version === version.version)
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
  const completed = own.reduce<VersionTestEvidence | null>((latest, run) => latestTestEvidence(latest, evidenceOf(run)), version.testing_evidence?.latest ?? null);
  const retained = own.find(run => run.id === completed?.id) ?? null;
  if (version.status === "ready") {
    // Historical waivers are audit metadata. All releases show the same test states.
    const retest = completed && version.released_at && Date.parse(completed.completedAt) > Date.parse(version.released_at) ? completed : null;
    const releasedWith = runs.find(run => run.id === version.release_run_id) ?? null;
    return retest?.status === "failed" ? { state: "released_retest_failed", run: retained } : { state: "released", run: releasedWith };
  }
  const active = own.find(isValidationRunning);
  if (active) return { state: "testing", run: active };
  if (!completed) return { state: "untested", run: null };
  if (completed.status !== "passed") return { state: "test_failed", run: retained };
  // A pass of other content (a different Artifact) says nothing about this one.
  return completed.candidateDigest === version.plan_checksum ? { state: "releasable", run: retained } : { state: "untested", run: null };
}
