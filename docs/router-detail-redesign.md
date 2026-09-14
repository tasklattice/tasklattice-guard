# Traffic Router Detail: Implementation and Acceptance

Updated: 2026-09-12. Aligned with the Router Detail refactoring requirements and the additional requirement to use the GuardRails timestamp design for Revisions. See [Router / Route distribution design](router-route-weighted-distribution-design.md) for the domain model.

## Design Contract

This is a product console for administrators. The first-screen task is to understand source Endpoints, sequentially matched Routes, target GuardRails, and pinned versions. Retain the existing Shell, typography, colors, Tabs, Sheet, forms, and icon components.

- A Router receives multiple Endpoints; an Endpoint belongs to only one Router at a time. All sources share an ordered rule set.
- The first matching rule determines the target set, then percentages select exactly one GuardRail. A request is not duplicated across targets. Selectors retain their expression semantics and support feature conditions beyond canary releases.
- Fallback is always last, unconditional, unnumbered, and cannot be reordered or deleted. It has exactly one target at 100%.
- GuardRail Duplicate belongs to GuardRail creation. It copies configuration only, excluding runtime data and bindings. Routing offers no GuardRail Duplicate entry point.

## Page Interactions

| Area | Final interaction |
| --- | --- |
| Header | Name, actual distribution status, source/rule/target counts, Edit routing, and additional actions |
| Overview | Default Tab; three-column CSS Grid with SVG connectors measured by ResizeObserver, percentages and pinned versions, and a separate dashed Fallback row |
| Endpoints | Real status table, detail navigation, searchable binding sheet, and unbinding confirmation; cannot take Endpoints from another Router |
| Routing | Read-only by default; expanded items show only a Selector → GuardRails diagram. Add/edit use a right-side Sheet reusing Selector/Targets, inline rule errors, dnd-kit pointer/keyboard ordering, and row-end ellipsis action menus |
| Revisions | History list and read-only sheet with time/publisher, diff, publication-time Endpoint snapshot, and pinned target versions; Restore creates a draft |

Overview retains four lightweight configuration summaries; actual distribution statistics move to a separate Monitoring Tab. Missing telemetry shows unknown/no data rather than fabricated metrics. Nodes link to real detail routes; rule nodes switch to and expand Routing. Narrow screens retain the three-column relationship with horizontal scrolling confined to topology/tables.

The unified flow is **Edit routing → Review changes → Publish revision**. Review saves the local draft and obtains a publication preview; there are no separate Save rules / Publish configuration primary-action levels. Cancellation, conflicts, and failures preserve editing context; background refresh failures do not unmount the workspace and lose the draft.

## Timestamp and Version Contract

The detail Header, Overview, Revisions, restore confirmation, and distribution revision selector use `YYYYMMDD-HHmmss.SSSZ`, for example `20260912-085454.607Z`. They reuse GuardRail's `guardrailVersionId` formatter to produce a UTC identifier from immutable `createdAt`, while also showing local publication time.

Numeric database/API revisions remain the keys for ordering, concurrency control, restoration, and log correlation. Timestamps are display identifiers, not unique database keys. Missing data displays “—”; current time never substitutes for historical time.

1. Draft targets add optional `versionStrategy: latest | pinned`. New targets default to Latest when published; existing explicit versions are interpreted as pinned.
2. `POST /api/v1/routers/:id/preview` validates draftRevision, resolves the latest usable published GuardRail, and returns a pinned snapshot and Endpoint set.
3. Publish submits `reviewedSnapshot` / `reviewedEndpointIds`. The transaction resolves and compares again; version or binding drift is rejected and requires another review. Retries reuse the same idempotency key.
4. Revision / activeSnapshot store only pinned versions; drafts preserve latest/pinned intent. Later GuardRail publications do not change old Router Revisions.
5. Migration `0010_router_revision_context.sql` records publication-time Endpoint ID/name/adapter and GuardRail ID/name/version. Legacy empty context remains empty with an explicit message that historical sources are unavailable.
6. Endpoint bindings take effect independently and are audited. Restore copies old routing into a new draft while retaining current Endpoint bindings; Review / Publish creates a new revision, leaving the old revision unchanged.

Successful publication does not mean Runners have applied it. Active depends on actual rolloutStatus. Waiting states show Distributing/Deploying.

A Revision describes the **possible routing decisions** at that time. To determine which Route a request actually matched and which GuardRail/version it reached, inspect that request's Runtime routing decision logs. Static configuration cannot reveal a random allocation result, and publication-time Endpoint snapshots do not replace later binding audits.

## Engineering Boundaries

`router-detail.tsx` owns queries, editing lifecycle, publication, and Tab coordination. Overview, Endpoints, Routing, Revisions, Review Sheet, and summaries/diffs are separate components in the same directory. Reuse existing Selector, TargetsEditor, EntitySheet, and real APIs rather than creating another condition model or a free-form canvas.

All six stages are implemented: information architecture, topology, Endpoints, Routing editing, Review/version pinning, and Revision/Restore. The following records actual checks; final checks are not presented as independent checks for every stage.

## Verification and Evidence

- Full Vitest: 122 files passed, 5 skipped; 947 tests passed, 53 skipped.
- Isolated real PostgreSQL routing-service tests: 24 passed, covering previews, version pinning, publication conflicts, and immutable history.
- Final relevant regression: 260 tests across 5 files passed, covering the workspace, Endpoint, shared model, HTTP, and permissions.
- `npm run typecheck` and frontend/backend `npm run build` passed. The project has no lint script; no nonexistent lint run is claimed. Builds retain bundle-size warnings.
- The browser connected to an isolated database copy with real configuration and no UI mocks. Verified conditional rules, 90/10 dual targets, Review/Publish, historical details, and new versions after Restore.
- Exercised Endpoint details, searchable binding and confirmed unbinding, rule navigation, Route copying, keyboard reordering, and cancellation of unsaved edits. Fallback always remained last.
- Checked desktop 1440×1000 and narrow 390×844: narrow document width was 375px in a 390px viewport; the topology viewport was 307px wide with 880px content, without widening the entire page.

