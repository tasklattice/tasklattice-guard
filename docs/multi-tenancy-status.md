# Full multi-tenancy implementation status

Status on 2 November 2026. “Implemented” means code exists with regression coverage; it does not mean deployed, production certified, or that every acceptance criterion is complete. Most enforcement modes are opt-in. The existing demo has not been upgraded with these changes. No commit or push was made.

## Implemented

| Area | What exists | Important limit |
| --- | --- | --- |
| Tenant groups | A/B can share a group and pool; C can use a separate group/pool. Controller filters desired runtime state by allocation. | A group is a shared Runner trust domain; group membership does not share private application resources. |
| Load lab | Existing A/B/C real-pipeline traffic generator, fake LLM, peak controls, charts and labeled quota simulation. | New enforcement/metrics are not yet integrated into the deployed demonstration. |
| Runner identity | Pool-bound control authentication; cross-pool registration/takeover denial; separate per-pool Controller-to-Runner HTTP credentials; strict role-token validation and Helm Secret references. | Static credentials require coordinated rotation/restart; workload identity lifecycle and mixed-version production rollout remain. |
| Application authorization | Targeted fixes for Policy/Guardrail/Router sharing, private source/artifact/report/export visibility, model/cost metadata, PAT owner/ban/expiry rechecks. | Full route/action/lifecycle matrix and request-wide atomic revocation are unfinished. |
| Historical evidence | Migrations preserve and quarantine ambiguous runtime/cost/routing/audit ownership instead of guessing a tenant. | Not applied to the existing demo; backup, old-writer shutdown, review and retention procedures remain. |
| Playground provenance | Persisted Controller-minted invocation identity and exact selected pool/group; scoped runtime/cost attribution. | Pool is the trust domain; evidence does not prove an uncompromised request executed. |
| Local Endpoint admission | Authenticated Controller-assigned tenant budgets, bounded queues, fair eligible dispatch, cancellation cleanup; LiteLLM callbacks, Scan and output WebSocket integration. | Per-process caps; no CPU/memory guarantee, reserved capacity or whole application pipeline permit. |
| Distributed admission starts | v1 atomic pool/tenant limits; v2 atomic group total, tenant across pools and selected pool across replicas. Controller-authenticated group/epoch checks; explicit provisioning and Helm validation. | Counts admission starts, not concurrent work. Requires complete participating-pool rollout, external Redis durability/ACL and coordinated recovery. |
| Admission monitoring | Real permit/queue/outcome/wait/held histograms in Prometheus and authenticated heartbeats; admin API and group/tenant charts in the load lab, with gaps for stale/missing data. | Bounded Controller-local diagnostic history; no HA merger. These are not tenant CPU/memory or whole application latency measurements. |
| Model validation credentials | Migration 0059: encrypted durable candidate snapshot, global 64 candidate cap, one-time pool/group/epoch/session binding, database expiry and revocation across Controllers. | Platform administrator validation remains an explicit short-lived exception; HTTP identity remains pool-level; delivered keys cannot be recalled. |
| Group runtime Model grants | Migration 0065, admin API and Tenant groups editor: explicit legacy/scoped/blocked policies, validated frozen runtime/credential snapshots, version/fingerprint checks, coherent distribution and guarded global activation. Draining denies future configuration/active credential retrieval. | Platform inventory grants, not tenant-owned Provider accounts or request/token/spend budgets. Provider rotation needs explicit revalidation/regrant and old-key revocation. |
| Endpoint evidence storage | 0061–0063: immutable bounded provenance, lifecycle/reference locks, retained-row/logical-byte budgets, conservative retention and cursor-bounded cleanup; authenticated runtime/cost/routing attribution. | Logical limits do not bound database disk/heap/TOAST/WAL. Referenced history can exhaust budgets; archive/reconciliation remains. |
| Rollout diagnostics | Snapshot NACK affects only the current source pool's group and relevant generations. Raw private error details remain platform-only. | Diagnostic status is not authoritative proof of fleet-wide freshness or completion. |
| Runner network policy option | Per-pool default-deny ingress/egress with explicit Controller/Redis/DNS/gateway/Provider exceptions and chart validation. | Render-tested only; not installed in the demo and requires an enforcing CNI. |

## Implemented internally; operational completion remains

