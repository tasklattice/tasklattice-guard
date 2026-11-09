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

Guardrail versions use `pending → ready` (Pending → Released). Publication requires compiled executable content. Tests are optional, including while queued, running or failed. Deleting reports never revokes publication. Content stays immutable. Multiple versions can be referenced simultaneously, so there is no Guardrail-wide Active / Historical version pointer. The UI shows Not ready or Enforce / Monitor / Bypass. A mode requires at least one retained qualifying release; mode changes apply to all online versions without changing publication or tests. Runner confirmation is shown separately. See the [Guardrail lifecycle guide](document/en/overview/03-term-guardrail.mdx).

## Rollback

- Router: Rollback in a historical revision's menu restores its routing configuration into the draft. Review and publication then create a new Revision. Current Endpoint bindings are not restored from the historical snapshot. Server-side rollback publication also creates a new Revision.
- Guardrail: explicitly choose a retained Released version in a Router change. The exact version content is reused; other Router targets remain pinned. There is no resource-wide activate/rollback action.
- Immutable means content is not modified in place, not that it can never be deleted.

## Deletion

Version actions use ellipsis menus; Delete is red and opens a confirmation sheet on the right. Router revisions have restore/rollback actions; Guardrail versions have Test, Release, Export and Delete actions according to state and references. The server rechecks restrictions. Only administrators can delete.

- Router: the current activeRevision cannot be deleted. Before deleting a historical revision, Runners must have converged, the Router's last update must be more than five minutes old, and there must be no unfinished routing calls within the five-minute retention window.
- GuardRail: a version is deletable when nothing references it: not an active Router snapshot, not an edited Router draft, not a pending change request, and not the pre-approved rollback target of the active change. `GET /guardrails/{id}/versions/{version}/deletion-impact` lists these references. Calls that may still be running, versions retired from routing less than five minutes ago, and online Runners that have not applied the retiring generation also block deletion.
- Deletion uses the same transaction-lock order as Router publication, draft saves, and Endpoint binding. Deletion and Guardrail publication/release are serialized through the Guardrail row lock.
- Deletion removes only the version record, not compiled artifacts, runtime logs, distribution records, or audit evidence. Router deletion audits preserve the snapshot and original publication idempotency key. Replaying publication of a deleted revision returns a conflict to prevent accidental republication.
- Older historical Router Revisions do not block GuardRail version deletion. They stay for audit, are listed as unrestorable in the deletion impact and audit event, and fail validation if restored.
- Deleted versions cannot be restored through the version list. Re-import of identical signed static content can recreate a removed package version as Pending; Publication is explicit and independent of tests. Deleting the whole Guardrail clears reports and resets publication. The retention window reflects the current five-minute call-retention assumption, not a guarantee for external requests of unlimited duration.

APIs: `DELETE /api/v1/routers/:id/revisions/:revision`, `DELETE /api/v1/guardrails/:id/versions/:version`. Success returns 204; still in use returns 409; not found returns 404; insufficient permissions returns 403.

## Resource deletion and reports

Deleting a Guardrail version preserves its reports, but reports without a retained version do not qualify the resource as Ready. Removing the last released version returns the resource lifecycle to draft.

A completed Testing Report can be permanently deleted after impact review. It clears report references without changing publication, routing or protection mode. Only queued or running reports cannot be deleted. Audit events retain deletion identity and impact; version definitions and cases remain.

Soft-deleting the whole Guardrail preserves static identity, versions, the working draft, cases, Artifacts and provenance, clears reports/tasks and runtime data, and resets retained versions to Pending. It does not automatically remove Router targets: published references and pending changes must be removed first, and call-retention checks must pass. The preconfigured Default uses the same deletion checks and is not recreated at startup. Confirmed re-import from the owning source can restore an imported identity, preserving its working draft without restoring local evidence. Package ownership checks reject an ordinary locally created identity even after deletion, so this is not a universal restore operation.

## Unified Guardrail lifecycle — 2026-10-26

Default, user-created and Profile-created Guardrails share creation, editing,
publication, tests, protection modes and deletion rules. Deployment provisions
an ordinary Guardrail named Default from `local-baseline@1.0.0` once; a separate
provisioning record prevents recreation after rename or deletion. Existing IDs
stay unchanged.

UI, API and CLI use one publication flow. Compilation freezes the reviewed draft
without runtime loading, credentials or model calls. It may reuse a matching
compiled test candidate regardless of test outcome. Concurrent retries publish
one version per draft revision; editing during compilation rejects the stale
attempt without changing existing releases. A connected upgraded compiler Runner
is needed when no compiled candidate is available.

Publication, test outcomes and environment readiness are separate axes. A failed
test stays failed after publication. Historical platform releases and waivers
remain audit provenance. Report retention or deletion never downgrades a release.
The executable Artifact and stored publication determine resource readiness;
Runner checks and Router rollout describe deployment readiness separately.
