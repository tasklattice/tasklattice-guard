# Router and GuardRail Version Lifecycles

## Configuration and Status Boundaries

`RouterRevision` in `proto/tasklattice/guard/control/v1/routing.proto` defines the immutable routing configuration received by Runners, not the Controller's deployment health. Status is derived from publication records, target generation, Runner ACKs, heartbeats, and rejection details; it must not be written back into immutable snapshots.

The sole Router status derivation entry point is `controller/shared/router-lifecycle.ts`, with transition comments and unit tests. It computes the complete derived state rather than maintaining a persisted state-transition table.

| Current condition / event | Result | Notes |
| --- | --- | --- |
| No published activeRevision | Unpublished | Drafts do not handle traffic |
| Publication or rollback creates a new target generation | Distributing | Waiting for Runners to apply it |
| At least one Runner in the default pool, all ACKs at or above the target generation, heartbeats less than 60 seconds old | Active | Convergence takes precedence over earlier rejection details |
| Not converged, with rolloutError | Failed | Shows the current distribution error |
| Not converged, without rolloutError | Distributing | Includes no Runners, stale heartbeats, or a new Runner that has not caught up |
| Republish after Failed | Distributing | Publication clears the old error |
| All Runners converge after Failed | Active | No change to the published snapshot is required |
| Heartbeat expires / a new Runner has not caught up after Active | Distributing or Failed | Failed if rejection details remain |

`activeRevision` is the revision the Controller currently wants active; it does not mean every Runner has applied it. The current revision in the revision list shows Active (green), Deploying (yellow), or Failed (red); other revisions show Previous (neutral badge). Previous indicates only a historical revision and does not imply it ever deployed successfully.

Guardrail versions use `pending → ready` (Pending → Released). Release requires a local Passed report matching the Artifact and frozen test suite. Deleting its last matching proof returns the version to pending; another matching proof preserves release. Content stays immutable. Multiple versions can be referenced simultaneously, so there is no Guardrail-wide Active / Historical version pointer. Resource Ready requires at least one retained qualifying release; traffic references and Runner rollout are separate. See the [Guardrail lifecycle guide](document/en/overview/03-term-guardrail.mdx).

## Rollback

- Router: Rollback in a historical revision's menu restores its routing configuration into the draft. Review and publication then create a new Revision. Current Endpoint bindings are not restored from the historical snapshot. Server-side rollback publication also creates a new Revision.
- Guardrail: explicitly choose a retained Released version in a Router change, or switch the Default baseline. The exact version content is reused; other Router targets remain pinned. There is no resource-wide activate/rollback action.
- Immutable means content is not modified in place, not that it can never be deleted.

## Deletion

Version actions use ellipsis menus; Delete is red and opens a confirmation sheet on the right. Router revisions have restore/rollback actions; Guardrail versions have Test, Release, Export and Delete actions according to state and references. The server rechecks restrictions. Only administrators can delete.

- Router: the current activeRevision cannot be deleted. Before deleting a historical revision, Runners must have converged, the Router's last update must be more than five minutes old, and there must be no unfinished routing calls within the five-minute retention window.
- GuardRail: a version is deletable when nothing references it: not the runtime baseline, not an active Router snapshot, not an edited Router draft, not a pending change request, and not the pre-approved rollback target of the active change. `GET /guardrails/{id}/versions/{version}/deletion-impact` lists these references. Calls that may still be running, versions retired from routing less than five minutes ago, and online Runners that have not applied the retiring generation also block deletion.
- Deletion uses the same transaction-lock order as Router publication, draft saves, and Endpoint binding. Deletion and Guardrail publication/release are serialized through the Guardrail row lock.
- Deletion removes only the version record, not compiled artifacts, runtime logs, distribution records, or audit evidence. Router deletion audits preserve the snapshot and original publication idempotency key. Replaying publication of a deleted revision returns a conflict to prevent accidental republication.
- Older historical Router Revisions do not block GuardRail version deletion. They stay for audit, are listed as unrestorable in the deletion impact and audit event, and fail validation if restored.
- Deleted versions cannot be restored through the version list. Re-import of identical signed static content can recreate a removed package version as Pending; Release requires a matching local version-test report. Reports retained after deleting only a version may still supply that evidence; deleting the whole Guardrail clears them and requires a new test. The retention window reflects the current five-minute call-retention assumption, not a guarantee for external requests of unlimited duration.

