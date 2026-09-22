# Add a Cisco-style, permission-aware operations CLI

## Summary

Provide an interactive terminal client for TaskLattice Guard that uses the
Controller management API as its only control path. It has a read mode and an
administrator-enabled mode, inspired by Cisco IOS:

```text
$ guardctl
guardctl(disconnected)> read
Access token: ********
guardctl> show routers
guardctl> show router payments
guardctl> enable
Admin password: ********
guardctl# publish router payments
```

## Resource model

The platform has a first-class **Router** resource. It is not an alias for a
Guardrail deployment:

- A **Router** (`traffic_router`) contains an ordered draft of matching
  **Routes** and weighted **Targets**, has immutable published **Revisions**,
  and binds one or more **Endpoints**.
- A Route selects Targets by a Traffic Selector. A Target references a specific
  Guardrail Version (or resolves `latest` while the Router is still a draft)
  and has a weight in basis points.
- A published Router has exactly one enabled, unconditional fallback Route last;
  Target weights total 10,000 basis points.
- An **Endpoint** is the upstream/runtime integration configuration and
  credential boundary. It is separately lifecycle-managed and can be bound to a
  Router.
- A **Guardrail** is a versioned policy composition and compiled artifact. It is
  not the traffic-routing object.

CLI nouns: `router`, `route`, `target`, `endpoint`, and `telemetry-event`.

## Scope and design principles

The Controller owns authorization, desired generation, Router publication,
audit history, soft-deletion checks, and reconciliation. The Runner owns local
Endpoint authentication, routing execution, artifact activation, NeMo
evaluation, and telemetry export.

Therefore the CLI must:

- call the Controller API only;
- use a personal access token (PAT) for normal unattended or read access;
- use a fresh Better Auth administrator authentication for `enable`, or an
  explicitly configured admin PAT when the final API contract permits it;
- rely on server-side module permissions and role checks for every request;
- retain tokens/session material in memory only; and
- never issue direct SQL, Runner gRPC, Runner-internal HTTP, Redis, Helm, or
  Kubernetes commands.

A prompt state is UX only. It cannot grant permissions that the Controller
denies.

## Resource inventory

| CLI resource | Model and public API | Purpose | Minimum token module |
| --- | --- | --- | --- |
| `system` | `GET /api/v1/system/status` | Platform readiness, Runner fleet status, desired generation, model connection summary | Public/status |
| `identity` | `GET /api/v1/account/identity` | Current user, auth method, PAT identity, granted/effective permissions | authenticated |
| `access-tokens` | `/api/v1/account/access-tokens` | User’s PAT metadata and revocation; plaintext returned once at creation | session only; not a PAT operation |
| `providers` | `model_provider`; `/api/v1/model-providers` | Provider connectivity and credential configuration | model configuration |
| `models` | `model_definition`; `/api/v1/models` | Physical model, profile, transport/validation state | model configuration |
| `model-configuration` | `model_configuration_revision`; `/api/v1/model-configuration` | Draft/validated/active model assignments and activation history | model configuration |
| `policies`, `policy` | `policy_record`, `policy_version`; `/api/v1/policies` | Versioned programmable Policy source and immutable snapshots | Policy Library |
| `policy-validations` | `policy_validation_run`; `/api/v1/policies/:id/validation-runs/*` | Policy draft validation results | Policy Library |
| `protection-presets` | `/api/v1/policy-catalog/protection-presets` | Catalog-provided Protection starting points | Policy Library |
| `actions` | `/api/v1/policy-catalog/actions` | Registered runtime Actions available to Policies | Policy Library |
| `guardrails`, `guardrail` | `guardrail`, `guardrail_version`, `guardrail_artifact`; `/api/v1/guardrails` | Guardrail draft, immutable versions, compiled artifact and desired generation | GuardRails |
| `guardrail-logging` | `/api/v1/guardrails/:id/logging` | Evidence/logging level: `info`, `debug`, `trace` | GuardRails |
| `test-cases` | `guardrail_test_case`; `/api/v1/guardrails/:id/test-cases` | Guardrail validation fixtures and scope | GuardRails |
| `validation-runs` | `guardrail_validation_run`; `/api/v1/validation-runs` | Guardrail validation execution and evidence | GuardRails |
| `endpoints`, `endpoint` | `endpoint`; `/api/v1/endpoints` | Runtime integration adapter, lifecycle, setup, and credential metadata | Endpoints |
| `routers`, `router` | `traffic_router`; `/api/v1/routers` | Traffic-routing draft, active revision, rollout state, bound Endpoints | Routers |
| `router-revisions` | `traffic_router_revision`; `/api/v1/routers/:id/revisions` | Immutable published Router snapshots and rollback history | Routers |
| `routes` | Router draft/revision `routes[]` | A Router-scoped view of selectors and Targets; not a top-level database resource | Routers |
| `route-distribution` | `route_assignment`; `/api/v1/routers/:id/*traffic-distribution` | Assignment volume, outcomes, latency, and weighted target behavior | Routers |
| `selector-fields` | `/api/v1/routing/selector-fields` | Fields/capabilities valid in Traffic Selectors | Routers |
| `runners`, `runner-pools` | `runner_instance`, `runner_pool`; `/api/v1/runner-pools` | Desired pool capacity, Runner connectivity, applied generation, and load | Runners |
| `telemetry-events` | `runtime_event`; `/api/v1/telemetry/events` | Protection decisions/traces, filterable by Router/Route/Target/Endpoint/Guardrail | Runtime logs |
| `telemetry-metrics` | `/api/v1/telemetry/metrics` | Aggregated runtime behavior by time window/Guardrail/Router | Runtime logs |
| `endpoint-activity` | `/api/v1/telemetry/endpoint-activity` | Per-Endpoint callback/request/error observations | Runtime logs |
| `audit-events` | `audit_event`; `/api/v1/audit-events` | Immutable management and PAT request audit records | Audit log |

