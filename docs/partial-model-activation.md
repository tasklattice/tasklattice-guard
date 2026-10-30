# Apply model configuration

Model settings have **current configuration + pending changes**, not user-managed
versions. The Guardrail Catalog's **Review and Apply** sheet lists saved binding
changes. Saved changes are selected initially; users can deselect them. Failed or unrun
model tests are visible warnings and do not prevent selection. Apply overwrites only the selected bindings.

- Readiness is per Input/Output capability binding, not per Provider or whole model.
- Test results remain independent of activation. A successful `nemo-rail-v1` test
  for the exact binding and model is required to report healthy model protection.
  Administrators may save and activate failed or untested bindings; reports and
  activation audits retain their real status. Unknown or incompatible models are rejected.
- Clearing a binding is an explicit removal shown in the review.
- Unselected bindings retain their current values; previously unassigned bindings
  stay unassigned. Pending edits remain saved for a subsequent Apply.
- There is no version selector, history API or rollback. To change a binding back,
  select the desired model and Apply it normally.
- Control-plane Chat is managed independently and applies on save.

## Synchronization and storage

Apply still distinguishes **syncing**, **effective**, and **failed**. The Controller
retains the last acknowledged configuration while distributing the selected changes.
Only a successful Runner acknowledgement replaces that current configuration.
A rejected attempt leaves current settings and pending edits intact.

A unique synchronization ID and generation protect against delayed ACKs and concurrent
writes. The existing internal table/protocol names (`model_configuration_revision`,
`revision_id`) are retained for compatibility, not as a version-history feature.

Editable configuration is updated in place, including after validation. At Apply,
obsolete attempts and drafts are pruned; at acknowledgement, the prior current row
is deleted rather than archived as superseded. Only current/editable/in-flight/error
state is retained as needed, while audit and outbox events remain available.

## API

`POST /api/v1/model-configuration/apply` requires:

```json
{
  "bindingIds": ["content_safety.input"],
  "expectedDraftToken": "draft.reviewToken from GET /model-configuration",
  "expectedActiveId": null
}
```

Supply the reviewed current configuration ID instead of null when one exists.
Neither a version number nor a historical version ID can be selected for Apply.
The old `/revisions/{id}/activate` and `/rollback` routes have been removed.

The server rejects stale reviews, invalid/unchanged/duplicate selections and Apply
while synchronization is in flight. A Controller-row lock serializes Apply, and a
Draft-row lock pins the saved edits. Changes to generation, pending state, audit and
outbox are atomic. `200` means synchronization completed; `202` means still syncing.
Reload the view before retrying a failed or interrupted request.

## Regression coverage

The real PostgreSQL tests use isolated test schemas to cover merging, bounded state,
first Apply, explicit removal, rejected updates, stale reviews, concurrent requests,
delayed ACKs, independent Chat settings, migration cleanup and optimistic locking.
UI and HTTP tests cover selection, disabled actions, removed historical endpoints,
authorization, review preconditions and correct synchronization status.

## Fresh installations

Controller provisions a complete immutable Default baseline from its bundled,
offline-compiled artifact. It is active even before models exist. Its platform
release provenance is separate from local tests: installation creates no passing
report, and historical failed reports are preserved. Existing baselines are not
switched on restart. Regenerate the bundle with
`python -m scripts.generate_default_baseline`; CI checks it against the current
catalog and compiler.

Platform Health reports missing active bindings and failed/unrun model tests.
Controller liveness/readiness remain usable so administrators can configure models.
Models required by Default must be configured to execute its full protection;
runtime load and inference failures retain their fail-closed behavior.