APIs: `DELETE /api/v1/routers/:id/revisions/:revision`, `DELETE /api/v1/guardrails/:id/versions/:version`. Success returns 204; still in use returns 409; not found returns 404; insufficient permissions returns 403.

## Resource deletion and reports

Deleting a Guardrail version preserves its reports, but reports without a retained version do not qualify the resource as Ready. Removing the last released version returns the resource lifecycle to draft.

A completed Testing Report can be permanently deleted after impact review. Equivalent Passed evidence replaces the release binding, or the version returns to Pending. References protecting a version also protect its final passing evidence. Audit events retain deletion identity and impact; version definitions and cases remain.

Soft-deleting the whole Guardrail preserves static identity, versions, the working draft, cases, Artifacts and provenance, clears reports/tasks and runtime data, and resets retained versions to Pending. It does not automatically remove Router targets: published references and pending changes must be removed first, and call-retention checks must pass. The Default Guardrail cannot be deleted. Confirmed re-import from the owning source can restore an imported identity, preserving its working draft without restoring local evidence. Package ownership checks reject an ordinary locally created identity even after deletion, so this is not a universal restore operation.

## Implementation audit — 2026-10-10

Scope: the English and Chinese `overview/term-guardrail` articles, Controller state transitions, and their UI projections. The core resource Ready rule and ten-version limit match the code. The articles now distinguish persisted resource lifecycle, derived readiness, draft test state, version release state and individual reports. They also document first-Default-publication baseline initialization and the fact that rename/log-level changes do not invalidate draft tests.

The following implementation differences remain unresolved; this audit changes documentation, not runtime behavior:

| Finding | Current implementation and consequence | Source |
| --- | --- | --- |
| Draft publication uses different reports in UI and API | UI requires the latest current-revision draft run to pass. The API searches for the most recent Passed run of that revision, so a later Failed or running test does not prevent direct API publication. Candidate content checks still apply. | `src/lib/guardrails-api.ts` (`mapGuardrail`), `src/components/guardrail-draft-review.tsx`, `server/services/control-plane.ts` (`requestGuardrailPublish`) |
| Release eligibility is not identical in UI and API | UI waits for the latest-created version run and checks the Artifact digest. API selects the latest-completed version run, requires Passed plus Artifact and suite digests, and does not separately reject an ongoing run. Releasing an already ready version returns early without rechecking evidence. | `src/lib/version-release.ts`, `server/services/control-plane.ts` (`releaseGuardrailVersion`) |
| Released can disagree with resource Ready for inconsistent historical data | `guardrailSummary` requires any retained matching Passed evidence. Version badges, Router publication and baseline selection trust stored ready status without rechecking that evidence; export instead validates the specific `validationRunId` binding. An orphaned release binding is not automatically repaired by a retest or an idempotent Release. Normal report deletion maintains/replaces that binding and downgrades a release with no remaining proof. | `server/services/control-plane.ts` (`guardrailSummary`, `setSystemBaseline`, `deleteTestingReport`), `server/services/traffic-routing.ts` (`resolvePublication`), `server/services/guardrail-packages.ts` (`exportPackage`), `src/lib/version-release.ts` |
| Restore still depends on origin | Normal editing/testing/publishing actions are shared, but restoration only accepts the original source of an imported Guardrail. An ordinary local identity is rejected even if soft-deleted. Reserved system IDs have a separate trusted-source authorization rule; the Default Guardrail itself is not deletable. | `server/services/guardrail-packages.ts` (`ownership`, `importPackage`), `server/services/control-plane.ts` (`softDeleteGuardrail`) |
| Startup baseline adoption bypasses local Release | With a configured `CONTROLLER_BASELINE_PACKAGE_PATH` and an empty baseline, `importBaselinePackage` imports Pending content and immediately writes the baseline pointer without a local test/Release check. Desired-state assembly includes referenced baseline Artifacts regardless of release status. This differs from `setSystemBaseline` and the documented release prerequisite; normal UI imports do not take this path. | `server/index.ts`, `server/services/control-plane.ts` (`importBaselinePackage`, `desiredStateForPool`, `setSystemBaseline`) |

These findings describe reachable code paths, not proof that the running environments currently contain missing-evidence records. The source paths above are relative to `controller/`. For evidence rules, the existing publication/package PostgreSQL suites cover matching digests, retained proof deletion, imported Pending versions, restoration and source conflicts; frontend suites cover the displayed projections.