## Runner state to observe, never mutate directly

The Runner’s `ArtifactStore` and runtime registry contain operational state,
but these are not public CLI write resources:

- applied desired **generation**;
- signed Guardrail **artifacts** and compiled NeMo configurations;
- published Router **Revisions**, their Routes, Targets, Endpoint bindings, and
  credential verifiers;
- active model configuration/bindings needed by the data plane;
- temporary call and stream context in memory/Redis, including the pinned
  effective release;
- telemetry WAL/batches; and
- control-stream connection/synchronization state.

The CLI may report the Controller’s view of this state through `system`,
`runners`, Router rollout/distribution, telemetry, and metrics. It must not
mutate a Runner’s artifact store, generation, Redis call context, telemetry WAL,
or gRPC stream. It must not display Endpoint secret values, PAT plaintext,
provider credentials, signing keys, Runner tokens, or protected request content.

## Proposed command model

### Session and privilege modes

```text
guardctl(disconnected)> read
guardctl> show routers
guardctl> enable
guardctl# publish router <id>
guardctl# disable
guardctl> exit
```

- `read` requests a PAT or signs in through Better Auth. It verifies
  `/api/v1/account/identity` and displays effective module permissions.
- `enable` requires fresh administrator authentication. The user supplies the
  admin password through a non-echoing prompt; no password is persisted.
- `disable` clears the privileged session and returns to the original
  read-only credentials.
- `exit` clears all in-memory credential material.
- A noninteractive companion form should use `GUARD_URL` and
  `GUARD_ACCESS_TOKEN`; it must never accept a password command-line flag.

The PAT permission model already supplies read/no-access/write per module.
Normal member accounts can create read-only tokens; admin users can issue
write-capable tokens. Effective permissions are the token’s grants intersected
with the account’s current role and status. This makes a PAT the preferred
read-mode identity and preserves immediate denial after revocation, expiry,
demotion, or account disablement.

### Read commands

Every initial read command must map to an existing endpoint and module:

