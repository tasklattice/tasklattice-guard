# Local multi-tenancy testing and capacity

Environment checked on **2026-10-24**, Asia/Shanghai, on `feat/multi-tenant-v2` at `6044b72`. This report separates observed availability, actual test execution, and proposed configurations. See [isolation findings](multi-tenancy-isolation-audit-2026-10-24.md) and [project walkthrough](project-walkthrough.md).

**Later update:** after Docker was increased to 2 GiB, a reduced stack was deployed and live shared-Runner tenant checks passed. See the [2026-10-26 deployment report](multi-tenancy-deployment-2026-10-26.md). The measurements below remain the historical 2026-10-24 baseline.

## Availability at the start of the check

| Item | Observation |
| --- | --- |
| Host RAM / CPUs | 8 GiB RAM, 6 logical CPUs. |
| Swap | About 4.4 GiB used out of 6 GiB at inspection. This alone does not establish active thrashing; no host load test was performed. |
| Free workspace-volume space | Approximately 31 GiB. |
| Docker context | `desktop-linux`, Docker Desktop 29.9.2. |
| Docker VM capacity | 1 CPU and 1,014,501,376 bytes RAM, approximately 968 MiB / 0.945 GiB. |
| Running containers | None before the audit's disposable PostgreSQL was started. |
| Selected Kubernetes context | `kind-tasklattice`; API connection to its configured loopback port was refused. No healthy cluster was available through that context. The development scripts' default `orbstack` context was not in the available context list. |
| Controller / Runner / UI | No health response on loopback ports 8080 / 8091 / 8092. |
| Tooling | Node 24.18.1, project Python 3.13.14, Controller node_modules and Python virtual environment installed. |
| Database tools | No native `postgres`, `psql`, or `pg_isready` found on PATH. Cached `postgres:16-alpine` and `17-alpine` Docker images available. |
| Redis | No native Redis server found on PATH; cached Redis image not present in the inspected Docker context. |
| Existing local environment | `.env` exists, points Controller at localhost:5432, and binds HTTP to `0.0.0.0`. No connection credentials were printed or changed. |
| Multi-tenant test switches | Mock SSO flag and PostgreSQL/Redis integration-test variables were absent from the inspected `.env`. |

Therefore the development dependencies are available, but a complete live multi-tenancy application is **not already running or configured**. The selected cluster must not be treated as healthy simply because a kubeconfig context exists.

## The shipped local Kubernetes profile exceeds current Docker memory

These are configuration requests, not measured process usage. Merging [values.yaml](../charts/tali-guard/values.yaml) with [values-dev-uat.yaml](../charts/tali-guard/values-dev-uat.yaml) produces:

| Component | Replicas | Requested memory | Memory limit |
| --- | --- | --- | --- |
| Controller | 1 | 256 MiB | 1 GiB |
| Default Runner | 1 | 1 GiB | 4 GiB |
| PostgreSQL | 1 | 128 MiB | 512 MiB |
| Redis | 1 | 128 MiB | 512 MiB |
| Total | | **1,536 MiB / 1.5 GiB** | **6 GiB** across these Pods |

CPU requests total 675 millicores. Kubernetes and container-runtime overhead are additional. The Runner alone requests more memory than the current Docker VM exposes, before node reservation and the other workloads.

The local profile has one Runner, whereas base product values use two. Even the one-Runner profile cannot be scheduled as configured inside the current approximately 968 MiB VM. No cluster was created, no application deployment was started, and Docker Desktop's allocation was not changed during this check.

Reducing requests would alter scheduling only; it would not establish that NeMo can execute the required active versions within a smaller limit. Do not choose a Runner limit solely to make Helm scheduling pass.

## What can be checked cheaply

Three tenant accounts do **not** require three Runners. Tenant identity and ownership are logical boundaries. A resource-efficient progression is:

| Stage | Processes/services needed | Evidence it can provide |
| --- | --- | --- |
| Serial management tests | One Vitest worker and disposable PostgreSQL | Real auth/tenant rows, API access, sharing/revocation, migrations, composition, models, costs, UI cache behavior. |
| Serial Runner tests | One Python test process; Redis only for opt-in replica cases | Endpoint authentication, routing, pinned versions, artifact activation, transport. Mocked peers/providers must be identified. |
| Interactive logical demo | One Controller, built static UI, one shared Runner, PostgreSQL; Redis for faithful cross-request correlation | A/B/C browser workflows and live traffic on a small local Rule set. |
| Replica behavior | Controller, PostgreSQL, isolated Redis, two Runner processes | Real cross-replica call pinning, synchronization and rolling behavior. |
| Production identity/model tests | Configured IdP and compatible model services/credentials | Real onboarding, SSO, model semantics and dependency failure behavior. |
| Tenant compute isolation | Additional implementation is required | Fairness, quotas, reserved compute, tenant-specific pools are not current features to certify. |

Use one worker, avoid image builds and local model hosting, and run Controller and Python test phases sequentially. A 512 MiB Node heap cap does not cap the process RSS: native allocations and worker overhead are additional.

