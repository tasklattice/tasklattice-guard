import { describe, expect, it } from "vitest";
import type { GuardrailVersion, ValidationRun } from "./api-types";
import { latestVersionTestStatus, versionReleaseState } from "./version-release";

const version = (extra: Partial<GuardrailVersion> = {}) => ({ version: "v1", plan_checksum: "digest", status: "ready", released_at: "2026-10-09T10:00:00Z", release_run_id: "release-run", ...extra }) as GuardrailVersion;
const run = (id: string, status: "passed" | "failed", created_at: string, extra: Partial<ValidationRun> = {}) =>
  ({ id, guardrail_version: "v1", subject: "version", status, execution_status: status, candidate_digest: "digest", created_at, ...extra }) as ValidationRun;

describe("a version's release state", () => {
  it("keeps historical waivers as metadata with the ordinary release state", () => {
    const failure = run("source", "failed", "2026-10-09T09:00:00Z", { subject: "draft" });
    const waived = version({ release_run_id: null, test_waiver: { sourceRunId: "source" } as GuardrailVersion["test_waiver"] });
    expect(versionReleaseState(waived, [failure])).toMatchObject({ state: "released", run: null });
    expect(latestVersionTestStatus(waived, [failure])).toEqual({ status: "failed" });
    expect(versionReleaseState(waived, []).state).toBe("released");
  });
  it("names the report a released version was released with", () => {
    expect(versionReleaseState(version(), [run("release-run", "passed", "2026-10-09T09:00:00Z")])).toMatchObject({ state: "released", run: { id: "release-run" } });
  });

  it("never revokes a release, but shows a failed retest after it", () => {
    const runs = [run("release-run", "passed", "2026-10-09T09:00:00Z"), run("retest", "failed", "2026-10-09T11:00:00Z")];
    expect(versionReleaseState(version(), runs)).toMatchObject({ state: "released_retest_failed", run: { id: "retest" } });
  });

  it("ignores draft runs: only tests of this version, here, count", () => {
    const pending = version({ status: "pending", released_at: null, release_run_id: null });
    expect(versionReleaseState(pending, [run("draft", "passed", "2026-10-09T09:00:00Z", { subject: "draft" })]).state).toBe("untested");
    expect(versionReleaseState(pending, [run("here", "passed", "2026-10-09T09:00:00Z")]).state).toBe("releasable");
  });

  it("preserves failed outcomes after reports expire and lets a newer pass supersede them", () => {
    const archived = { id: "expired-failure", status: "failed" as const, candidateDigest: "digest", testSuiteDigest: "suite",
      createdAt: "2026-10-09T11:00:00Z", completedAt: "2026-10-09T11:01:00Z" };
    const released = version({ testing_evidence: { latest: archived } });
    const oldPass = run("release-run", "passed", "2026-10-09T09:00:00Z");
    expect(versionReleaseState(released, [oldPass])).toEqual({ state: "released_retest_failed", run: null });
    expect(latestVersionTestStatus(released, [oldPass])).toEqual({ status: "failed" });
    const pending = version({ status: "pending", testing_evidence: { latest: archived } });
    expect(versionReleaseState(pending, [oldPass])).toEqual({ state: "test_failed", run: null });
    expect(versionReleaseState(pending, [oldPass, run("new-pass", "passed", "2026-10-09T12:00:00Z")])).toMatchObject({ state: "releasable", run: { id: "new-pass" } });
  });

  it("uses completion order and archived passing evidence without linking a deleted report", () => {
    const archived = { id: "expired-pass", status: "passed" as const, candidateDigest: "digest", testSuiteDigest: "suite",
      createdAt: "2026-10-09T08:00:00Z", completedAt: "2026-10-09T11:01:00Z" };
    const pending = version({ status: "pending", testing_evidence: { latest: archived } });
    const earlier = run("failure", "failed", "2026-10-09T09:00:00Z", { completed_at: "2026-10-09T10:00:00Z" });
    expect(versionReleaseState(pending, [earlier])).toEqual({ state: "releasable", run: null });
    expect(latestVersionTestStatus(pending, [earlier])).toEqual({ status: "passed" });
  });
});