```text
show system
show identity
show providers | models | model-configuration
show policies [<policy-id>]
show policy-validation <policy-id> [<run-id>]
show protection-presets | actions
show guardrails [<guardrail-id>]
show guardrail-logging <guardrail-id>
show test-cases <guardrail-id>
show validation-runs [--guardrail <id>]
show endpoints [<endpoint-id>]
show routers [<router-id>]
show router-revisions <router-id> [<revision>]
show routes <router-id> [--revision <n>]
show route-distribution <router-id> [--route <id>] [--revision <n>] [--endpoint <id>] [--window <duration>]
show selector-fields [--endpoints <id,...>]
show runner-pools [<pool-id>]
show runners [--pool <id>]
show telemetry-events [--router <id>] [--route <id>] [--target <id>] [--endpoint <id>] [--guardrail <id>] [--request <id>] [--since <RFC3339>] [--before <RFC3339>] [--cursor <opaque>] [--limit <n>]
show telemetry-event <event-id>
show telemetry-metrics [--router <id>] [--guardrail <id>] [--window 1h|24h|7d|15d|30d]
show endpoint-activity
show audit-events [--limit <n>]
```

For `show routes`, the client reads the Router’s draft, active snapshot, or
selected Revision; it does not invent a global route endpoint.

### Privileged commands: staged delivery

Do not expose a generic `delete x` or `stop x` grammar. Resource lifecycles
differ, and “stop” is misleading for Runner Pods. Add only commands that map
exactly to audited Controller operations:

```text
enable|disable endpoint <id>
set runner-pool <id> replicas <n> safe-rps <n> max-concurrency <n>
set guardrail-logging <id> info|debug|trace --acknowledge-cost
validate guardrail <id>
publish guardrail <id>
rollback guardrail <id> <ready-version>
delete guardrail-version <id> <version>
create|save|preview|publish router <id> ...
bind endpoints <endpoint-id>... to router <id>
rollback router <id> <revision>
delete router-revision <id> <revision>
delete router <id>
delete endpoint <id> --reason <text> [confirmation flags]
remove runner <runner-id>
activate model-configuration <revision>
rollback model-configuration
```

The final argument syntax should be generated from the Controller OpenAPI
document (`/api/openapi.json`) or a shared command specification, not
hand-maintained independently. Create/edit commands with nested Policy,
Guardrail, Router Selector, or model payloads should accept a validated JSON/YAML
file and use a preview/review step; they should not try to reproduce the browser
authoring forms as positional arguments.

There is no `stop runner` command. The existing Runner operation removes a
stale registration; actual Pod lifecycle belongs to Kubernetes/Helm. There is
also no direct artifact deletion, no direct credential listing, and no direct
Router assignment mutation.

## Safety and audit requirements

- Every mutating command requires privileged mode **and** a Controller-approved
  module write permission. Token/role checks remain the authority.
- Guardrail and Endpoint soft deletion must retain the current API’s reason,
  recent-traffic check, telemetry-freshness behavior, second confirmation, and
  exact-name confirmation where required. Router deletion has a different
  existing contract: every Endpoint must first be unbound from that Router.
- Historical Guardrail-Version and Router-Revision deletion must preserve their
  existing reference, convergence, and in-flight retention checks.
- Router publication must require expected draft revision and idempotency key,
  use the reviewed publication snapshot, and preserve immutable Revisions.
- The CLI must show desired generation and Router rollout state after a change;
  it must not report success as data-plane convergence before fresh Runner ACKs
  make the rollout active.
- Mutating PAT requests are already audited with method, route, token ID, owner,
  and response status. The CLI must not put request bodies, passwords, or tokens
  into shell history or logs.

## Non-goals

- A separate CLI RBAC system, static admin password, or direct Runner access.
- Direct PostgreSQL/Redis queries or mutations.
- Kubernetes workload deletion, scaling, or shell execution.
- Displaying raw credentials, signing material, captured content, or call/stream
  context.
- Replacing the UI for complex Router/Guardrail/Policy authoring in the first
  release.

## Acceptance criteria

- [ ] Resource and command names use Router, Route, Target, Endpoint, and
  telemetry-event vocabulary.
- [ ] Read mode accepts a read-scoped PAT and displays effective permissions.
- [ ] Privileged mode requires fresh admin authentication and all writes remain
  subject to Controller role/module checks.
- [ ] Read commands cover every existing public operator resource listed above.
- [ ] Each write command maps to one existing audited API operation and observes
  its concurrency, confirmation, lifecycle, and reconciliation requirements.
- [ ] Shell and noninteractive modes redact all secret material and preserve no
  credential state after exit.
