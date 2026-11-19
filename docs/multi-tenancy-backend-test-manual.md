# Multi-tenancy backend verification and test manual

Audit date: **2026-11-08 (Asia/Shanghai)**. Source revision: **`2421055e`**.
Scope: TypeScript Controller backend, PostgreSQL ownership and authorization,
Controller/Runner boundaries, and the Runner controls that affect tenant isolation.

> **Historical audit.** The procedures, results and references to “current” below
> describe revision `2421055e`. Since that audit, the multi-Project HTTP fixture
> has added Profile and default pool seeding, the acceptance helper has adopted
> the `platform`, `scoped` and `blocked` Model modes, and the Controller requires
> both pool-scoped control and HTTP credential maps. For the current contract
> and deployment procedure, see the [multi-tenancy guide](multi-tenancy.md).

## 1. Readiness verdict

**Multi-tenancy is implemented, but this audit does not establish that everything
is up and running on the current source.** Core isolation checks pass, while the
existing local deployment is older than this checkout and reports degraded
capacity. The current multi-project HTTP integration suite also has a failing
setup hook. Do not use pod readiness or the standalone demo alone as release
acceptance for the Project-based implementation.

The product calls a tenant a **Project**. A User can belong to multiple Projects.
A Project group controls runtime Model scope; a Runner pool controls placement.
Neither is a substitute for Project resource ownership. `default` is a runtime
group/pool, not a default tenant. The current console has no tenant login selector,
mock SSO sign-in, or resource-sharing workflow.

### 1.1 Checks performed

| Check | Observed result | What it establishes |
| --- | --- | --- |
| Focused Controller tests: project context, product authorization, HTTP tokens, group HTTP APIs/routing, SSO claims, pool identities | **468 passed**, 7 files | Unit/HTTP boundary regressions; many dependencies use test doubles. |
| Focused PostgreSQL tests: project isolation/attribution/defaults/groups/routing, Dashboard isolation, Runner identity/rollout, tokens, SSO, multi-project HTTP | **81 passed; 1 suite failed during setup; 3 test bodies skipped**, 11 files | Real PostgreSQL service boundaries passed except the unexecuted multi-project HTTP cases. |
| Standalone acceptance-tool regressions | **26 passed** | The acceptance tool detects simulated isolation and evidence failures; this is not a live deployment run. |
| Standalone load-tool regressions | **24 passed** | External generator scheduling/configuration/measurement behavior; not backend capacity guarantees. |
| Controller typecheck and backend build | **Passed** | Application, server and CLI types; server compilation and OpenAPI generation. |
| Full Controller backend suite with PostgreSQL | **1,931 passed, 13 failed, 3 skipped; 9 failed / 163 passed files** | Includes tests outside multi-tenancy; failure details in section 11. |
| Isolated recheck of setup/connection/publication/persistence files | **39 passed; 1 setup suite failed, 3 bodies skipped** | Connection, publication and persistence checks pass with one worker/adjusted suite budgets; missing-Profile fixture failure reproduces. |
| Runner isolation/admission suites with Redis and loopback access | **213 passed, 0 skipped**, 11 files | Endpoint ownership, pool HTTP auth, local/Redis rates, synchronization, leases and admission evidence. |
| OpenAPI contract check | **28 passed** | Generated route/schema contract checks. |
| Live acceptance against a current-source deployment | **Not run** | No verified current-source Controller/Runner deployment with configured Project fixtures was available. |

Final audit results are recorded in section 11. Counts from focused and broad
runs overlap; do not add them to calculate a unique test total.

Initial sandboxed attempts could not bind loopback sockets; one Node run also
aborted with an internal callback assertion. Socket-dependent checks were rerun
with local network access. Treat the completed reruns as the test evidence.

### 1.2 Existing local runtime observed

Read-only inspection found the running Docker container
`guard-tenants-control-plane` and Kubernetes namespace `mt-demo`.

| Observation | Result |
| --- | --- |
| Host kubeconfig current context | `kind-tasklattice`; its API address `127.0.0.1:53774` refused connections. |
| Running local control-plane Docker mapping | `127.0.0.1:51058` → container `6443`; inspection used `kubectl` inside this container without changing host kubeconfig. |
| Demo pods | Controller, two Runners, PostgreSQL, Redis, three gateways, fake LLM and tenant lab were each `1/1 Running`. |
| Controller image | `ghcr.io/tasklattice/tali-guard-controller:external-llm-20261104-2`. |
| Runner images | `ghcr.io/tasklattice/tali-guard-runner:local-mt-20261104`. |
| Controller `/health/live`, `/health/ready` | HTTP 200; ready at desired generation 13. |
| Both Runner services `/health/ready` | HTTP 200; connected and synchronized at generation 13, one active/prewarmed version each. |
| Controller `/api/v1/system/status` | HTTP 200 with **`status: degraded`**, reason `runner_capacity_below_desired`; **1 serving / 2 desired** in the default fleet. Control-plane/runtime Model summaries were `unconfigured`. |
| Current-source version/sign-in routes | Demo `/version` returned SPA HTML instead of version JSON; `/api/sign-in/options` returned 404. Both routes exist in this checkout. |

The response/schema differences and image tags establish a deployment/source
mismatch. The old deployment's health does not validate current Project/SSO APIs.
No deployment, membership, policy or allocation was changed during this audit.
No live gateway traffic was generated against the existing demo.

### 1.3 Findings requiring follow-up

1. **Deploy and accept the current revision in a fresh test environment.** The
   old runtime cannot validate the current API contract. The development baseline
   intentionally rejects old database migration histories; do not migrate the
   existing demo database in place as part of testing.
2. **Resolve the desired/serving capacity mismatch.** Readiness is not a fleet
   capacity guarantee. Confirm the intended replica count, deployment workload,
   registration and synchronization before sign-off.