## Actual checks and the resource failure

The audit started only a disposable, loopback-published PostgreSQL 16 container from an already cached image. Its database contained synthetic test data. No existing application database, local `.env`, Docker settings, or Kubernetes release was changed.

1. **Initial focused run:** 13 files passed, 211 tests passed; one model suite could not initialize and 29 tests were skipped. Its fixture copies table structure using `LIKE public.<table>`, so a completely empty database did not satisfy that suite's baseline requirement. This was a test setup failure, not evidence that Model isolation failed.
2. The audit replayed the 50 migration files into the disposable database's public schema. Other tests continued to use randomized temporary schemas.
3. **Broader run with a 192 MiB PostgreSQL cap:** 23 files passed; the package suite failed, with 552 passing tests and 13 failures overall plus three unhandled connection errors. PostgreSQL logs showed a backend killed by signal 9 and recovery. Cgroup counters reported `oom=1`, `oom_kill=1`; Docker reported OOM. Data on the container's tmpfs occupied about 121 MiB, which also counts against its memory budget. This configuration was too small for the broader run.
4. Increasing the same memory-backed database to **384 MiB** did not produce a valid pass: it disappeared during package fixtures. The run ended with 449 passing tests, two failed assertions, 114 skipped tests and two unhandled errors (13 files passed, 11 failed at suite/assertion level). The database's auto-removal prevented a reliable postmortem of that second disappearance; its cause must not be asserted as a confirmed OOM or application defect.
5. The final setup used a fresh **disk-backed disposable database**, a **384 MiB** cap, and `maintenance_work_mem=16MB`, retaining diagnostics until explicit cleanup. This removes database files from tmpfs-backed RAM and avoids accumulated damaged test state. **All 565 tests passed across 24 files**, with no skipped tests. This included **146 tests across 11 real-PostgreSQL suites**. Test duration was 91.79 seconds (92.33 seconds including process overhead).

Measured final resource evidence:

| Measurement | Result |
| --- | --- |
| Node heap setting | 512 MiB; this is a heap setting, not an RSS limit. |
| Test command maximum resident set size | 761,135,104 bytes, approximately **726 MiB**. |
| PostgreSQL cgroup memory peak | 284,934,144 bytes, approximately **272 MiB**, within its 384 MiB cap. |
| PostgreSQL memory after tests | Approximately 84 MiB. |
| PostgreSQL OOM / OOM-kill events | **0 / 0** in the successful fresh container. |
| Disposable database disk footprint | Approximately 151 MiB before cleanup. |
| Cleanup | Test database container and its anonymous volume were removed after measurements. |

The test process ran natively on the host, while PostgreSQL ran in Docker. These measurements therefore do not imply that both fit inside the current Docker VM. They also do not measure a live Controller/Runner/UI stack. The failed small-memory attempts demonstrate that tmpfs, migration fixtures, and package operations must be budgeted alongside database process memory.

The final passing set covers real tenant accounts/session/PAT behavior, isolation and revocation, migration/backfill, shared model boundaries, routing composition, package transfers, cost/audit/security evidence, and UI identity-cache behavior. Its model/Runner test doubles do not establish external provider readiness or deployed multi-tenant execution. The temporary database was removed; the commands below recreate it when needed.

## Separate Runner verification

After removing the test database, the audit ran the existing Python checks serially:

```bash
.venv/bin/python -m pytest -q --maxfail=1 \
  tests/test_runner_api.py \
  tests/test_runner_artifact_store.py \
  tests/data_plane/test_composed_routing.py \
  tests/e2e/test_runner_control_channel.py
```

Result: **61 passed, 1 skipped**, in 2.11 seconds (2.53 seconds including process overhead). Maximum RSS was 410,140,672 bytes, approximately **391 MiB**. Six dependency deprecation warnings were emitted. The skipped test was the opt-in real-Redis assignment/outcome check: no isolated Redis URL was supplied.

These tests cover actual Endpoint normalization/authentication, routing and pinning, signed-artifact loading/activation, and loopback gRPC exchange with a mock Controller. They are not a complete deployed multi-tenant acceptance run. They neither establish external provider behavior nor demonstrate tenant fairness, dedicated pools, or real-Redis replica coordination.

Machine-readable records from this session are `/tmp/tasklattice-tenancy-audit-controller-disk-20261024.json` and `/tmp/tasklattice-tenancy-audit-runner-20261024.xml`; accompanying `.log` files contain timing/resource output. They are local temporary evidence and were not added to source control. Overall: **626 passing tests**, with the one real-Redis check explicitly unexecuted.

Raw audit logs and JSON reports were written under `/tmp`, rather than committed. A passing assertion that ordinary tenant users may mutate global Runner settings confirms current RBAC, not resource isolation.

## Reproduce the serial database setup

Run from the repository root. The following uses a cached image, loopback-only trust authentication, a disposable disk-backed database, and a shell cleanup trap. It is for disposable synthetic test data. The 384 MiB cap is the audit setup, not a general production recommendation. Its anonymous database volume is removed explicitly with the container.

