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

GuardRail version build status retains the existing `compiling → ready / failed` flow; version contents are immutable. Active / Historical describes whether the version is currently activated, independently of build status.

## Rollback

- Router: Rollback in a historical revision's menu restores its routing configuration into the draft. Review and publication then create a new Revision. Current Endpoint bindings are not restored from the historical snapshot. Server-side rollback publication also creates a new Revision.
- GuardRail: retain the existing activation flow for historical ready versions. Confirmation activates that historical version without changing its contents or inventing a new version. Composed Routers pinned to other versions are not automatically rewritten.
- Immutable means content is not modified in place, not that it can never be deleted.

## Deletion

Both resources use an ellipsis menu for version actions: Rollback (edit color) and Delete (red). Deletion opens a confirmation sheet on the right. Menu items for the current version are disabled, and the server rechecks every restriction. Only administrators can call the deletion APIs.

- Router: the current activeRevision cannot be deleted. Before deleting a historical revision, Runners must have converged, the Router's last update must be more than five minutes old, and there must be no unfinished routing calls within the five-minute retention window.
- GuardRail: the active version and versions still compiling cannot be deleted. Deletion is blocked by references from any Router draft, current snapshot, historical Revision, or surviving legacy route. Drafts using Latest also conservatively block deletion of that GuardRail's versions. Deletion must additionally pass the five-minute retention-window, existing default-pool Runner convergence, and unfinished-call checks.
- Deletion uses the same transaction-lock order as Router publication, draft saves, binding, and legacy route creation. Deletion and GuardRail activation are mutually exclusive through the GuardRail row lock.
- Deletion removes only the version record, not compiled artifacts, runtime logs, distribution records, or audit evidence. Router deletion audits preserve the snapshot and original publication idempotency key. Replaying publication of a deleted revision returns a conflict to prevent accidental republication.
- Historical Router Revision references also block GuardRail version deletion, keeping rollback candidates usable. Delete those historical Revisions first.
- Deleted versions cannot be restored through the version list; version identifiers are not reused. The retention window reflects the current five-minute call-retention assumption, not a guarantee for external requests of unlimited duration.

APIs: `DELETE /api/v1/routers/:id/revisions/:revision`, `DELETE /api/v1/guardrails/:id/versions/:version`. Success returns 204; still in use returns 409; not found returns 404; insufficient permissions returns 403.
