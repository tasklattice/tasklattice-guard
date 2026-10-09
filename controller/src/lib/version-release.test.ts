import { describe, expect, it } from "vitest";
import type { GuardrailVersion, ValidationRun } from "./api-types";
import { versionReleaseState } from "./version-release";

const version = (extra: Partial<GuardrailVersion> = {}) => ({ version: "v1", plan_checksum: "digest", status: "ready", released_at: "2026-10-09T10:00:00Z", release_run_id: "release-run", ...extra }) as GuardrailVersion;
const run = (id: string, status: "passed" | "failed", created_at: string, extra: Partial<ValidationRun> = {}) =>
  ({ id, guardrail_version: "v1", subject: "version", status, execution_status: status, candidate_digest: "digest", created_at, ...extra }) as ValidationRun;

describe("a version's release state", () => {
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
});
