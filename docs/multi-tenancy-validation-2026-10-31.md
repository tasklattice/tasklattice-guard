# Multi-tenancy implementation validation — 31 October 2026

This records a verified local working-tree checkpoint. It is not a deployed release or proof of complete multi-tenancy. Later source edits invalidate the checkpoint for those files; the [implementation progress log](multi-tenancy-implementation-progress.md) records subsequent work. Changes remain uncommitted on `feat/multi-tenant-v2`.

## Independently completed checks

| Check | Result | Scope and limits |
| --- | --- | --- |
| Full Controller server Vitest run | 1319 passed; 266 skipped; 101 files passed and 41 skipped | Loopback permissions enabled. PostgreSQL-gated suites were skipped and tested separately below. |
| PostgreSQL integration run | 102 passed across 18 files | Disposable schemas in the existing local PostgreSQL service; one worker, 30-second test/hook timeout. Includes migrations, current Runner sessions and grants, reassignment refusal, scoped telemetry, source/sharing boundaries, costs and pool credential allocation. |
| Combined Python/Helm run | 142 passed | Runner lease consumer/primitive, synchronization, local admission primitive, control/model clients, Artifact store, API/Playground and Helm secret references. Three upstream deprecation warnings. |
| Generated control protocol | Passed | `npm run proto:check`; no hand edits to generated bindings. |
| Full Controller build | Passed | App/server/CLI compilation and generated OpenAPI freshness check; 152 operations and 458 schemas. Existing Sass/bundle warnings remain. |
| Tracked whitespace/conflict check | Passed | `git diff --check`; this does not inspect ignored local state or prove security. |

## Reproduction

Run from `controller/` for Vitest and builds. Keep database credentials in the existing ignored local configuration and do not print them. Both `GUARD_TEST_POSTGRES_URL` and `TEST_DATABASE_URL` are needed because the suites use different variable names. PostgreSQL tests create and remove their own schemas; do not substitute a destructive shared-schema test setup.

```sh
npx vitest run server --environment node --maxWorkers=1 --testTimeout=30000 --hookTimeout=30000
npm run build
```

The separate PostgreSQL run selected these files:

```text
server/control-channel/lease-grant.postgres.test.ts
server/db/multi-tenant-migration.postgres.test.ts
server/http/model-credential-pool-allocation.postgres.test.ts
server/http/scoped-telemetry.postgres.test.ts
server/services/runner-control-sessions.postgres.test.ts
server/services/runner-lease-ledger.postgres.test.ts
server/services/guardrail-copy-source-boundary.postgres.test.ts
server/services/guardrail-policy-visibility.postgres.test.ts
server/services/router-sharing-boundary.postgres.test.ts
server/services/tenant-attribution.postgres.test.ts
server/services/tenant-isolation.postgres.test.ts
server/services/tenant-groups.postgres.test.ts
server/services/tenant-group-routing.postgres.test.ts
server/services/deletion-impact-groups.postgres.test.ts
server/services/model-pricing.postgres.test.ts
server/services/policy-ownership-boundary.postgres.test.ts
server/services/audit-attribution.postgres.test.ts
server/services/runtime-event-write.postgres.test.ts
```

From the repository root:

```sh
npm run proto:check
.venv/bin/python -m pytest -q \
  tests/data_plane/test_runner_lease_enforcement.py \
  tests/data_plane/test_serving_lease.py \
  tests/data_plane/test_runner_group_synchronization.py \
  tests/data_plane/test_tenant_admission.py \
  tests/test_runner_control_client.py tests/test_runner_model_config.py \
  tests/test_runner_artifact_store.py tests/test_runner_api.py \
  tests/data_plane/test_playground_path_testing.py \
  tests/contract/test_helm_pool_authentication.py
git diff --check
```

## Claims this checkpoint does not establish

- No current demo workload was migrated or redeployed, so these results are not live browser or cluster evidence. Earlier screenshots document an older deployment and cannot prove these new changes.
- Experimental Controller grants and Runner lease consumption are disabled by default. Cooperative cancellation and per-send checks do not stop synchronous/uncooperative external side effects or a frozen VM. Clock/failover bounds and external fencing remain necessary for stronger guarantees.
- Non-noop Tenant/pool reassignment is conservatively refused when experimental grants are enabled or affected source pools retain grant history. There is no completed lease-aware drain/epoch move/recovery workflow.
- Scoped telemetry attributes supported Playground evidence through recorded pool provenance but quarantines Endpoint/routing evidence and suppresses unauthenticated watermarks. It is an intentionally degraded mode.
- The admission primitive was not connected to production Endpoint requests at this checkpoint. Distributed quotas, capacity reservations and infrastructure CPU/memory isolation remain unfinished.
- Platform Model/Provider bindings and shared PostgreSQL/Redis remain common dependencies. Per-group Provider isolation, database RLS, complete lifecycle handling, request-wide atomic share revocation and multi-node fault validation are not proven.
- Historical attribution/copies with missing original ownership cannot be reconstructed by guessing. Quarantine and conservative source/export denial preserve access boundaries at the cost of unavailable history/content; documented migrations require stopping old Controller writers.
