# Multi-tenancy verified checkpoint — 2 November 2026

This checkpoint records completed working-tree increments. It is not a commit,
deployment, production certification or completion of full multi-tenancy. The
first table predates the group-controls increment documented below; overlapping
counts from separate runs must not be added together.

## Independent combined checks

| Check | Result | Coverage boundary |
| --- | --- | --- |
| Full Controller server suite |1360 passed;364 skipped;105 files passed/48 skipped | Database-gated and intentional skips are not accepted as database evidence. |
| Local PostgreSQL combined |196 passed across15 files | Disposable schemas; storage budgets/lifecycle, runtime/routing provenance, progress, moves, leases/sessions, pricing/enrichment and credentials. |
| Runner combined |380 passed | Real loopback Redis and streaming fixtures enabled; admission, pipeline/stream provenance, durable WAL/progress, control/config/lease/synchronization/API/Scan/metrics. No Provider billing or external LLM was used. |
| Helm focused contracts |78 passed | Storage budgets, progress persistence, admission, pool credentials and Runner network policies. Render tests do not prove CNI/PVC behavior. |
| Full Controller build |Passed | UI/server/CLI; OpenAPI generation/check152 operations458 schemas. Existing Carbon Sass and bundle-size warnings remain. |
| Generated control protocol |Passed | Project generator `--check`; generated clients were not hand-edited. |
| Whitespace |Passed | `git diff --check`. |

The PostgreSQL run covered `endpoint-context-storage`, Endpoint/routing/progress HTTP, prepared/finalized moves, tenant groups, grant ledger/control sessions/grant protocol, scoped telemetry, event enrichment, model pricing, validation credentials and traffic-routing suites. Worker checks add useful focused cases, but overlap these counts and must not be added together. Prior22-case storage and independent14-case bounded-reader checks passed. A real-cluster Helm lifecycle fixture remains skipped because no deployment was performed.

## Implemented behavior

- New provenance allocations have per-pool/global retained-row and logical-payload budgets; SQL measures UTF-8/JSONB bytes. Unchanged authority reuses its original-generation context; retirement is never reversed, and a repeated configuration gets a fresh256-bit ID.
- A persisted sweep cursor visits at most128 retired records per maintenance tick.31-day conservative retirement retention and runtime/cost/routing references protect history. Shared reader/exclusive lifecycle locks prevent cleanup racing evidence commits.
- Scoped routing events now require the authenticated pool and exact frozen Endpoint/Router revision/route/target/Guardrail/version. Unknown or conflicting evidence remains platform-only, and cannot enrich an attributed or quarantined record.
- Optional progress requires a current control-session capability plus pool authentication. Mixed runtime/cost/routing writes and contiguous cursor ACK commit together. Exact batch ID and raw-body digest protect response-loss/reconnect compaction. Different Runner batches can proceed concurrently; replacement cannot commit while an authenticated batch holds its Runner row share lock.
- Single-writer WAL persistence uses file locks, fsync and atomic replacement, with8MiB/10000-record bounds and pending-envelope reserve. Adaptive batches respect server work/body budgets; unsupported individual evidence remains retained for reconciliation.
- Authenticated uploads have4 concurrent process slots/2 per pool,8MiB actual streamed-byte bounds,10s read deadline, depth64 and100000 structural-token budget. Model work is limited to64 calls/event and256/batch before a transaction. These are process-level input/work bounds, not whole-controller heap or total transaction-latency guarantees.
- Helm defaults progress off and requires explicit per-replica persistence when enabled. Separate64Mi claims preserve WAL identity independently of the artifact cache; enabling/disabling an existing StatefulSet requires the documented controlled recreation/recovery procedure.

## Explicit remaining limits

Empty caught-up receipts are diagnostics and can be stale/replayed. Scoped freshness/deletion/rollout gates remain unavailable; no new completeness guarantee is enabled. Pool credentials remain a shared trust domain. Unmounted/lost progress volumes need external recovery/downgrade gating. Logical metadata budgets do not bound database heap/index/TOAST/WAL/backup bytes; referenced history needs archive policy and may exhaust budgets. Global event/decision IDs still permit availability preemption if another authenticated pool learns an ID before delivery; no tenant attribution promotion is allowed.

There is no production permanent-fence adapter or safe-move API/UI integration yet. No multi-node/frozen-host/HA/CNI/PVC durability certification, no changes to the existing A/B/C demo, and no commit or push were performed. The local2Gi Docker setting is not a proof that every feature fits in production.

Detailed mechanics: [context storage](endpoint-context-storage.md), [provenance](endpoint-telemetry-capabilities.md), [authenticated progress](authenticated-telemetry-progress.md), [persistent rollout](runner-telemetry-progress-rollout.md), [moves](tenant-group-move-protocol.md).

## Group controls and administrator UI increment

The next increment implements group-wide rate admission, a measured admission
dashboard and explicit group runtime Model grants. A further drain check denies
future configuration and active credential retrieval in both legacy and scoped
modes. None of these modes was enabled in the retained public demo.

