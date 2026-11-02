# Multi-tenancy resource-isolation audit

Checked on 2026-10-24 against `feat/multi-tenant-v2` at `6044b72`, including the existing uncommitted multi-tenancy documentation. This is an implementation review, not a claim of deployed isolation or a penetration test. No application behavior was changed for this audit.

Related documents: [project walkthrough](project-walkthrough.md), [implementation record](multi-tenancy.md), [storage diagram](multi-tenancy-storage-isolation.md), and [local testing and measured capacity](multi-tenancy-local-testing-2026-10-24.md).

## Finding

**The implementation separates tenant-owned management data and invocation evidence. It does not isolate tenant compute resources, Runner administration, runtime placement, or runtime model budgets.** It currently implements a shared, platform-trusted data plane.

“Resource isolation” needs three separate assessments:

| Boundary | Current result | Meaning |
| --- | --- | --- |
| Resource visibility and mutation | Implemented for tenant business resources, with explicit read-sharing | Tenants cannot ordinarily read or mutate another tenant's private Policy, Guardrail, Router, Endpoint, or Model through supported management APIs. |
| Compute, quota, and availability | Not implemented per tenant | CPU, memory, admission, models, preparation, and validation remain shared; noisy neighbors are possible. |
| Infrastructure and trust | Shared | One database schema and shared trusted Runner processes; no tenant-specific process, credential, or Pod security boundary. |

Sharing compute does not inherently defeat API authorization. Conversely, successful API isolation tests do not establish resource fairness or dedicated infrastructure.

## Implemented management boundaries

Authority comes from the current authenticated account and its persisted tenant, with personal-token permissions constraining it further. Tenant headers and request bodies cannot choose another tenant. Invalid explicit token authentication does not fall back to a browser session. Missing or malformed tenant identity fails closed at the HTTP boundary.

See [HTTP authentication](../controller/server/http/app.ts), [shared RBAC](../controller/shared/rbac.ts), and [tenant context](../controller/server/services/tenant-context.ts).

The root resource owns the boundary. Children such as versions, tests, artifacts, and validation reports are authorized through their root. Read access requires ownership or an owner-bound grant. Writes require ownership. The relevant predicates are:

```ts
export function resourceWritePredicate(ownerColumn: AnyColumn): SQL | undefined {
  const tenantId = currentTenantId();
  return tenantId ? eq(ownerColumn, tenantId) : undefined;
}
```

The read predicate also matches `resource_share` on resource kind, resource ID, current owner, and recipient. A stale grant therefore does not automatically follow an ownership change.

Important details:

- Sharing supports read access and permitted composition, not edits, publication, credentials, ownership transfer, or onward sharing.
- Endpoint/Router binding stays within one tenant; a shared Policy can be used in a recipient Guardrail and a shared Guardrail in a recipient Router.
- Save/preview/validation/publication paths recheck references. Publication does not rely solely on an earlier validation's access checks.
- Revocation coordinates with publication and rejects active dependencies using `share_in_use`.
- Runtime evidence, security-event cursors, metrics, and cost queries follow the invoking tenant. Shared Guardrail ownership does not transfer the consumer's logs to its owner.
- Cleanup of an owner's invocation evidence preserves another tenant's invocation history.
- Provider credentials and platform detector assignments remain platform-managed. Tenant Model rows provide isolated inventories; they do not establish tenant-specific safety-model deployment.

Sources include [tenant sharing](../controller/server/services/tenant-shares.ts), [security events](../controller/server/services/security-events.ts), [runtime metrics](../controller/server/services/runtime-metrics.ts), [model pricing](../controller/server/services/model-pricing.ts), and [operational-data cleanup](../controller/server/services/guardrail-operational-data.ts).

These protections use application predicates in shared PostgreSQL tables. There is no PostgreSQL row-level-security policy enforcing a second boundary. Missing service context identifies trusted internal/startup work, so correctness at the HTTP and service boundaries matters.

## Runner administration is deployment-wide

[RBAC](../controller/shared/rbac.ts) explicitly grants both account roles Runner writes:

