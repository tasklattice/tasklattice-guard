# Multi-tenancy upstream integration — 3 November 2026

This integration merges upstream `main` at `5e39eaea` into
`feat/multi-tenant-v2`, starting from `e1c35dcc`. The nine upstream commits add
model concurrency, runtime HTTP evidence and diagnostics, classifier contract
updates, PostgreSQL CI coverage, and two control-plane CI shards. The prior PR
revision passed all six CI jobs before this integration.

## Integration decisions

- Preserve tenant ownership, read-only sharing, group allocation and serving
  leases alongside the upstream execution and observability changes.
- Require model ownership for the new concurrency update, including a tenant
  predicate on the database write. Shared and hidden foreign Models remain
  unwritable. Platform Providers remain managed by administrators.
- Freeze configured `maxConcurrency` in scoped group runtime grants. Existing
  snapshots missing the field retain the compatibility default of two; an
  explicit regrant captures a later configuration change.
- Keep upstream's Default ordinal-0 validation compiler selection together with
  current-session, pool identity and credential-lease checks.
- Retain tenant filtering and omit HTTP/model exchange evidence when runtime
  content permission is absent.
- Adapt PostgreSQL fixtures to `GUARD_TEST_POSTGRES_URL`, fully migrated isolated
  schemas, and real service construction where runtime caches are required.

## Migration ordering

Upstream owns `0000_current_schema`, `0001_endpoint_credential_required` and
`0002_model_concurrency`. Their SQL and journal timestamps remain unchanged.
The 17 tenant migrations move from `0002`–`0018` to `0003`–`0019` without SQL
changes. Their timestamps follow upstream's `0002` so the timestamp-based
migrator cannot skip tenant tables when upgrading an existing upstream database.

An added PostgreSQL test installs the upstream-only migration prefix, persists
a nondefault model concurrency value, then runs the real migrator against the
combined history and verifies tenant tables, preserved settings and an
idempotent restart. Fresh installs and populated-table ownership/quarantine
tests cover the rest of the sequence.

Earlier development revisions of this feature have a different journal. Their
databases require a fresh disposable database or a separately reviewed migration;
this integration does not claim an in-place upgrade from those development
revisions. Validation uses disposable loopback PostgreSQL and Redis services;
the existing demo deployment is unchanged.

## Validation

Focused counts overlap broader suites and must not be summed.

| Check | Result |
| --- | --- |
| Model service/domain/UI and HTTP routes | 130 passed across five files |
| Full Controller sweep with PostgreSQL, followed by affected-file reruns | 320 files / 3,117 tests passed in the sweep; its remaining 2 files / 7 timeout failures were repaired, and both files reran successfully (36 tests). All 322 files / 3,124 cases were exercised across those runs. |
| Model configuration and group grants with PostgreSQL | 42 passed across two files |
| Control channel, pool identity, admission codec and content projection | 68 passed across four files |
| Fresh/upstream/populated migration paths and runtime PostgreSQL regressions | 35 passed across five files |
| Database connection ownership after timeout-fixture repair | 11 passed |
| Publication lifecycle suite after integration-budget repair | 25 passed |
| Protocol, deployment and suite-boundary contracts | 282 passed, 7 optional/environment skips; protocol freshness and five Helm lint profiles passed |
| Controller / Runner communication | 16 passed, 6 optional/environment skips |
| Full data-plane suite with Redis | 1,502 passed, 3 optional collection skips |
| Full Python control-plane suite | 3,869 passed, 3 optional collection skips |
| Developer commands | 23 passed |
| Policy regression and default baseline | Passed; regression 1,195 passed, 18 not run |
| Typecheck and production build | UI, server and CLI passed |
| Generated OpenAPI | 159 operations and 472 schemas |

The first broad local Controller run overlapped other validation and used two
workers against Docker's one-CPU PostgreSQL service. It hit test/setup deadlines,
was interrupted, and is not counted as successful.
The affected routing cases passed when rerun with normal timeout settings.
Guardrail package setup and teardown now have explicit bounded integration hook
budgets, separate from the existing per-test budget. The Controller rerun uses
one worker and normal timeout settings. Its publication lifecycle suite exposed
two five-second test deadlines; that suite now has a 30-second per-test budget.
Five database client cases also exposed a fixture-wide 200ms connection timeout.
That override now applies only to the occupied-pool acquisition-timeout case,
after connection setup; the other cases retain the ordinary connection budget.
The complete Controller sweep finished with 3,117 passes and the seven timeout
failures above, with no skipped cases or other failures. All 11 database client
cases and all 25 publication cases pass after the repairs. The complete sweep
was not repeated after these test-only timeout changes; the affected-file
reruns verify them without repeating the other 320 passing files.

`git diff --check` and the staged equivalent pass. No credentials, local runtime
state, build output or dependency directories are included in the integration.
