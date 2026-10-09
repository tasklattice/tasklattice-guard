import { isValidationRunning } from "@/components/validation-run-progress";
import type { GuardrailVersion, ValidationRun } from "./api-types";

/**
 * What a version's release looks like in this environment, derived for
 * display only. The persisted state is just pending or ready; whether a
 * pending version can be released follows from its test runs here.
 */
export type VersionReleaseState =
  | "released"
  | "released_retest_failed"
  | "untested"
  | "testing"
  | "test_failed"
  | "releasable";

export function versionReleaseState(version: GuardrailVersion, runs: readonly ValidationRun[]): { state: VersionReleaseState; run: ValidationRun | null } {
  const own = runs.filter(run => run.subject === "version" && run.guardrail_version === version.version)
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
  const completed = own.find(run => !isValidationRunning(run));
  if (version.status === "ready") {
    // A later failed test never revokes a release; it is shown for people to act on.
    const retest = completed && version.released_at && completed.created_at > version.released_at ? completed : null;
    const releasedWith = runs.find(run => run.id === version.release_run_id) ?? null;
    return retest?.status === "failed" ? { state: "released_retest_failed", run: retest } : { state: "released", run: releasedWith };
  }
  if (own[0] && isValidationRunning(own[0])) return { state: "testing", run: own[0] };
  if (!completed) return { state: "untested", run: null };
  if (completed.status !== "passed") return { state: "test_failed", run: completed };
  // A pass of other content (a different Artifact) says nothing about this one.
  return completed.candidate_digest === version.plan_checksum ? { state: "releasable", run: completed } : { state: "untested", run: null };
}