```ts
admin: {
  guardrails: "read", policies: "read", playground: "read", routers: "read", endpoints: "read",
  models: "write", runners: "write", settings: "write", users: "write",
  audit: "read",
},
user: {
  guardrails: "write", policies: "write", playground: "write", routers: "write", endpoints: "write",
  models: "write", runtime: "read", runners: "write",
},
```

Neither `runner_pool` nor `runner_instance` has a tenant owner. The following API operations are global:

| Operation | Actual effect |
| --- | --- |
| `GET /api/v1/runner-pools` | Lists deployment pools, instances, load, and operational metadata. |
| `PATCH /api/v1/runner-pools/:id` | Changes shared capacity-planning records, health/capacity reporting and recommendations; writes audit evidence. |
| `DELETE /api/v1/runner-instances/:runnerId` | Removes eligible offline registrations; force mode can remove syncing registrations with the matching boot ID. |

Healthy ready registrations cannot be removed through this deletion path. It does not delete Kubernetes Pods. Capacity edits do not resize a StatefulSet or change a running semaphore: actual replicas and concurrency come from Helm/environment configuration.

See [handlers](../controller/server/http/app.ts), `listRunnerPoolsWithCapacity`, `updateRunnerPool`, and `removeRunnerInstance` in [ControlPlaneService](../controller/server/services/control-plane.ts), and [capacity calculations](../controller/server/domain/capacity.ts).

This broad authority is deliberate in the current contract, not an accidental missing query predicate. Tests explicitly expect a tenant user to update `default`, and both session and correctly scoped token callers can exercise Runner operations. It is nevertheless a gap if the intended requirement is mutually untrusted tenant operations. Restricting Runner writes to platform operators would be an intentional authorization change.

## Additional pools do not create tenant partitions

`desiredStateForPool(poolId)` loads all published Router snapshots and all active Endpoints. Every pool receives Router-referenced artifacts across tenants. The default pool additionally holds eligible ready artifacts for Playground/internal checks.

Representative code from [ControlPlaneService](../controller/server/services/control-plane.ts):

```ts
const routerRevisions = await this.trafficRouting.runtimeSnapshots(tx);
const activeArtifacts = poolId === "default"
  ? readyArtifacts
  : readyArtifacts.filter((row) => referencedArtifactIds.has(row.artifact.id));
```

```ts
const endpointRows = await tx.select().from(endpoints).where(eq(endpoints.status, "active"));
```

[Router snapshot construction](../controller/server/services/traffic-routing.ts) is deployment-wide too. The Endpoint schema has no allowed-pool assignment. A request reaches a pool through the chosen Service, while authentication uses the Endpoint state held there.

Consequences:

- A valid Endpoint credential is usable against any pool holding that Endpoint.
- Giving pools tenant-looking names does not restrict the other tenants' state delivered to them.
- Policy plans, artifacts, Endpoint verifier hashes, and live model clients coexist in trusted Runner memory. Local recovery stores serialized desired-state configuration and credential references, not live client objects.
- One tenant's invalid/unloadable active configuration can prevent a complete new generation from converging for others. Last-known-good activation protects existing traffic, but not independent rollout progress.
- Active versions are prewarmed and retained; the on-demand cache limit does not cap the number of active Router targets.

The [control protocol](../proto/tasklattice/guard/control/v1/runner_control.proto) has no tenant-to-pool authorization assignment. Runner registration authenticates a deployment-trusted process using the shared token and, when enabled, mTLS. The shared certificate/CA is not mapped to a tenant-specific pool identity. Such processes should remain platform controlled.

## Concurrency is per Guardrail version, not tenant or whole Runner

[Runner startup](../runner/main.py) passes the configured concurrency as:

```python
registry = NeMoRuntimeRegistry(
    store,
    providers,
    max_concurrency_per_guardrail=configured.max_concurrency,
)
```

[The registry](../runner/toolkit/nemo/registry.py) keys a runtime using `(guardrail_id, guardrail_version)` and creates one semaphore per runtime:

```python
key = (plan.guardrail_id, plan.guardrail_version)
```

```python
asyncio.BoundedSemaphore(self._max_concurrency_per_guardrail)
```