```bash
set -eu
audit_container="tasklattice-tenant-check-$$"
docker run --detach --pull=never --name "$audit_container" \
  --cpus=0.5 --memory=384m --memory-swap=384m --shm-size=32m \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  -e POSTGRES_USER=guard_test -e POSTGRES_DB=guard_test \
  -p 127.0.0.1::5432 postgres:16-alpine \
  -c shared_buffers=24MB -c work_mem=1MB -c maintenance_work_mem=16MB \
  -c max_connections=30 -c max_wal_size=128MB -c min_wal_size=32MB
trap 'docker rm --force --volumes "$audit_container" >/dev/null' EXIT

ready=false
for attempt in $(seq 1 30); do
  if docker exec "$audit_container" pg_isready -U guard_test -d guard_test >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
test "$ready" = true
audit_address=$(docker port "$audit_container" 5432/tcp)
export GUARD_TEST_POSTGRES_URL="postgresql://guard_test@${audit_address}/guard_test"
export TEST_DATABASE_URL="$GUARD_TEST_POSTGRES_URL"
export GUARD_BOOTSTRAP_TEST_DATABASE_URL="$GUARD_TEST_POSTGRES_URL"
export NODE_OPTIONS=--max-old-space-size=512
cd controller
```

Some suites replay migrations into their own namespace, while other suites copy the public schema. Initialize that baseline once in this new disposable database:

```bash
node --input-type=module <<'JS'
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
const pool = new Pool({ connectionString: process.env.GUARD_TEST_POSTGRES_URL, max: 1 });
try {
  const journal = JSON.parse(readFileSync('server/db/migrations/meta/_journal.json', 'utf8'));
  for (const entry of journal.entries) {
    await pool.query(readFileSync(`server/db/migrations/${entry.tag}.sql`, 'utf8'));
  }
} finally {
  await pool.end();
}
JS
```

This is a once-only baseline for the fresh disposable database, not a replacement migration command for an existing environment.

The broader Controller command used for the audit is:

```bash
node node_modules/vitest/vitest.mjs run --environment jsdom \
  --maxWorkers=1 --no-file-parallelism \
  --testTimeout=15000 --hookTimeout=30000 --silent=passed-only \
  shared/rbac.test.ts \
  server/services/tenant-context.test.ts \
  server/http/tenant-sharing.test.ts \
  server/http/runner-management.test.ts \
  server/http/access-tokens.test.ts \
  server/services/control-plane-runner-removal.test.ts \
  server/http/multi-tenant.postgres.test.ts \
  server/services/tenant-isolation.postgres.test.ts \
  server/db/multi-tenant-migration.postgres.test.ts \
  server/services/access-tokens.postgres.test.ts \
  server/model-config/model-configuration.postgres.test.ts \
  server/services/guardrail-operational-data.postgres.test.ts \
  server/services/traffic-routing.postgres.test.ts \
  server/services/guardrail-packages.postgres.test.ts \
  server/services/model-pricing.postgres.test.ts \
  server/services/audit-events.postgres.test.ts \
  server/services/security-events.postgres.test.ts \
  server/http/product-authorization.test.ts \
  server/mock-sso.test.ts \
  src/lib/auth.test.tsx \
  src/components/control-plane-sidebar.test.tsx \
  src/routes/sharing.test.tsx \
  src/routes/mock-sso.test.tsx \
  src/components/runner-capacity.test.tsx
```

Keep database variables set; otherwise optional PostgreSQL suites can skip. Use a dedicated test database even though many suites create temporary schemas. Some tests depend on or copy public structures.

## Remaining interactive setup

For a small browser demo, use a disposable migrated database and override environment variables for that process. Mock SSO requires a loopback, non-production Controller; the inspected `.env` binds `0.0.0.0`, so merely enabling the flag is insufficient.

```bash
CONTROLLER_HTTP_HOST=127.0.0.1 \
CONTROLLER_MOCK_SSO_ENABLED=true \
CONTROLLER_DATABASE_URL="$GUARD_TEST_POSTGRES_URL" \
npm run dev
```

This command is a proposed setup step; the audit did not start a persistent Controller. Run it only while the disposable database exists, after arranging the normal local keys/tokens. The fixed chooser provisions tenantA/B/C user identities and disabled demo Endpoints. Those inventory examples do not create live traffic or a dedicated Runner per tenant.

For the demo, build/serve the static UI instead of keeping Vite plus multiple builds running. Add one source Runner with low per-version concurrency, a small active local-only Guardrail set, and the matching control/signing configuration. Use an isolated Redis instance for faithful call correlation and replica tests. Load-test and measure each addition; no complete live-stack memory minimum was measured here.

A remote test environment is more suitable for production identity/provider validation, two-plus Runner replicas, Kubernetes rollout tests, and saturation benchmarks. Full feature readiness cannot be inferred from the serial management tests or from the resource requests in Helm.