| Area | Implemented | Remaining |
| --- | --- | --- |
| Serving leases | Durable grant history/epochs/current control sessions; exact challenged snapshot ACK; opt-in local monotonic deadline enforcement and cooperative HTTP/WebSocket/internal-work cancellation. | Coherent rollout/capability enforcement, uncooperative/frozen workload fencing, multi-node partition/failover validation. |
| Tenant/pool moves | 0058/0060: durable drain claims, database-maintained barrier revision, exact grant-history digest, fresh process-local full-horizon wait, injected permanent-fence verifier, atomic membership/epoch/generation/audit/outbox completion and read-only completion retry. | No production infrastructure fencer, startup/API/UI integration or full operational recovery/archive workflow. Absent verified permanent fencing, finalization refuses. No cancellation bypass. |
| Authenticated telemetry progress | 0064: current-session capability, bounded uploads, transactional mixed-evidence ingestion/cursor ACK, response-loss replay protection; bounded persistent single-writer Runner WAL and Helm per-replica claims. | Empty caught-up receipts are diagnostic only. Completeness/quiescence is not proven, so scoped freshness/deletion/rollout gates remain disabled. Lost/unmounted state needs external recovery gating. |

## TODO, in execution order

1. Add a stronger completeness/quiescence protocol before restoring scoped telemetry freshness-based deletion or rollout decisions. Resolve global event/decision-ID availability preemption with a compatible key/migration design; retain attribution quarantine on conflicts.
2. Integrate a real authoritative permanent-fence provider and expose safe move status/actions through Controller/admin UI; add recovery and retained-history archive procedures. A stopped/offline report is insufficient proof.
3. Add distributed concurrency with safe renewal/fencing, capacity reservations and group/global tenant budget administration. Group rate totals and actual charts exist; they do not establish these guarantees.
4. Extend Provider connection ownership, private tenant/group grants and request/token/spend budgets, including Controller-side authoring/chat and validation workloads; retain explicit platform resources. Existing group grants cover data-plane runtime configuration and retrieval only.
5. Add administrative lifecycle and operational recovery for scoped credentials, budgets and retained telemetry/context history.
6. Complete resource/action and lifecycle authorization coverage, revocation, tenant deletion/export, background-job ownership/deduplication and durable validation recovery. PostgreSQL RLS defense in depth is not implemented.
7. Complete infrastructure tiers: per-group Redis/ACL/key boundaries, database connection/query/storage controls, worker/node/cgroup quotas, network enforcement, backup/key/restore boundaries and dedicated deployment profiles where needed.
8. Stage coherent migrations, per-pool credentials and flags; run mixed-version/restart/rotation/partition/failover/freeze/stream tests on actual clusters within a measured memory budget.
9. Refresh A/B shared + C isolated real-pipeline demonstrations, screenshots and factual evidence documents after rollout. Only then assess full acceptance and any explicitly requested commit/push.

## Verification known at this checkpoint

- Full PostgreSQL run: **421 passed, 2 skipped**, 51 files passed and one skipped. A subsequent **27-case** focused Model/credential/lease set includes two new draining-denial cases and overlaps the full run. No application public rows were migrated; fixtures use isolated schemas/temporary tables.
- Integrated Runner/pipeline tests: **401 passed**, no skips, with real loopback Redis and streaming fixtures. An old port-forward produced socket timeouts and fail-closed responses; a fresh forward passed the integrated run. This is not Redis HA/failover certification.
- Helm focused contracts: **102 passed** for group/pool admission, bounded contexts, persistent progress, pool authentication and network policies. Render checks do not prove actual CNI/PVC enforcement.
- Admin UI regression set: **36 passed** across group policy editor, tenant groups, actual admission monitor and load lab.
- Final permitted Controller server run: **1392 passed, 385 skipped**, 107 files passed/51 skipped. Database-gated skips are covered separately where stated; they are not counted as PostgreSQL evidence. Exact verification is in the [2 November checkpoint](multi-tenancy-validation-2026-11-02.md).
- Full Controller/UI/CLI build and TypeScript passed; generated OpenAPI **155 operations/467 schemas** and control protocol check passed. Exact final rerun details are in the checkpoint; overlapping counts must not be summed.
- Live local inventory: kindnet/kube-proxy and only base Controller/Redis policies. TCP 8091 from the default Runner pool to group-demo succeeded, proving current network reachability; it does not prove application authorization failure.

See [implementation progress](multi-tenancy-implementation-progress.md), [completion plan](multi-tenancy-completion-plan.md), [group rate admission](group-rate-admission.md), [actual monitor](tenant-admission-monitor.md), [group Model grants](group-model-configurations.md), [progress](authenticated-telemetry-progress.md), [moves](tenant-group-move-protocol.md), and [network policies](runner-network-isolation.md) for details.