Screenshots:

- [Desktop Overview](evidence/router-detail-20260912/overview-desktop.png)
- [Narrow-screen Overview](evidence/router-detail-20260912/overview-mobile.png)
- [Rule editing](evidence/router-detail-20260912/routing-edit.png)
- [Copying and ordering](evidence/router-detail-20260912/routing-reorder.png)
- [Review](evidence/router-detail-20260912/review-publish.png)
- [Timestamp history list](evidence/router-detail-20260912/revisions-timestamps.png)
- [Historical details](evidence/router-detail-20260912/revision-detail.png)

Early Review/detail screenshots preserve their state at the time; the latest timestamp-list screenshot is authoritative for version display identifiers.

## Vibe Designing Acceptance

Acceptance used Product Console weights and the prototype path with a real database copy/API. Subchecks score 0–2; evidence precedes scoring.

| Dimension | Subcheck evidence and deductions | Raw score | Dimension score | Weight |
| --- | --- | --- | --- | --- |
| Product Intent | Traffic flow, primary action, and source/rule semantics are visible | 6/6 | 10 | 22% |
| Information Architecture | Four Tabs, collapsible editing, separate Fallback | 6/6 | 10 | 22% |
| System Craft | Existing component styling and local scrolling passed; narrow tables still require horizontal reading | 5/6 | 8.33 | 14% |
| Trust & Domain Fit | Pinned versions, real history, unknown states; runtime not verified with a connected Runner | 5/6 | 8.33 | 18% |
| Interaction Readiness | Binding/publication/restoration, keyboard ordering, and failure-preservation tests passed; browser did not cover all failure combinations | 7/8 | 8.75 | 16% |
| Visual & Brand | Existing typography/colors, topology as the main visual, and lightweight hierarchy | 4/4 | 10 | 8% |

Weighted score: approximately 9.27/10, with no blockers in verified primary flows. The production release gate still requires post-deployment confirmation of actual Runner request execution, telemetry return, and convergence to Active; successful publication in the copy cannot substitute for these.

`38184` is an isolated preview; `38081` has not received these changes. No Git commit or live-routing modification was made.

## Route Editing Addendum (2026-09-12)

Following the latest feedback, the Route form moved from inside the list into a right-side Sheet: name and Traffic Selector at the top, GuardRails targets below. Add/copy first creates sheet-local configuration; confirming Add rule inserts it into the Router draft. Apply changes updates the draft when editing. Cancellation leaves no empty entry and does not modify the original rule. Configuration errors appear in the sheet and block submission.

The expanded list area is read-only, showing traffic expression → targets with percentages/versions; Edit opens the same sheet. Fallback remains nondeletable, nonreorderable, and limited to one 100% target. Review / Publish and runtime execution semantics are unchanged.

A real browser/API test selected two targets and added a local 70/30 draft. Regression coverage includes canceling creation, blocking invalid configuration, confirming copies, and continuing into publication.

- [Route creation sheet](evidence/router-detail-20260912/route-create-sheet.png)
- [Route traffic diagram](evidence/router-detail-20260912/route-flow-summary.png)

### Route Action Placement and Colors (2026-09-12)

The top-right Routing header contains only the standalone Add routing rule action. Each Route row always ends with an ellipsis menu offering Edit or Delete; the expanded area shows only Selector → GuardRails. Fallback permits editing only. Add and edit both open a right-side Sheet without first entering global edit mode or expanding an item.

| Action | Color | Effect and confirmation |
| --- | --- | --- |
| Add rule, add target | Blue | Local draft; canceling the sheet inserts no empty rule |
| Edit, Apply changes | Amber yellow | Updates only the draft, which can be reviewed before publication |
| Delete rule | Red | Right-side confirmation shows the rule name and impact; confirmation removes it from the draft |
| Review / Publish | Blue | Affects new traffic only after review and publication |
| Cancel | Neutral | Closes the current interaction |

Shared Button semantic variants manage colors. Icons also have accessible names and tooltips; color alone must not identify an action. This round applies to Routing interactions and does not recolor other pages in bulk.

2026-09-12 fix: removed the Enabled switch from the Route edit sheet. Endpoint lists, Router source lists, and topology share EndpointProtocolIcon, showing protocol-specific icons. Sidebar counts are vertically centered along navigation rows.

### Separate Monitoring View

Tab order: Overview → Endpoints → Routing → Monitoring → Revisions. Overview no longer contains a collapsible metrics area. Monitoring directly displays time range, Revision and Endpoint filters, request summaries, Route distribution, target details, and runtime trends, preserving telemetry-delay and no-data states. Metrics mount and poll only while Monitoring is open; Overview makes no background metric requests. This round reuses existing statistics displays without adding a metric traffic-flow diagram.

### Routing Configuration Diff

Publication review and historical revisions share the single-column Diff from react-diff-viewer-continued: red + means added and green − means removed, following the explicit product convention. It compares complete configuration snapshots, preserving rule identity, ordering, Selectors, targets, weights, and versions, with Guardrail names and percentages added for readability. Unchanged context is collapsed by default and can be expanded. The review sheet uses xl width; the Diff removes the library's default 1000px minimum width and wraps long lines. The component loads on demand. Version-resolution results and the integration list remain separate.