3. **Repair the multi-project HTTP fixture.**
   [multi-project.postgres.test.ts](../controller/server/http/multi-project.postgres.test.ts#L43)
   replays SQL directly and seeds sample Projects, but does not seed the pinned
   Profiles before `service.initialize()` at line 77. The hook fails at
   [createGuardrailIn](../controller/server/services/control-plane.ts#L821):
   `The selected Profile version is unavailable. Reload the Profile before creating a Guardrail.`
   The normal startup path calls
   [runMigrations](../controller/server/db/migrate.ts#L12), which seeds/synchronizes
   Profiles before service initialization. This is evidence of a test-fixture
   defect, not evidence that production login or isolation fails. Its three HTTP
   cases remain unverified by that suite until the fixture is corrected.
4. **Exercise optional modes explicitly.** Pool authentication, scoped telemetry,
   local Project admission, Redis rate limits and experimental lease enforcement
   are separately configured. Passing their tests does not establish that a
   deployment enabled them.
5. **Align acceptance tooling with the current Model-policy contract.** The
   helper accepts `legacy/scoped/blocked`, but the backend returns
   `platform/scoped/blocked`. A controlled transport probe reproduced rejection
   of a valid default-group `platform` response. See section 7.2.
6. **Triage the broader regression failures.** Catalog/preset assertions, Default
   suite counts and several database/report timing checks fail. They do not by
   themselves demonstrate a cross-Project leak, but they prevent a clean
   backend release verdict. See section 11 for every failed file.

## 2. Backend implementation map

Line anchors describe this audited revision. Function/table names are the durable
reference if later edits move the lines.

| Area | Implementation reference | Responsibility |
| --- | --- | --- |
| Startup | [index.ts](../controller/server/index.ts#L22), [migrate.ts](../controller/server/db/migrate.ts#L12), [seed-profiles.ts](../controller/server/db/seed-profiles.ts) | Migrate/seed first, initialize platform and Project defaults, then serve. |
| Identity and membership schema | [schema.ts](../controller/server/db/schema.ts#L54): `projectGroups`, `projects`, `user`, `session`, `personalAccessTokens`, `projectMembers` | Membership separates humans from Project ownership; session stores active Project; PAT stores fixed Project. |
| Resource/pool schema | [schema.ts](../controller/server/db/schema.ts#L183): `runnerPools`; `guardrails`, `trafficRouters`, `endpoints`, `runtimeEvents`, `auditEvents` | Foreign keys and ownership columns; one dedicated pool per Project. |
| Authority scopes | [project-context.ts](../controller/server/services/project-context.ts#L26): `runWithProjectContext`, `runWithProjectReadContext`, `runWithUserContext` | AsyncLocalStorage carries platform, Project or personal-account authority. Missing context is reserved for trusted internal work. |
| Resource boundary | [project-context.ts](../controller/server/services/project-context.ts#L122): `resourceReadPredicate`, `resourceWritePredicate`, `policyOwnershipPredicate`, access assertions | Owner-scoped reads/writes; rejects conflicting Policy owners across representations. Platform Models are a deliberate read exception. |
| HTTP authority | [app.ts](../controller/server/http/app.ts#L1567): `authentication`, `runAsActor` | Current database session/role, membership checks, stale selection rejection, PAT permissions, admin read selection. |
| Route allowlist/RBAC | [token-permissions.ts](../controller/server/http/token-permissions.ts), [rbac.ts](../controller/shared/rbac.ts) | Unclassified management routes deny access; account and token grants both apply. |
| Projects | [projects.ts](../controller/server/services/projects.ts#L32): `ProjectService` | Create with defaults, directory paging, membership, selection, access initialization and recovery. |
| Names | [runner-naming.ts](../controller/shared/runner-naming.ts), [projects.ts schemas](../controller/shared/projects.ts) | Canonical immutable Project name/ID and dedicated pool ID; Runner instance naming. |
| Tokens | [access-tokens.ts](../controller/server/services/access-tokens.ts#L17), [token schemas](../controller/shared/access-tokens.ts) | One-time secret, SHA-256 hash storage, module/role/membership/expiry enforcement. |
| Human authentication | [auth.ts](../controller/server/auth.ts#L21) | Better Auth username/password, session lifecycle, disabled signup/linking paths, protected role/project fields. |
| SSO | [sso.ts](../controller/server/sso.ts#L9), [sso-memberships.ts](../controller/server/services/sso-memberships.ts) | OIDC verification and exact Relay Group Paths; membership replacement and bounded refresh. |
| Group/pool administration | [project-groups.ts](../controller/server/services/project-groups.ts#L50), [request schemas](../controller/shared/project-groups.ts) | Allocation transactions, expected-state conflicts, offline checks, connectivity, generation/outbox/audit. |
| Runtime placement | [runner-allocation.ts](../controller/server/services/runner-allocation.ts), [project-group-routing.ts](../controller/server/services/project-group-routing.ts) | Dedicated Project pool takes precedence; default serves eligible Projects without dedicated capacity. |
| Desired state and registration | [control-plane.ts](../controller/server/services/control-plane.ts#L2257): `registerRunner`, `desiredStateForPool`; [control-server.ts](../controller/server/control-channel/control-server.ts) | Pool identity, resource/credential/artifact projection, compiler dispatch, ACK/rollout. |
| Runner authentication | [runner-authentication.ts](../controller/server/control-channel/runner-authentication.ts), [config.ts](../controller/server/config.ts#L130) | Pool-bound control credentials and distinct optional Controller-to-Runner HTTP credentials. |
| Models and secrets | [group-runtime.ts](../controller/server/model-config/group-runtime.ts#L42), [service.ts](../controller/server/model-config/service.ts), [group schema](../controller/shared/group-model-configuration.ts) | Platform inheritance only for default group; explicit scoped grants, blocked mode, frozen credential snapshots and resolution. |
| Policies/Guardrails/reports/packages | [policy-resources.ts](../controller/server/services/policy-resources.ts), [control-plane.ts](../controller/server/services/control-plane.ts#L668), [guardrail-packages.ts](../controller/server/services/guardrail-packages.ts), [testing-reports.ts](../controller/server/services/testing-reports.ts) | Root and child ownership, version/test/evidence/export/import boundaries. |
| Router composition | [traffic-routing.ts](../controller/server/services/traffic-routing.ts), [routing schemas](../controller/shared/traffic-routing.ts) | Endpoint/Guardrail ownership, immutable publication, pool-specific distribution and diagnostics. |
| Telemetry ingestion | [app.ts](../controller/server/http/app.ts#L1410), [runtime-event-write.ts](../controller/server/services/runtime-event-write.ts), [project-context.ts](../controller/server/services/project-context.ts#L69) | Authenticated pool plus Controller-issued context derives owner; conflicting/unknown provenance is quarantined with null ownership. |
| Telemetry reads/costs | [runtime-metrics.ts](../controller/server/services/runtime-metrics.ts), [security-events.ts](../controller/server/services/security-events.ts#L19), [model-pricing.ts](../controller/server/services/model-pricing.ts), [audit-events.ts](../controller/server/services/audit-events.ts) | Project-scoped events, findings, counters, cost and audit filtering. |
| Local admission/rate | [runner/project_admission.py](../runner/project_admission.py), [group_rate_admission.py](../runner/group_rate_admission.py), [distributed_rate_admission.py](../runner/distributed_rate_admission.py), [runner/config.py](../runner/config.py) | Optional owner-derived concurrency/queue limits and Redis admission rates. |
| Operator acceptance | [verify-local-multitenancy.mjs](../scripts/verify-local-multitenancy.mjs), [tool guide](tenant-load-lab.md) | Existing Project credentials/resources; management isolation plus gateway and paired Input/Output evidence. |

The SQL schema is shared. Isolation is enforced by application authority and
query predicates; do not assume a separate database/schema per Project or
database row-level security. Direct database access is outside management-API
tenant authorization. Service tests must establish an explicit Project context;
test-only `x-test-project`/`x-test-role` headers are not production authentication.

## 3. Test environment and fixture contract

Use a disposable environment built from the audited source. Requirements:

- Node 24+, installed root/Controller dependencies, project Python environment.
- Dedicated loopback PostgreSQL for database suites; disposable Redis for rate
  suites. Never point destructive test fixtures at a deployment database.
- For deployment tests: Controller, default shared Runner, a dedicated Runner,
  correctly configured internal URLs/public origins and pool credentials, and
  synchronized clocks. Registration does not deploy a Runner workload.
- Real Keycloak/OIDC configuration for SSO operator checks. Local signed OIDC
  fixtures test protocol behavior but do not validate your IdP deployment.
- A configured gateway with actual Guard Input and Output checks and a harmless
  completion model for end-to-end tests. No external paid Model calls are needed
  for the unit/database suites.

### 3.1 Required identities and resources

| Fixture | Required setup |
| --- | --- |
| `admin` | Current platform administrator browser session; optional administrator PAT with explicit module grants. |
| `alice` | Local `user`, member of `qa-mt-a` only initially. Add `qa-mt-b` during switching tests. |
| `bob` | Local `user`, member of `qa-mt-b`. |
| `carol` | Local `user`, member of `qa-mt-c`; dedicated Runner. |
| `unassigned` | Local `user` without memberships. |
| `auditor` | SSO `user` with read-only membership in `qa-mt-a`. |
| Projects A/B | `qa-mt-a`, `qa-mt-b`, initially default shared group/pool. |
| Project C | `qa-mt-c`; configure dedicated placement in a test-only offline window; record returned group ID. |
| Per-Project objects | Policy draft/version, Guardrail with ready immutable version, Router bound to that version, Endpoint and credential, test report/case evidence, uniquely identifiable runtime events. |
| Cross-Project canaries | Give private names/content unique A/B/C markers; record IDs independently so direct-ID attacks do not rely on discovery. |

Create local humans through platform user administration; do not insert password
hashes manually. For SSO, use verified Group Paths and matching
`externalDepartmentId`. Ordinary sign-in creates no Project or membership.
Built-in Policy catalogs/Profiles and platform Models can be intentionally shared;
use custom Project-owned objects for privacy assertions.

Create resources through the current API/workflow, preserving the actual JSON
responses. See [generated OpenAPI](../controller/openapi/controller.openapi.json)
and the deployment's `/api/docs` / `/api/openapi.json` for full request schemas.
Never guess a Guardrail draft or Router publication body from an old demo.

### 3.2 Shell setup and basic requests

Run repository commands from the repository root unless a command explicitly
changes directory. `curl`, `jq` and `openssl` are used below. Store cookies,
tokens and result bodies in ignored private directories:

```sh
umask 077
mkdir -p .local-secrets/mt-qa .tasklattice-recovery/mt-qa
export BASE='http://127.0.0.1:8080'
export PROJECT_A='qa-mt-a' PROJECT_B='qa-mt-b' PROJECT_C='qa-mt-c'
export PRIVATE_DIR="$PWD/.local-secrets/mt-qa"
export RESULT_DIR="$PWD/.tasklattice-recovery/mt-qa"
```

For the username/password login, read the test account password interactively:

```sh
read -r -s QA_PASSWORD
printf '\n'
jq -n --arg username 'alice' --arg password "$QA_PASSWORD" \
  '{username:$username,password:$password}' > "$PRIVATE_DIR/login.json"
curl -sS -c "$PRIVATE_DIR/alice.cookies" -o "$PRIVATE_DIR/alice-login.json" \
  -w 'HTTP %{http_code}\n' -X POST "$BASE/api/auth/sign-in/username" \
  -H "Origin: $BASE" -H 'Content-Type: application/json' \
  --data-binary @"$PRIVATE_DIR/login.json"
unset QA_PASSWORD
rm "$PRIVATE_DIR/login.json"
```

Expected login: HTTP 200 and a session cookie. Repeat for admin/Bob/Carol using
separate cookie jars. For HTTPS/path deployments, set `BASE` to the actual public
origin; the examples assume an origin without a trailing slash or path.

```sh
curl -sS -b "$PRIVATE_DIR/alice.cookies" "$BASE/api/v1/account/projects" | jq .
curl -sS -b "$PRIVATE_DIR/alice.cookies" -X PUT "$BASE/api/v1/account/project" \
  -H "Origin: $BASE" -H 'Content-Type: application/json' \
  -d '{"projectId":"qa-mt-a"}' | jq .
curl -sS -b "$PRIVATE_DIR/alice.cookies" "$BASE/api/v1/account/identity" | jq .
```

Expected selection: HTTP 200 and `projectId: qa-mt-a`. Verify identity reports
`role: user`, `authentication: session`, and the selected Project.

To provision A as admin after obtaining an administrator cookie jar:

```sh
curl -sS -b "$PRIVATE_DIR/admin.cookies" -X POST "$BASE/api/v1/projects" \
  -H "Origin: $BASE" -H 'Content-Type: application/json' \
  -d '{"name":"qa-mt-a"}' | jq .
# Set ALICE_ID from administrator user-directory results, not a username guess.
curl -sS -b "$PRIVATE_DIR/admin.cookies" -X PUT \
  "$BASE/api/v1/projects/$PROJECT_A/members/$ALICE_ID" -H "Origin: $BASE" \
  -o /dev/null -w 'HTTP %{http_code}\n'
```

Expected: Project creation 201; membership addition 204. Repeat for B/C and
their users. An already-existing Project returns 409; use a fresh test prefix
or deliberately reuse verified fixtures rather than treating that as success.

## 4. Automated verification procedure

The `GUARD_TEST_POSTGRES_URL` environment variable is essential. Without it,
PostgreSQL suites use `describe.skipIf(!url)` and a green run can omit the actual
ownership tests. The database helper accepts only loopback URLs and creates
random schemas, replays migrations and drops those schemas afterward.

### 4.1 Disposable dependencies

The following credentials are disposable test values, not deployment secrets.
Use unused host ports and unique container names if these are occupied.

```sh
docker run --detach --rm --name guard-mt-qa-postgres \
  --publish 127.0.0.1:55439:5432 \
  --env POSTGRES_USER=guard_test --env POSTGRES_PASSWORD=guard_test \
  --env POSTGRES_DB=guard_test postgres:17-alpine
docker exec guard-mt-qa-postgres pg_isready -U guard_test -d guard_test

docker run --detach --rm --name guard-mt-qa-redis \
  --publish 127.0.0.1:56389:6379 redis:7.4-alpine \
  redis-server --save '' --appendonly no
docker exec guard-mt-qa-redis redis-cli ping

export GUARD_TEST_POSTGRES_URL='postgresql://guard_test:guard_test@127.0.0.1:55439/guard_test'
export GUARD_TEST_REDIS_URL='redis://127.0.0.1:56389/0'
```

Wait for `pg_isready` success and Redis `PONG` before tests. Do not reuse any Redis
instance whose counters belong to application traffic.

### 4.2 Focused Controller checks

```sh
(
  cd controller
  ./node_modules/.bin/vitest run \
    server/services/project-context.test.ts \
    server/http/product-authorization.test.ts \
    server/http/access-tokens.test.ts \
    server/http/project-groups.test.ts \
    server/http/project-group-routing.test.ts \
    server/sso.test.ts \
    server/control-channel/pool-identity.test.ts

  ./node_modules/.bin/vitest run --maxWorkers=2 \
    server/http/multi-project.postgres.test.ts \
    server/services/project-isolation.postgres.test.ts \
    server/services/project-attribution.postgres.test.ts \
    server/services/project-defaults.postgres.test.ts \
    server/services/project-groups.postgres.test.ts \
    server/services/project-group-routing.postgres.test.ts \
    server/http/dashboard-tenant-isolation.postgres.test.ts \
    server/services/runner-project-identity.postgres.test.ts \
    server/services/runner-rollout-isolation.postgres.test.ts \
    server/services/access-tokens.postgres.test.ts \
    server/sso.postgres.test.ts
)
```

Record each command's exit status independently; the subshell is only for the
working directory. The second command currently reproduces the Profile fixture
failure described in section 1.3. Do not count its skipped test bodies as passes.

### 4.3 Full backend, contracts and build

```sh
(
  cd controller
  ./node_modules/.bin/vitest run server --maxWorkers=2
)
npm run openapi:check --prefix controller
npm run typecheck --prefix controller
npm run build:server --prefix controller
git diff --check
```

OpenAPI generation runs as part of the tooling. A current implementation should
not leave unexpected generated-contract changes. This manual does not change
any API. A browser/UI build is separate from the backend build.

### 4.4 Runner boundary and admission checks

```sh
.venv/bin/python -m pytest -q -rs \
  tests/data_plane/test_project_admission.py \
  tests/data_plane/test_project_admission_metrics.py \
  tests/data_plane/test_project_admission_snapshot.py \
  tests/data_plane/test_endpoint_project_admission.py \
  tests/data_plane/test_group_rate_admission.py \
  tests/data_plane/test_distributed_rate_admission.py \
  tests/data_plane/test_endpoint_access.py \
  tests/data_plane/test_controller_pool_http_auth.py \
  tests/data_plane/test_runner_group_synchronization.py \
  tests/data_plane/test_runner_lease_enforcement.py \
  tests/data_plane/test_serving_lease.py

node --test scripts/verify-local-multitenancy.test.mjs
node --test scripts/tenant-load-lab.test.mjs
```

Both loopback sockets and Redis are required for complete execution. Inspect
skip reasons; a missing Redis URL is not an accepted result for rate-limit
sign-off. Controller tests exercise service and HTTP boundaries; they do not
substitute for the live gateway procedure in section 8.

## 5. Manual tests: identity, Projects and credentials

For each case record date, source/image revision, credential type/role/Project,
HTTP status, redacted body, database observation when applicable, and pass/fail.
Use valid own-Project request bodies first, then substitute foreign IDs. A schema
error on an invalid body does not prove resource authorization.

### 5.1 Startup and Project lifecycle

| ID | Procedure | Expected result | Implementation / regression |
| --- | --- | --- | --- |
| BOOT-01 | Start Controller on an empty disposable DB; inspect migrations and pinned Profiles; call `/health/live`, `/health/ready`, `/version`. | JSON operational responses; readiness only after schema/service state exists; version identifies the build. | [startup](../controller/server/index.ts), [migration](../controller/server/db/migrate.ts), [readiness tests](../controller/server/db/readiness.postgres.test.ts). |
| BOOT-02 | Start against a database whose migration history predates `SCHEMA_BASELINE`, using a disposable copy. | Startup refuses the old baseline with an explicit fresh-database error. | [migration guard](../controller/server/db/migrate.ts#L12), [migration tests](../controller/server/db/migrate.postgres.test.ts). |
| PRJ-01 | Admin creates ` QA_MT_A `; try its normalized duplicate, `default`, a reserved path name and an overlong/invalid name. | Canonical valid name/ID; duplicate 409 `project_exists`; invalid/reserved schema input 400. No duplicate/default tenant. | [names](../controller/shared/runner-naming.ts), [create](../controller/server/services/projects.ts#L198), [identity tests](../controller/server/services/runner-project-identity.postgres.test.ts). |
| PRJ-02 | Create a new Project and inspect its default Guardrail/version plus provisioning marker; force provisioning failure in a fixture. | Project and its pinned default are atomic; failure leaves neither partially created Project nor audit/default state. | [defaults tests](../controller/server/services/project-defaults.postgres.test.ts), [initializeProject](../controller/server/services/control-plane.ts#L277). |
| PRJ-03 | Edit or delete a Project Default, then restart Controller twice/concurrently. | Exactly-once provisioning; edits/deletions preserved, no recreation or duplicate defaults. | [default regression](../controller/server/services/project-defaults.postgres.test.ts). |
| PRJ-04 | Sign in `unassigned`; call identity, account Projects, access status, resource list, token creation. | Account recovery available; no business resources; status `project_required`; business API 403 `project_required`; no automatic membership. | [authentication](../controller/server/http/app.ts#L1620), [Project access](../controller/server/services/projects.ts#L83). |
| PRJ-05 | Use an existing member Project with no effective runtime address; call project-access and a business API with a browser session. | Access state `runner_uninitialized`; business call 403 `project_not_initialized`. A configured URL alone is not a Runner health check. | [runnerInitialized](../controller/server/services/projects.ts#L70), [session gate](../controller/server/http/app.ts#L1636). |
| PRJ-06 | Admin adds/removes Alice; inspect membership directory, audit and active sessions. | Add/remove 204; repeated add harmless; removal clears matching active selections and denies the next request/token authentication. | [setMember](../controller/server/services/projects.ts#L287), [multi-project tests](../controller/server/http/multi-project.postgres.test.ts). |
| PRJ-07 | Query Project/user/member/pool directories with `limit=1`, `q` and `nextCursor`; include `%`, `_`, backslash; invalid limit/cursor input. | Paging/search stay bounded and correctly scoped; default page 25/max 100 for these directories; search metacharacters escaped; invalid input rejected. | [directory schema](../controller/shared/directory.ts), [directory tests](../controller/server/services/directories.postgres.test.ts). |

### 5.2 Session selection and account authority

| ID | Procedure | Expected result | Implementation / regression |
| --- | --- | --- | --- |
| AUTH-01 | Call protected resource APIs without credentials, with expired session, and with a malformed/invalid Bearer header alongside a valid cookie. | 401; explicit Authorization never falls back to the cookie. Account admin wrapper can return 403 for missing admin session. | [authentication](../controller/server/http/app.ts#L1595), [HTTP token tests](../controller/server/http/access-tokens.test.ts). |
| AUTH-02 | Alice selects non-member B; admin grants B; select again. | First 403; after membership, selection 200 and identity becomes B. | [select](../controller/server/services/projects.ts#L366), [multi-project switching test](../controller/server/http/multi-project.postgres.test.ts#L176). |
| AUTH-03 | After switching A→B, send a browser API write with `X-Project-ID: qa-mt-a`. | 409 `project_changed`; neither Project is mutated. Repeat read to verify same stale-page fence. | [session selection check](../controller/server/http/app.ts#L1625). |
| AUTH-04 | Send fake role/Project headers or profile fields, invoke disabled signup/mock-SSO paths, or access admin user APIs as a user. | No authority escalation or new unauthenticated account. Removed mock-SSO routes 404; protected admin APIs 403. | [product authorization](../controller/server/http/product-authorization.test.ts), [account authentication](../controller/server/http/account-authentication.test.ts). |
| AUTH-05 | Ban user, expire session or change its role while keeping the original cookie; repeat immediately. | Current DB state is applied on the next request; no cached former-user/platform authority. | [auth.ts](../controller/server/auth.ts), [product authorization](../controller/server/http/product-authorization.test.ts). |
| AUTH-06 | Use admin to read A Guardrails without selector, with invalid/missing Project, with `?projectId=A`, then with `X-Project-ID: A`; try business write. | Missing header 400 `project_required`; invalid header 400; nonexistent Project 404; query selector 400 `invalid_project_selector`; valid explicit read 200; business write 403. | [runAsActor](../controller/server/http/app.ts#L1567), [adminProjectScope](../controller/server/http/token-permissions.ts). |
| AUTH-07 | Read A's object using admin selection B; inspect platform identity. | Resource detail 404; admin `/account/identity` remains `projectId: null`, even during explicit Project reads. | [admin inspection context](../controller/server/services/project-context.ts#L34), [multi-project admin test](../controller/server/http/multi-project.postgres.test.ts#L129). |
| AUTH-08 | Use account/membership operations from an untrusted Origin or `Sec-Fetch-Site: cross-site`; try browser-only account APIs with a PAT. | Denied; browser-only APIs require a current session and trusted origin. | [browserSession/accountSession](../controller/server/http/app.ts#L417), [HTTP token tests](../controller/server/http/access-tokens.test.ts). |

Administrator example:

```sh
curl -sS -b "$PRIVATE_DIR/admin.cookies" "$BASE/api/v1/guardrails" \
  -o "$RESULT_DIR/admin-no-project.json" -w 'HTTP %{http_code}\n'
# Expected 400.
curl -sS -b "$PRIVATE_DIR/admin.cookies" "$BASE/api/v1/guardrails" \
  -H "X-Project-ID: $PROJECT_A" | jq .
# Expected 200, only A's business inventory.
```

### 5.3 Personal access tokens (PATs)

Issue an A token using Alice's A-selected session:

```sh
curl -sS -b "$PRIVATE_DIR/alice.cookies" -X POST \
  "$BASE/api/v1/account/access-tokens" -H "Origin: $BASE" \
  -H 'Content-Type: application/json' \
  -d '{"name":"multi-tenancy QA A","expiresInDays":7,"permissions":{"guardrails":"write","policies":"write","routers":"write","endpoints":"write","runtime":"read"}}' \
  -o "$PRIVATE_DIR/token-a.json" -w 'HTTP %{http_code}\n'
jq -r '.secret' "$PRIVATE_DIR/token-a.json" > "$PRIVATE_DIR/token-a.secret"
export TOKEN_A="$(cat "$PRIVATE_DIR/token-a.secret")"
curl -sS "$BASE/api/v1/account/identity" -H "Authorization: Bearer $TOKEN_A" | jq .
```

Expected 201 with `{token, secret}`; identity is `authentication: access_token`
and `projectId: qa-mt-a`. Keep the issued ID for revocation. The server returns
the secret once; token list responses must not include it.

| ID | Procedure | Expected result | Implementation / regression |
| --- | --- | --- | --- |
| PAT-01 | Issue read and write A tokens; inspect list/detail metadata and DB `token_hash`. | Only hash persisted, unique secret, safe prefix/metadata, fixed Project and expiry. | [token service](../controller/server/services/access-tokens.ts#L23), [Postgres tests](../controller/server/services/access-tokens.postgres.test.ts). |
| PAT-02 | Switch browser A→B; use old A PAT with no header and with header B. | PAT identity/resources remain A. A business PAT cannot switch Project using `X-Project-ID`; unlike a stale browser session, this is not the browser 409 flow. | [token authentication](../controller/server/http/app.ts#L1595), [switching regression](../controller/server/http/multi-project.postgres.test.ts#L176). |
| PAT-03 | Read-only token attempts write; omit required module; request unsupported module or expiry. | Read allowed only for granted module; write 403 `insufficient_token_permission`; invalid issuance schema 400. Expiries are 7/30/90/365 days. | [schemas](../controller/shared/access-tokens.ts), [route allowlist](../controller/server/http/token-permissions.ts). |
| PAT-04 | Remove membership, reduce write→read, ban owner, expire/revoke/tamper token or change user↔admin role. | Invalid/excessive old credential fails authentication (401); role transitions never promote an old Project token to platform authority. | [authenticate](../controller/server/services/access-tokens.ts#L67), [token Postgres tests](../controller/server/services/access-tokens.postgres.test.ts). |
| PAT-05 | Try issuing write token as read-only SSO member or platform grants as user; create 51st active token in a fixture. | 403 `project_read_only` or `forbidden`; limit 409 `token_limit`; rollback without issuing secret. | [create](../controller/server/services/access-tokens.ts#L23). |
| PAT-06 | Use another user's session to revoke token; revoke own token twice; use revoked secret. | Foreign token hidden with 404; own revoke 204/idempotent; secret then 401. | [revoke](../controller/server/services/access-tokens.ts#L54). |
| PAT-07 | Admin PAT with `projects:write` creates Project/manages local members; same PAT calls global users admin API or account token issuance. | Entity grant permits Project/member APIs; global `/api/auth/admin/*` and browser-only account management denied. Admin PAT cannot acquire business write authority. | [admin token regression](../controller/server/http/multi-project.postgres.test.ts#L129), [RBAC](../controller/shared/rbac.ts). |

The older access guide's blanket statement that PATs cannot manage membership
does not describe administrator entity tokens: the backend explicitly allows
admin tokens with the `projects` grant. Use the route allowlist and role matrix
as the implementation contract.

### 5.4 OIDC and membership synchronization

| ID | Procedure | Expected result | Implementation / regression |
| --- | --- | --- | --- |
| SSO-01 | Sign in with a valid verified email and exact `/tali/d/department-a/p/qa-mt-a/r/ROLE_PROJECT_ADMIN` path; Project has matching `externalDepartmentId`. | Identity keyed by issuer+subject; existing Project membership read/write, source `sso`; no separate tenant account. | [OIDC/claims](../controller/server/sso.ts), [real signed OIDC fixture tests](../controller/server/sso.postgres.test.ts). |
| SSO-02 | Test project roles `ROLE_AGENT_DEVELOPER`, `ROLE_AUDITOR`, `ROLE_REVIEWER`, `ROLE_USER`; attempt a valid own-Project write and read. | Developer/admin roles write; auditor/reviewer/user roles read-only and writes 403 `project_read_only`. | [relayEntitlements](../controller/server/sso.ts#L53), [membership sync](../controller/server/services/sso-memberships.ts). |
| SSO-03 | Test unknown/prefix/department-admin paths, mismatched department and missing Project. | No implicit grants or Project creation; missing mapped Projects appear through access recovery (`project_missing`) without resource access. | [claims parsing](../controller/server/sso.ts#L53), [accessStatus](../controller/server/services/projects.ts#L83). |
| SSO-04 | Add/remove exact `/tali/r/ROLE_PLATFORM_ADMIN`, sign in again; try near-match path. | Only exact path grants platform role; next verified login revokes removed authority. | [SSO integration tests](../controller/server/sso.postgres.test.ts). |
| SSO-05 | Remove/reduce project paths; sign in again; reuse old browser cookie and write PAT. | Memberships rebuilt from verified grants; removed grants/read reductions take effect; old excessive PAT denied. | [synchronizeSsoMemberships](../controller/server/services/sso-memberships.ts). |
| SSO-06 | Initialize a missing Project, call access refresh within one hour, then test expired verification. | Fresh verified grants can be reapplied without new rights; expired refresh 401 `reauthentication_required`; SSO PAT requires sign-in within past hour. | [refreshSsoMemberships](../controller/server/services/sso-memberships.ts), [PAT freshness](../controller/server/services/access-tokens.ts#L83). |
| SSO-07 | Admin locally adds/removes an SSO membership or edits its role; test invalid signature/issuer/audience/expiry/nonce and same-email different subject. | Local entitlement edits rejected; membership API 403 `sso_managed_membership`; invalid identity rejected, no email-based account merge. | [auth hooks](../controller/server/auth.ts), [SSO tests](../controller/server/sso.test.ts), [SSO Postgres](../controller/server/sso.postgres.test.ts). |

Keycloak change push, SAML, global IdP logout and immediate IdP revocation are not
implemented. Membership synchronization happens on sign-in; for urgent denial,
ban the Guard account. Record this behavior rather than expecting real-time
Keycloak updates from an already-issued token.

## 6. Manual tests: resources and data privacy

### 6.1 Direct-ID and mutation matrix

For every row below, first make a successful A-owned request with sufficient
permission, then repeat as B/C using the identical A ID. Reverse A/B to detect
one-sided fixtures. Expected foreign root/detail/export responses are **404
`not_found`**. A foreign reference within an otherwise owned Router/draft may
instead return **422 `validation_failed`**; verify no foreign content or mutation.
Permission denial can occur earlier (403) for a caller lacking the module.

| ID | Surface to exercise | Required assertion | Implementation / regression |
| --- | --- | --- | --- |
| ISO-01 | `GET /guardrails`, `/routers`, `/endpoints`, `/policies`, then each `/:id`. | Lists omit private canaries; foreign detail 404. Shared catalog entries are not Project leaks. | [read predicates](../controller/server/services/project-context.ts#L122), [multi-project HTTP](../controller/server/http/multi-project.postgres.test.ts). |
| ISO-02 | PATCH Guardrail/Endpoint, PUT Router draft, PUT Policy definition, DELETE roots. | B cannot write/delete A; revision/state/generation/audit attributable to A remain unchanged. | [write assertions](../controller/server/services/project-context.ts#L159), [control-plane](../controller/server/services/control-plane.ts), [routing](../controller/server/services/traffic-routing.ts). |
| ISO-03 | Guardrail `/:id/versions/:version/test-suite`, test cases, test-runs list/detail/cases/evidence/cancel/delete. | Parent, immutable version, report, case payloads and evidence all enforce ownership, including guessed child IDs. | [authorizeReportRead](../controller/server/services/control-plane.ts#L1235), [evidence regression](../controller/server/services/guardrail-evidence-ownership.postgres.test.ts). |
| ISO-04 | Policy definition, published version tests/readiness, draft/version reports and evidence. | Child reads/writes do not bypass owning Policy root; shipped definitions remain accessible as catalog content. | [Policy service](../controller/server/services/policy-resources.ts), [Policy boundary tests](../controller/server/services/policy-ownership-boundary.postgres.test.ts). |
| ISO-05 | A Guardrail package export; A upload preview/import ID requested by B; environment check/duplicate A as B. | No package bytes, preview metadata or copying of inaccessible roots; package IDs are Project-scoped. | [package service](../controller/server/services/guardrail-packages.ts), [isolation tests](../controller/server/services/project-isolation.postgres.test.ts). |
| ISO-06 | Save a Policy using B's imported Policy ID from A; create conflicting root owners across `policy_resource`, `policy_record`, `policy_imported_version` in isolated DB. | Cannot claim another owner's ID; ambiguous identity denied to all Projects for root/version/report/read/write. No revision/history changes. | [policyOwnershipPredicate](../controller/server/services/project-context.ts#L139), [isolation](../controller/server/services/project-isolation.postgres.test.ts), [Policy boundary](../controller/server/services/policy-ownership-boundary.postgres.test.ts). |
| ISO-07 | A Router binds B Endpoint or targets B Guardrail/version; replace valid A reference with B in create/save/publication. | Foreign reference rejected, existing bindings/draft/active revision unchanged. | [Router ownership](../controller/server/services/traffic-routing.ts), [routing Postgres](../controller/server/services/traffic-routing.postgres.test.ts). |
| ISO-08 | Try client-supplied `projectId`/`project_id` in create/update bodies and forged Project request headers. | Owner comes from authenticated authority, never the body; strict schemas reject unknown fields where applicable. For permissive schemas, ignored fields must not transfer ownership. | [projectOwnerForCreate](../controller/server/services/project-context.ts#L61), [HTTP schemas](../controller/server/http/app.ts). |
| ISO-09 | Query deletion impact and rollout errors for own resource while shared Runner errors/reference graphs mention another Project. | Visible counts/names/diagnostics do not reveal foreign identities/content; conservative deletion safety retained. Raw rollout diagnostics remain platform audit only. | [deletion tests](../controller/server/services/deletion-impact-groups.postgres.test.ts), [rollout isolation](../controller/server/services/runner-rollout-isolation.postgres.test.ts). |

Example with independently recorded A-owned IDs:

```sh
# Set TOKEN_B from Bob's issued token and GUARDRAIL_A_ID from A's creation response.
curl -sS "$BASE/api/v1/guardrails/$GUARDRAIL_A_ID" \
  -H "Authorization: Bearer $TOKEN_A" \
  -o "$RESULT_DIR/a-own-guardrail.json" -w 'HTTP %{http_code}\n'
curl -sS "$BASE/api/v1/guardrails/$GUARDRAIL_A_ID" \
  -H "Authorization: Bearer $TOKEN_B" \
  -o "$RESULT_DIR/b-foreign-guardrail.json" -w 'HTTP %{http_code}\n'
# Expected 200, then 404; repeat for Router, Endpoint, Policy and child evidence.
```

### 6.2 Telemetry, provenance, findings and costs

Send harmless real requests through each test gateway before checking reads.
For forged-provenance cases, use the isolated PostgreSQL suites or a dedicated
test Runner, not production telemetry injection.

| ID | Procedure | Expected result | Implementation / regression |
| --- | --- | --- | --- |
| TEL-01 | A/B use the same default Runner; query `/telemetry/events`, `/telemetry/metrics?window=24h`, `/telemetry/endpoint-activity`; request foreign event ID. | Each sees only its Project's records/counters/activity; foreign event detail 404. One shared uploader does not combine tenant visibility. | [Dashboard regression](../controller/server/http/dashboard-tenant-isolation.postgres.test.ts), [metrics](../controller/server/services/runtime-metrics.ts). |
| TEL-02 | Query `/telemetry/security-events` with shared Guardrail filter and paginated findings; reuse A cursor as B. | Results scoped by invoking Project; foreign cursor cannot carry A data into B and is rejected when invalid for B. | [security service](../controller/server/services/security-events.ts), [isolation test](../controller/server/services/project-isolation.postgres.test.ts#L52). |
| TEL-03 | Inspect `/guardrails/:id/usage-costs?window=7d&source=all` after distinct A/B Model-call counts. | Only own Guardrail accessible; calls/costs attributed to caller Project. Unknown price is not fabricated; foreign Guardrail 404. | [Dashboard cost checks](../controller/server/http/dashboard-tenant-isolation.postgres.test.ts), [pricing](../controller/server/services/model-pricing.ts). |
| TEL-04 | Upload valid events using wrong/missing Runner credential; try PAT/Endpoint credential at internal telemetry API. | 401 `runner_unauthenticated`; no records accepted. When scoped mode is enabled, legacy credential is rejected. | [internal upload](../controller/server/http/app.ts#L1410), [scoped telemetry tests](../controller/server/http/scoped-telemetry.postgres.test.ts). |
| TEL-05 | Submit events with forged metadata Project, unknown Endpoint, conflicting Router/Endpoint, invalid/expired allocation context or wrong authenticated pool. | Client Project fields are ignored; provenance derives from trusted Endpoint/allocation context or Controller invocation. Unknown/conflicting provenance is quarantined (`project_id IS NULL`), never guessed from Guardrail or Runner alone. | [runtimeEventProjectId](../controller/server/services/project-context.ts#L69), [attribution tests](../controller/server/services/project-attribution.postgres.test.ts), [scoped telemetry](../controller/server/http/scoped-telemetry.postgres.test.ts). |
| TEL-06 | Playground A invocation; delayed replay inside valid lifetime; expired/forged call ID, foreign pool/Guardrail or Endpoint mixed with Playground. | Valid call stays A; conflicts/expired identity quarantined; client cannot choose another tenant by copying an ID. | [invocation attribution](../controller/server/services/project-attribution.postgres.test.ts), [endpoint contexts](../controller/server/http/endpoint-context-telemetry.postgres.test.ts). |
| TEL-07 | Replay/enrich a valid event from a different pool, or poison a routing completion from another Project. | Unauthorized replay cannot enrich the valid event or change its owner; quarantined route data cannot become trusted completion evidence. | [scoped replay tests](../controller/server/http/scoped-telemetry.postgres.test.ts#L72), [routing contexts](../controller/server/http/routing-context-telemetry.postgres.test.ts). |
| TEL-08 | Read audit as user, then as admin; inspect Project/member/token/SSO events and raw Runner errors. | Business users lack the audit module; platform admin can read platform audit with explicit grants/session. Project filtering and attribution retain private/platform separation at the service layer. | [RBAC](../controller/shared/rbac.ts), [audit attribution](../controller/server/services/audit-attribution.postgres.test.ts), [audit service](../controller/server/services/audit-events.ts). |
| TEL-09 | Oversized batch/body, excess Model-call evidence, stalled/parallel uploads from one pool. | Bounded admission/body/work budgets; rejected uploads do not exhaust every peer pool or persist partial unauthorized data. Check HTTP budget errors and Retry-After. | [upload budget](../controller/server/http/telemetry-upload-budget.ts), [upload tests](../controller/server/http/telemetry-upload-http.test.ts). |

Useful read commands:

```sh
curl -sS "$BASE/api/v1/telemetry/events?limit=100" \
  -H "Authorization: Bearer $TOKEN_A" | jq .
curl -sS "$BASE/api/v1/telemetry/metrics?window=24h" \
  -H "Authorization: Bearer $TOKEN_A" | jq .
curl -sS "$BASE/api/v1/telemetry/endpoint-activity" \
  -H "Authorization: Bearer $TOKEN_A" | jq .
```

Null ownership quarantines evidence from Project views; it is not a public or
shared tenant. An HTTP 202 upload means the batch was accepted, not that every
event received a trusted Project attribution.

## 7. Manual tests: Runner placement, Models and execution

### 7.1 Shared/dedicated allocation and concurrency of administration

Read the actual allocation before writing expected-state values:

```sh
curl -sS -b "$PRIVATE_DIR/admin.cookies" \
  "$BASE/api/v1/projects/$PROJECT_C/runner" > "$RESULT_DIR/c-runner-before.json"
jq . "$RESULT_DIR/c-runner-before.json"
jq --arg runtimeUrl 'http://runner-qa-c:8091' \
   --arg publicUrl 'https://runtime-qa-c.example.test' \
  '{mode:"dedicated",expectedGroupId:.groupId,expectedPoolId:(.pool.id // null),runtimeUrl:$runtimeUrl,publicUrl:$publicUrl}' \
  "$RESULT_DIR/c-runner-before.json" > "$RESULT_DIR/c-runner-request.json"
```

Replace both example URLs with real test service addresses. The write below
requires the source group's Runners to be stopped/offline in your disposable
environment; when they are active, the expected outcome is a conflict:

```sh
curl -sS -b "$PRIVATE_DIR/admin.cookies" -X PUT \
  "$BASE/api/v1/projects/$PROJECT_C/runner" -H "Origin: $BASE" \
  -H 'Content-Type: application/json' \
  --data-binary @"$RESULT_DIR/c-runner-request.json" \
  -o "$RESULT_DIR/c-runner-after.json" -w 'HTTP %{http_code}\n'
```

| ID | Procedure | Expected result | Implementation / regression |
| --- | --- | --- | --- |
| RUN-01 | Read A/B/C `/projects/:id/runner`; configure C dedicated while safely offline. | A/B use `default`; C pool ID equals canonical C name, instance `runner-qa-mt-c-0`; C removed from default pool's effective state. | [allocation predicate](../controller/server/services/runner-allocation.ts), [configuration](../controller/server/services/project-groups.ts#L152), [Runner identity tests](../controller/server/services/runner-project-identity.postgres.test.ts). |
| RUN-02 | Observe C group and Model scope immediately after dedicated registration. | Separate/exclusive group as needed, no implicit Model grant; existing exclusive scope may be reused. Other Projects retain their allocation. | [configuration transaction](../controller/server/services/project-groups.ts#L152), [groups tests](../controller/server/services/project-groups.postgres.test.ts). |
| RUN-03 | Repeat allocation with stale `expectedGroupId` or `expectedPoolId`; issue concurrent conflicting moves. | 409 `project_group_assignment_conflict` / `runner_allocation_conflict`; serialized commit, no partial new group/pool or stale write. | [expected checks](../controller/server/services/project-groups.ts#L475), [concurrency regression](../controller/server/services/project-groups.postgres.test.ts). |
| RUN-04 | Move active group/project/pool or change blocked connectivity; attempt non-noop reassignment with lease grants enabled or prior grant history. | Active allocation 409 `project_group_runners_active`; lease-mode/history moves 409 `runner_lease_reassignment_unavailable`. No live automatic migration. | [offline/lease guards](../controller/server/services/project-groups.ts#L483). |
| RUN-05 | Register unallocated pool, wrong Project pool name, wrong Project Runner ID, negative/padded ordinal, duplicate foreign/offline Runner ID. | Registration rejects invalid/cross-pool identity; no takeover. Dedicated pool ownership/name is immutable. | [registerRunner](../controller/server/services/control-plane.ts#L2257), [identity](../controller/server/services/runner-project-identity.postgres.test.ts), [group tests](../controller/server/services/project-groups.postgres.test.ts). |
| RUN-06 | Create/rename/delete test groups; delete default or nonempty group; give custom pool a missing runtime/public URL. | Empty custom groups manageable; protected/nonempty groups rejected; custom allocation never silently inherits default URL. | [group service](../controller/server/services/project-groups.ts), [group regression](../controller/server/services/project-groups.postgres.test.ts). |
| RUN-07 | Inspect desired state delivered to A/B shared pool and C pool, compiler job selection, preload and heartbeat/health lists. | Only allocated Projects' Endpoints, credential hashes, Routers, artifacts, logging and defaults; no foreign pool resources/compiler jobs. User Runner inventory limited to allocated capacity. | [desiredStateForPool](../controller/server/services/control-plane.ts#L2396), [dispatch](../controller/server/services/project-group-routing.ts), [group distribution tests](../controller/server/services/project-groups.postgres.test.ts). |
| RUN-08 | NACK a shared snapshot containing private diagnostic text; inspect A/B/C Router status and platform audit. | Only affected allocation's Router status changes; Project error is generic, private raw error only in platform audit. Dedicated C unaffected by A/B rejection. | [rollout isolation](../controller/server/services/runner-rollout-isolation.postgres.test.ts). |

### 7.2 Credential and Model scope

Configuration modes to record before these tests:

| Setting | Contract |
| --- | --- |
| `CONTROLLER_RUNNER_POOL_TOKENS_JSON` | Pool→control-token map; when present, legacy control token is not accepted as a pool identity. |
| `CONTROLLER_RUNNER_HTTP_TOKENS_JSON` | Optional pool→internal-HTTP-token map; requires exactly the control map's pool IDs and distinct secrets. |
| `CONTROLLER_RUNNER_SCOPED_TELEMETRY=true` | Requires pool authentication; internal telemetry uses authenticated pool/context provenance. Default is false. |
| `GUARD_RUNNER_CONTROL_TOKEN`, pool/Runner ID | Runner-side matching control identity; configure each deployment explicitly. |
| `GUARD_RUNNER_SCOPED_TELEMETRY=true` | Runner counterpart for scoped evidence; requires control token. |

| ID | Procedure | Expected result | Implementation / regression |
| --- | --- | --- | --- |
| MOD-01 | Query default and custom group's `/model-configuration`; dispatch Model-dependent work before granting custom group. | Default can use `platform`; custom group defaults to `blocked` and cannot inherit platform Models automatically. Missing grant fails closed. | [group runtime](../controller/server/model-config/group-runtime.ts#L107), [group-runtime tests](../controller/server/model-config/group-runtime.postgres.test.ts). |
| MOD-02 | Grant validated platform source revision with `mode:scoped`, current `expectedVersion`, `sourceRevisionId`, `expectedSourceFingerprint`. | Frozen group snapshot/credentials and generation; not a global draft activation. Public response omits credentials/ciphertexts/runtime payload/base URLs. | [group update](../controller/server/model-config/group-runtime.ts#L69), [request schema](../controller/shared/group-model-configuration.ts). |
| MOD-03 | Edit source draft/provider credential/concurrency/threshold/request mode without regrant; then explicitly regrant/revoke. | Existing scope stays frozen; regrant needs current validated fingerprint; revoke uses `blocked`; stale version rejected. | [snapshot tests](../controller/server/model-config/group-runtime.postgres.test.ts). |
| MOD-04 | Grant custom group `platform`; grant private Project Model; omit pool auth; use stale source validation. | All rejected; grants cannot broaden platform/private ownership or bypass validation/auth prerequisites. | [group-runtime negative tests](../controller/server/model-config/group-runtime.postgres.test.ts). |
| MOD-05 | Resolve Model credentials with correct pool, foreign/stale/deprovisioned pool, unknown validation lease and foreign refs. | Only authorized current allocation/lease resolves; no fallback to unrelated active secrets. Verify denial and absence of secret body. | [credential HTTP API](../controller/server/http/app.ts#L1463), [credential allocation tests](../controller/server/http/model-credential-pool-allocation.postgres.test.ts). |
| MOD-06 | A reads platform Model and own private Model; B reads A private Model; A tries editing/deleting platform Model. Admin attempts Model write with Project selector. | Platform Model readable; private Model hidden from B; platform edits denied to business user; selected-Project admin Model write 403 `project_read_only`. | [Model predicates](../controller/server/services/project-context.ts#L122), [Model service](../controller/server/model-config/service.ts), [Model tests](../controller/server/model-config/model-configuration.postgres.test.ts). |
| MOD-07 | Send each Controller-to-Runner HTTP credential to own and foreign Runner; try legacy token while scoped HTTP token configured. | Only matching inbound token accepted; no header/URL-selected credential fallback; wrong credential unauthorized. | [HTTP routing tests](../controller/server/http/runner-http-pool-routing.test.ts), [real Runner auth tests](../tests/data_plane/test_controller_pool_http_auth.py). |
| MOD-08 | Activate platform Model defaults while only scoped-group ACKs are available. | Scoped ACK cannot prove platform activation; backend selects a pool consuming platform defaults or reports no activation pool. | [activation selection](../controller/server/http/app.ts#L613), [group-runtime activation tests](../controller/server/model-config/group-runtime.postgres.test.ts). |

The acceptance helper currently recognizes `legacy/scoped/blocked` in its optional
administrator Model-policy check, while the current backend/schema returns
**`platform/scoped/blocked`**. If acceptance includes a default group in `platform`
mode, that check can reject a valid current response. This is a tooling contract
mismatch visible in [the helper](../scripts/verify-local-multitenancy.mjs#L210)
versus [the group schema](../controller/shared/group-model-configuration.ts).
Test/report the mismatch; do not change a valid Model policy merely to satisfy
the tool. The default acceptance run without `administratorAuth` does not execute
that optional check.

## 8. Live gateway acceptance

Run only after the current-source deployment and A/B/C fixtures are ready. Use
quiet Endpoints and harmless text that the configured Guardrails permit.

### 8.1 Minimal acceptance configuration

Create `.local-secrets/mt-qa/acceptance.json` with mode `0600`, replacing every
placeholder. Management PATs require `guardrails`, `routers`, `endpoints`, and
`runtime` read permissions. Gateway keys and Endpoint credentials are different
credential types.

```json
{
  "schemaVersion": 1,
  "controllerBaseUrl": "https://guard.example.test",
  "requestText": "Hello.",
  "timeoutMs": 120000,
  "projects": [
    {
      "id": "qa-mt-a",
      "auth": { "bearerToken": "REPLACE_WITH_A_MANAGEMENT_PAT" },
      "runnerBaseUrl": "https://shared-runtime.example.test",
      "gateway": {
        "baseUrl": "https://gateway-a.example.test/v1",
        "apiKey": "REPLACE_WITH_A_GATEWAY_KEY",
        "model": "guarded-model"
      },
      "resources": {
        "endpointId": "REPLACE_WITH_A_ENDPOINT_ID",
        "routerId": "REPLACE_WITH_A_ROUTER_ID",
        "guardrailId": "REPLACE_WITH_A_GUARDRAIL_ID",
        "guardrailVersion": "REPLACE_WITH_A_PUBLISHED_VERSION"
      }
    },
    {
      "id": "qa-mt-c",
      "auth": { "bearerToken": "REPLACE_WITH_C_MANAGEMENT_PAT" },
      "runnerBaseUrl": "https://dedicated-runtime.example.test",
      "gateway": {
        "baseUrl": "https://gateway-c.example.test/v1",
        "apiKey": "REPLACE_WITH_C_GATEWAY_KEY",
        "model": "guarded-model"
      },
      "resources": {
        "endpointId": "REPLACE_WITH_C_ENDPOINT_ID",
        "routerId": "REPLACE_WITH_C_ROUTER_ID",
        "guardrailId": "REPLACE_WITH_C_GUARDRAIL_ID",
        "guardrailVersion": "REPLACE_WITH_C_PUBLISHED_VERSION"
      }
    }
  ]
}
```

Add B as a third entry to cover A/B sharing versus C dedicated. The helper accepts
2–8 Projects and existing session cookies as an alternative to PATs; it never
logs in or provisions fixtures.

```sh
node scripts/verify-local-multitenancy.mjs \
  --config .local-secrets/mt-qa/acceptance.json --execute \
  --result .tasklattice-recovery/mt-qa/acceptance-result.json
jq '{status,checks,runtime,capabilities,limitations}' \
  .tasklattice-recovery/mt-qa/acceptance-result.json
```

`--execute` intentionally sends real completion traffic and creates telemetry.
Expected mandatory checks:

1. Each supplied credential identifies the configured business Project.
2. Own Endpoint/Router/Guardrail reads succeed and every foreign direct-ID read
   returns 404.
3. Business users cannot read group/admission administration (403).
4. Configured Runner origins are connected and synchronized.
5. Each gateway produces a valid completion and paired incoming/outgoing events
   for the configured Endpoint, Router, Guardrail and exact immutable version.
   Paired events share request ID; input/output may run on different replicas.

Add optional evidence only when the corresponding capability is configured:

- `resources.endpointCredential`: verifies own Endpoint key and denial at other
  configured Runner origins. The helper's wrong-origin check expects 401/404.
  An Endpoint key for B must also fail against A's Endpoint on the same shared
  Runner; test that separately.
- `modelStatus: {"url":"https://model.example.test/state","token":"PRIVATE"}`:
  expects idle `active:0` and exactly one added `completed` count per completion.
  Without this, external Model dispatch is unverified.
- `administratorAuth` and per-Project `expectedGroupId`/`expectedPoolId`: placement
  and Model-policy checks. Address/report the `legacy` versus `platform` helper
  mismatch in section 7.2 before relying on it for default-group acceptance.

The helper correlates bounded, quiet resource-path telemetry, not a cryptographic
gateway correlation ID. A successful serial run does not prove sustained
performance, failover or correct guard blocking behavior.

### 8.2 Additional live positive/negative cases

| ID | Procedure | Expected result | Reference |
| --- | --- | --- | --- |
| E2E-01 | Harmless complete Input→generation→Output path for A/B/C. | Valid completion and two matching evidence directions; no foreign Project reads. | [acceptance tool](../scripts/verify-local-multitenancy.mjs), [gateway guide](gateway-integration.md). |
| E2E-02 | Known input-block and output-block test cases per deployed Policy; compare A and C with intentionally distinct rules. | Decision matches that Project's pinned path; blocked input does not dispatch generation, blocked output is not delivered as allowed content. Use Runner evidence rather than infer decisions from HTTP 200 alone. | [runtime tests](../tests/data_plane/test_endpoint_access.py), [routing runtime](../controller/server/services/traffic-routing.ts). |
| E2E-03 | Wrong/missing Endpoint key on own Endpoint; B key at A Endpoint, and A key at C Runner; revoked key after distribution. | Auth-required endpoint rejects wrong keys before policy execution; foreign/absent endpoint not accessible; old revoked key no longer works after ACK. | [Endpoint service](../controller/server/services/endpoint-credentials.ts), [endpoint access](../tests/data_plane/test_endpoint_access.py). |
| E2E-04 | Explicitly set `credentialRequired:false` on an isolated Endpoint; call without key and then reenable requirement. | Anonymous mode is intentional; protection still executes, owner remains Endpoint-derived, reenabling restores credential requirement. | [Endpoint management tests](../controller/server/http/endpoint-management.test.ts), [access tests](../tests/data_plane/test_endpoint_access.py). |
| E2E-05 | Interrupt Controller connectivity to C in disposable environment, including active HTTP/WebSocket stream; restore and synchronize. | New/active work is fenced or cancelled on lost authority; restored stale state alone does not authorize; serving resumes only after current synchronization. | [group synchronization](../tests/data_plane/test_runner_group_synchronization.py), [lease enforcement](../tests/data_plane/test_runner_lease_enforcement.py). |
| E2E-06 | Publish A-only version and observe A/B shared snapshot, C snapshot and status. | A update reaches eligible shared pool, C remains isolated; traffic still pins immutable published versions, not mutable draft. | [desired state](../controller/server/services/control-plane.ts#L2396), [group regression](../controller/server/services/project-groups.postgres.test.ts). |

## 9. Admission, rate limits and operational isolation

These controls are optional and should be tested separately from resource
privacy. Record configuration and topology; shared host/Redis/Model bottlenecks
can still couple latency across dedicated pools.

### 9.1 Local Project admission

An illustrative Runner configuration for one shared replica is:

```sh
export GUARD_RUNNER_PROJECT_ADMISSION_ENABLED=true
export GUARD_RUNNER_PROJECT_ADMISSION_JSON='{"capacity":4,"project_limits":{"qa-mt-a":2,"qa-mt-b":2},"max_queued":8,"max_queued_per_project":4,"queue_timeout_seconds":1}'
```

This is Runner process configuration; it is not a management API that dynamically
assigns Project capacity. Apply it to the intended test workload and verify its
actual settings before load. Local limits apply per process, not globally across
all replicas. Configure Redis-backed rate admission separately if required.

| ID | Procedure | Expected result | Reference |
| --- | --- | --- | --- |
| ADM-01 | Hold two long A requests, offer further A traffic, issue B request while capacity remains. | A active count capped; B obtains eligible free capacity; bounded Project queues, round-robin across Projects and FIFO within Project. | [local admission](../runner/project_admission.py), [local tests](../tests/data_plane/test_project_admission.py). |
| ADM-02 | Forge `X-Project-ID`/body owner on A Endpoint and saturate it; repeat HTTP, Scan and WebSocket. | Budget derives from Endpoint owner, never request header; protocols share configured owner budget; WebSocket holds a whole-stream permit. | [Endpoint admission tests](../tests/data_plane/test_endpoint_project_admission.py). |
| ADM-03 | Timeout/cancel queued work, disconnect stream, change owner during queue wait, lose serving authority. | Permits/queue slots released exactly once; ownership rechecked before execution; no capacity leak or stale execution. | [Endpoint tests](../tests/data_plane/test_endpoint_project_admission.py), [local tests](../tests/data_plane/test_project_admission.py). |
| ADM-04 | Enable local admission with absent/unknown Project owner, duplicate JSON keys or malformed/unbounded limits. | Startup rejects invalid config or runtime fails closed before model/policy execution; no automatic new Project budget. | [configuration](../runner/config.py), [admission config](../runner/project_admission.py#L55). |
| ADM-05 | Inspect `/project-admission-monitor` as admin/user/PAT; compare current, stale and offline snapshot data. | Admin/granted platform token only; current topology and missing/stale evidence explicit; monitor does not invent utilization/reservations. | [monitor](../controller/server/services/admission-monitor.ts), [monitor tests](../controller/server/services/admission-monitor.postgres.test.ts). |

### 9.2 Redis rates and experimental leases

| ID | Procedure | Expected result | Reference |
| --- | --- | --- | --- |
| RATE-01 | Run multiple replicas against one explicitly provisioned Project-rate policy; exceed one Project's rolling-window starts. | Aggregate admission rate enforced; independent Project remains eligible within own/global bounds. This is starts/window, not concurrency reservation. | [distributed rate](../runner/distributed_rate_admission.py), [tests](../tests/data_plane/test_distributed_rate_admission.py). |
| RATE-02 | Provision group v2 policy with matching group/revision/pool epochs across two pools; exercise group, Project and pool limits. | Shared canonical policy/Redis hash slot; all three limits enforced across participating pools; no per-request counter provisioning. | [group rate](../runner/group_rate_admission.py), [tests](../tests/data_plane/test_group_rate_admission.py). |
| RATE-03 | Stop test Redis; use missing/corrupt/mismatched policy/revision/epoch; try simultaneous incompatible v1/v2 modes. | Fail closed/unavailable or config rejection; never quietly bypass limits; local slot released on Redis errors. | [Runner config](../runner/config.py), [group tests](../tests/data_plane/test_group_rate_admission.py). |
| LEASE-01 | Enable experimental Controller grants and Runner enforcement in matching test pool; let lease expire/revoke during queued/active work. | Serving fences according to lease and synchronization tests; no old snapshot resurrection. | [lease ledger](../controller/server/services/runner-lease-ledger.ts), [lease tests](../tests/data_plane/test_serving_lease.py), [enforcement tests](../tests/data_plane/test_runner_lease_enforcement.py). |
| LEASE-02 | Try allocation move with grants enabled, then disable flag but retain grant history. | Both unsafe non-noop move attempts rejected; no claim of implemented live lease-aware migration/drain. | [reassignment guards](../controller/server/services/project-groups.ts#L499), [group regression](../controller/server/services/project-groups.postgres.test.ts). |

For a bounded load experiment, follow [tenant-load-lab.md](tenant-load-lab.md).
The aliases `tenantA/B/C` and generator `shared/quota` modes control external
request generation; they do not configure backend Project budgets, change
allocation, reserve CPU or prove fleet-wide fairness. Measure successful and
failed requests, queue time, throughput and latency together. Define acceptable
latency/throughput thresholds before the experiment; this repository does not
provide a universal multi-tenancy performance SLO.

## 10. Database observations and sign-off

Use a read-only operator connection to a disposable test deployment for these
observations. Run each query independently:

```sql
SELECT id, name, group_id, external_department_id FROM project ORDER BY id;
SELECT project_id, user_id, source, access, roles
FROM project_member ORDER BY project_id, user_id;
SELECT user_id, active_project_id FROM auth_session ORDER BY user_id;
SELECT id, project_id, group_id, runtime_url, public_url
FROM runner_pool ORDER BY id;
SELECT id, project_id FROM guardrail ORDER BY id;
SELECT id, project_id FROM endpoint ORDER BY id;
SELECT id, project_id FROM traffic_router ORDER BY id;
SELECT id, project_id, endpoint_id, request_id
FROM runtime_event ORDER BY occurred_at DESC LIMIT 100;
SELECT project_id, count(*) FROM runtime_event GROUP BY project_id;
SELECT id, user_id, project_id, prefix, expires_at, revoked_at
FROM personal_access_token ORDER BY created_at DESC;
```

Do not export auth-session tokens, password hashes, provider ciphertexts or PAT
secrets into the report. Assert ownership against independently recorded fixture
IDs; aggregate counts alone cannot detect a wrong owner. Compare pre/post row
state, version/revision and desired generation for denied writes.

Release acceptance requires:

- Current Controller/Runner source/image identity verified; correct schema,
  ready storage, expected serving capacity and converged desired state.
- Focused PostgreSQL/HTTP cases execute and pass, including the currently broken
  multi-project fixture; no essential isolation test hidden behind a skip.
- Positive own-Project and negative foreign-ID/mutation/evidence/package tests
  pass for A/B/C and session/PAT authority.
- SSO path/department mapping and next-sign-in revocation verified if SSO is used.
- Pool-scoped credential/Model/desired-state checks pass in the configured mode.
- A/B shared and C dedicated gateway paths produce correct protection outcomes
  and Project-scoped telemetry/costs.
- Optional admission/rate/lease modes are either verified enabled or explicitly
  marked not enabled; performance results use a stated workload and threshold.
- Broad test failures are triaged rather than silently treated as tenancy passes.

Suggested per-case evidence row:

```text
Case ID | source/image revision | fixture Project | role/credential type |
configuration mode | request/expected status | actual status |
redacted evidence path | pass/fail/blocked/not enabled | issue/reference
```

Cleanup only the disposable fixtures you created. Revoke QA PATs and Endpoint
keys; stop QA load, remove private test credentials/results according to your
retention policy, and remove disposable containers:

```sh
docker stop guard-mt-qa-postgres guard-mt-qa-redis
unset TOKEN_A TOKEN_B GUARD_TEST_POSTGRES_URL GUARD_TEST_REDIS_URL
```

There is no Project DELETE route in the implemented management API. Use a fresh
disposable database/environment for lifecycle tests instead of inventing a
tenant deletion API or deleting existing deployment rows manually.

## 11. Final audit results

### 11.1 Completed commands and scope

The full Controller run used `vitest run server --maxWorkers=2` with PostgreSQL
17 on loopback. It completed in **484.78 seconds**:

```text
Test Files  9 failed | 163 passed (172)
Tests       13 failed | 1931 passed | 3 skipped (1947)
```

The 3 skipped bodies belong to the failed multi-project setup suite. The broad
run hit that hook's 10-second limit; the earlier focused run reached the
missing-Profile error. Neither run executed those three HTTP test bodies.

The combined 11-file Runner run with Redis configured completed in **5.64 seconds**:

```text
213 passed, 0 skipped
```

Before Redis was configured, the same group of checks had 187 passes and 26
dependency skips; the completed Redis-enabled run supersedes that incomplete
result. The two external tooling files passed separately (26 acceptance-tool
tests and 24 load-tool tests). Controller typecheck, backend build and the 28-test
OpenAPI check passed. Test-generated contracts did not change tracked files.

### 11.2 Full Controller failure inventory

| Failed file | Failed cases / observed evidence | Interpretation for this audit |
| --- | --- | --- |
| [http/multi-project.postgres.test.ts](../controller/server/http/multi-project.postgres.test.ts#L35) | Setup failure, 3 unexecuted cases. Focused run: unavailable pinned Profile at service initialization. Broad run: 10-second setup timeout. | Fix fixture seeding and rerun; do not claim its admin-PAT, real password/session or switching HTTP cases passed. |
| [db/client.postgres.test.ts](../controller/server/db/client.postgres.test.ts#L66) | 2 failures: backend termination and idle-transaction timeout recovery. Child process returned null exit code instead of 0; child has its own 6-second timeout. | **Passed on isolated recheck** with one worker. Broad-run timing failures are not evidence of a reproduced connection-recovery defect; retain them as contention-sensitive regressions. |
| [policy-catalog/catalog.test.ts](../controller/server/policy-catalog/catalog.test.ts#L29) | 1 failure: expected all built-ins at `1.0.0`, catalog includes `1.0.1`. | Catalog/test version expectations disagree; no ownership leak established. |
| [policy-catalog/presets.test.ts](../controller/server/policy-catalog/presets.test.ts#L15) | 3 failures: two fixtures pin `identity-documents@1.0.0` but current head is `1.0.1`; one invalid inherited payment-data test exclusion. | Preset/fixture contract drift requires investigation; do not assume all preset authoring flows work. |
| [services/guardrail-packages.postgres.test.ts](../controller/server/services/guardrail-packages.postgres.test.ts#L162) | 3 failures: expected Default suite 746, actual 726; editable-import workflow and imported-report deletion each exceeded 30 seconds. | Default count mismatch plus unresolved package workflow time budgets. Other package tests passing does not clear these cases. |
| [services/guardrail-publication.postgres.test.ts](../controller/server/services/guardrail-publication.postgres.test.ts#L65) | 1 failure: tested-candidate publication exceeded 30 seconds. | **Passed on isolated recheck** with one worker and 60-second default test budget. Broad-run performance under contention remains a separate observation. |
| [services/large-testing-report.postgres.test.ts](../controller/server/services/large-testing-report.postgres.test.ts#L84) | 1 failure: expected queued report total 950, actual 930. | Test selection/count disagreement; large report delivery assertions were not reached. |
| [services/preconfigured-guardrail.postgres.test.ts](../controller/server/services/preconfigured-guardrail.postgres.test.ts#L42) | 1 failure: expected Default suite 746, actual 726. | Same Default count disagreement seen in package suite. |
| [services/validation-persistence.postgres.test.ts](../controller/server/services/validation-persistence.postgres.test.ts#L59) | 1 failure: repeated single-connection save/prune test exceeded 5 seconds. | **Passed on isolated recheck** with one worker and 60-second default test budget. The original 5-second broad-run budget was not met. |

None of the recorded failures is an observed successful cross-Project access.
That does **not** clear the failed/unexecuted paths or establish complete
production readiness.

### 11.3 Reproduction and evidence handling

Use the commands in section 4 for the broad run. To separate contention from
repeatable setup/recovery/publication problems, rerun the timing-sensitive subset
with one worker and explicit suite budgets:

```sh
(
  cd controller
  ./node_modules/.bin/vitest run \
    server/http/multi-project.postgres.test.ts \
    server/db/client.postgres.test.ts \
    server/services/validation-persistence.postgres.test.ts \
    server/services/guardrail-publication.postgres.test.ts \
    --maxWorkers=1 --hookTimeout=30000 --testTimeout=60000
)
```

This recheck completed in **46.89 seconds**, with **39 passed / 3 skipped**;
3 files passed and the multi-project setup suite failed. It reproduced the
missing Profile error in 1.63 seconds, confirming that the focused setup failure
is independent of the broad run's hook timeout. The four connection/publication/
persistence test failures from the broad run did not reproduce under this
configuration. The two package-workflow timeouts were not separately rerun;
their outcome remains unresolved. Changing time budgets does not establish that
the original broad-run timing requirements have been met.

The audit used disposable containers named
`guard-multitenancy-audit-20261108` and
`guard-multitenancy-redis-audit-20261108`, rather than the example names in
section 4. Existing demo pods and their databases were not used for test writes.
No implementation fix or commit is included with this manual.