Thus two tenants using the same shared version contend for its slots. Different versions have separate semaphores and can multiply aggregate concurrency. The default value of 64 is not a Runner-wide or tenant-wide maximum.

No tenant-aware RPS/token/spend quota, total concurrency cap, reserved capacity, bounded tenant queue, CPU allocation, or memory allocation was found. Pod limits constrain the whole process. Shared provider limits, memory, and CPU remain common failure domains.

Other shared budgets also matter:

- Validation dispatch is oldest-job-first across tenants, one job per available default compiler. There is no tenant fairness or job quota.
- Runtime preparation uses one process-wide construction worker.
- Draft previews share a global cache (default 32 entries / 900-second TTL), with oldest-entry eviction.
- In-memory call context shares a global entry cap (default 10,000 / 300-second TTL). Redis context uses shared Redis memory and TTL.
- Telemetry queues/spools, model clients, and retained releases are shared.

See [validation dispatch](../controller/server/control-channel/control-server.ts), [preparation](../runner/preparation.py), [draft previews](../runner/draft_preview.py), [call contexts](../runner/toolkit/runtime/context.py), and [admission](../runner/toolkit/nemo/runtime.py).

## Public call context does have an Endpoint boundary

Do not confuse shared compute with an ordinary client call-ID collision. [The public adapter](../runner/api.py) prefixes call IDs with the Endpoint:

```python
def _scoped_call_id(endpoint_id: str, call_id: str | None) -> str | None:
    if call_id is None: return None
    prefix = endpoint_id + ":"
    return call_id if call_id.startswith(prefix) else prefix + call_id
```

The runtime rejects a stored context whose Endpoint differs. Scan uses a new server-generated scan ID; Playground uses server-generated interaction IDs. Equal raw call IDs at two normal distinct Endpoints therefore do not demonstrate a cross-tenant collision.

A narrower deployment concern remains: [Redis keys](../runner/call_context.py) hash the scoped call ID but have no installation namespace:

```python
digest = hashlib.sha256(call_id.encode()).hexdigest()
return f"tasklattice:guard:call-context:{digest}"
```

Cloned installations with the same Endpoint IDs and overlapping gateway call IDs should not share one Redis database without an explicit namespace strategy. This is an infrastructure collision risk, not a demonstrated ordinary tenant data leak.

## Verification and interpretation

The companion [local test report](multi-tenancy-local-testing-2026-10-24.md) records actual executions, prerequisite failures, resource measurements, and untested areas. Existing automated coverage includes current authority, read-sharing, revocation, direct-ID denial, tenant model inventories, migration/backfill, caller-attributed logs/costs, cache clearing, and broad Runner permissions.

Some HTTP suites use real PostgreSQL and Better Auth but stub Runner control. Model/admission tests also use synthetic provider or Runner responses. Passing those tests does not establish live multi-tenant Runner fairness or production IdP behavior.

No confirmed new cross-tenant authorization exploit was established by this review. The clear result is an architectural coverage gap relative to a strong resource-isolation requirement.

## Proposed priorities if stronger isolation is required

These are proposed changes, not implemented functionality:

1. Restrict deployment-wide Runner mutation to platform operators; decide whether tenant users should retain deployment-wide operational reads.
2. Add a whole-Runner admission cap plus tenant quotas and fair, bounded queues. Attribute shared Guardrail calls to the invoking tenant rather than the Guardrail owner.
3. Define allowed tenant/Endpoint-to-pool assignments and enforce them in desired-state delivery and Endpoint authentication.
4. Scope Runner identities, credentials, model dependencies, and state to the chosen trust boundary. Separate Redis namespaces and recovery/telemetry storage where required.
5. Bound validation, preparation, preview, context, and model-call budgets per tenant. Metered costs alone are not an enforced spend budget.
6. Add adversarial A/B/C runtime tests: same raw call IDs at different Endpoints, foreign pool access, competing traffic, rollout failure containment, fair validation scheduling, and credential/dependency minimization.

For a lower-resource local demo, three tenants can share one Runner. Three Runners are not required to test logical API isolation, and adding them without these changes would not create tenant compute isolation.