| Check | Result | Evidence boundary |
| --- | --- | --- |
| All PostgreSQL suites | 421 passed; 2 skipped; 51 files passed/1 skipped | Every `postgres.test.ts` suite, both database environment variables enabled, serial workers. This full run predates the two additional Model drain cases. |
| Final Model/drain/credential PostgreSQL | 27 passed across 3 files | Includes the two new draining cases plus overlapping group-grant, pool-allocation and durable candidate-lease tests. |
| Final Model/control/HTTP unit set | 109 passed across 3 files | Coherent per-pool configuration, pinned global activation, old/stale/group ACK/NACK denial and current-session distribution. |
| Runner/pipeline integrated | 401 passed; no skips | Real loopback Redis, streaming fixtures, local/group admission, snapshot metrics, provenance, durable delivery, control/config/leases, API, real Nemo/Scan and Playground paths. Ten third-party deprecation warnings. |
| Group/monitor/admin UI | 36 passed across 4 files | Group policy review/version/fingerprint pinning, conflict recovery, blocking with unavailable catalog, actual monitor and existing lab/group controls. jsdom tests do not prove browser layout or live deployment. |
| Helm focused contracts | 102 passed | Group/pool admission, context budgets, persisted progress, pool auth and network policy rendering. |
| Full Controller build | Passed after final drain guard | UI/server/CLI, including generated OpenAPI check: 155 operations/467 schemas. Existing Carbon Sass and bundle-size warnings remain. |
| Protocol and whitespace | Passed | Project protocol generator `--check`; `git diff --check`. |

Final permitted full Controller server rerun: **1392 passed, 385 skipped**,
107 files passed and 51 skipped. The extra two skipped cases are database-gated
Model draining tests, exercised by the separate 27-case PostgreSQL run above.
An intermediate sandbox-only run could not bind its gRPC/TLS sockets (`EPERM`);
the permitted whole-suite rerun passed without that error.

The first broad database run found one test querying an unregistered secondary
pool and a temporary-table fixture missing `allocation_context_id`. The fixes
registered an unrelated test group/pool and added the column only to session-local
tables. The corrected full run passed; public application tables were untouched.

The new monitor's rejected-refresh test initially returned its mock from a
`beforeEach` callback, registering it as a cleanup function that then rejected.
The hook now returns nothing. The application already hid cached current values
on failed refresh; the UI regression now verifies that behavior without a false
cleanup failure.

An old Redis port-forward produced one-second socket timeouts during the first
Runner run and a narrow retry. Admission/provisioning failed closed. A fresh
loopback-only forward to the same existing Redis service passed the complete
401-case set without changing production timeouts or resetting Redis authority.
Fixtures use unique policies and clean only their own test keys. This result
does not certify coordinator availability or HA behavior under resource pressure.

## What the new tests establish

Group Model PostgreSQL cases use synthetic inventory/keys and seeded matching
Rail-validation reports to exercise authorization, fingerprints and transaction
races. They do not call a live Provider or demonstrate detector quality. The
Runner integration set exercises real local Nemo pipelines with test fixtures;
no external LLM performance or Provider billing claim is made.

1. **Hierarchical starts:** two independent clients/pools consume group, tenant
   across pools and selected-pool histories atomically. Denials do not partially
   spend another budget. Missing, changed, expired/corrupt or backwards-clock
   state refuses admission/provisioning rather than recreating authority.
   Controller-authenticated group/epoch/generation is checked before and after
   queueing/Redis; caller headers cannot choose another budget.
2. **Actual monitoring:** limiter observations reach bounded diagnostic snapshots
   and current accepted control-session heartbeats. The admin API checks database
   pool/group membership and current source sessions before aggregation. A/B and
   C follow database placement. Missing/stale/offline/invalid sources, counter
   resets and empty/open-ended histogram intervals remain unavailable; they are
   not fabricated zeros. Group capacity sums process permit caps, rather than
   tenant caps that do not reserve slots.
3. **Group Model authority:** C's immutable validated grant can differ from A/B's
   platform configuration without globally activating C's draft. Cross-group
   Provider references fail; frozen credentials survive later source edits and
   rotation until explicit regrant. Blocking denies future active retrieval and
   never restores global defaults implicitly. Version/source races, outdated
   Rail evidence, private Models and unauthenticated/tenant API calls are denied.
4. **Activation consistency:** Endpoint/artifact allocation and group Models are
   projected in the same database transaction. Group ACK/NACK cannot finalize or
   fail a global activation. A global apply pins the revision and rechecks the
   source pool's current legacy policy under the finalization transaction. Pool
   policy changes serialize around that check/commit. A draining pool supplies
   neither new runtime configuration nor active credentials.
5. **Private rollout diagnostics:** snapshot rejection changes relevant Routers
   only in the current authenticated source group. Future/draft/other-group
   Routers remain unaffected. Same-group tenant status receives a generic error;
   bounded raw private details remain in platform-only audit.

## Deployment and full-support limits

The local single-node Docker container sampled **1.284 GiB / 1.925 GiB** and about
24% CPU during test investigation. Controller, two Runner pools, PostgreSQL,
Redis and the existing lab were running. This is a point observation, not peak
load/resource isolation evidence. Existing Pod restart counts were nonzero and
are not attributed to this source increment without termination-time evidence.

No new screenshots are presented as proof of deployed behavior. Existing October
screenshots depict older images. Public migrations, coordinated per-pool role
Secrets/flags/images, persistent progress volume lifecycle and actual A/B-shared
versus C-isolated smoke/peak screenshots remain a separate rollout milestone.
The bundled ephemeral Redis and current kindnet setup do not certify durable
distributed admission or enforcing CNI policies.

Full support still needs authoritative completeness/quiescence and retained-state
recovery, global evidence-ID availability protection, a production permanent-fence
adapter and safe move UI/API, distributed concurrency/reservations/admin budgets,
tenant Provider and Controller-side model workload controls, complete
authorization/lifecycle coverage and infrastructure/fault acceptance. These are
implementation/operational work within the existing tenant-group design; no new
baseline design decision is required by this increment.

Related details: [group rate admission](group-rate-admission.md), [measured
monitor](tenant-admission-monitor.md), [group Model grants](group-model-configurations.md),
[current done/TODO inventory](multi-tenancy-status.md).
