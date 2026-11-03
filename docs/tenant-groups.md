# Tenant groups and Runner allocation

Tenant Groups let a platform administrator place multiple tenants on a shared Runner pool while allocating different pools to different groups. Tenant ownership of Policies, Guardrails, Routers, Endpoints and logs still applies inside and across groups; a group is a compute-allocation boundary, not an implicit grant to read another tenant's resources.

```text
Tenant A ─┐
Tenant B ─┴─ Group blue ─ Pool blue ─ Runner blue-0, blue-1
Tenant C ─── Group green ─ Pool green ─ Runner green-0, green-1
```

Each tenant and each pool belongs to exactly one group. A group may contain multiple tenants and pools. Its Runners share capacity within that group; replicas of a pool serve the same group's traffic. The platform Controller, database, Redis, model configuration and provider infrastructure can still be shared between groups. Container CPU/memory requests and limits are configured by the deployment operator for each pool; group membership itself does not reserve an entire physical node or enforce per-tenant quotas.

The migration creates a protected `default` group and assigns existing tenants and Runner pools to it, preserving the previous shared allocation. Existing resources retain their tenant owners. Tenant users can read their group's Runner status; pool and group configuration are platform-administrator operations.

## Allocate a new group

1. Sign in as a platform administrator and open **Tenant Groups** under Platform operations.
2. Create a group. Register its Runner pool **before starting its Pods**, with a unique pool ID, an internal HTTP(S) runtime origin reachable from the Controller, and an optional public origin for integrations. Registering a pool records allocation and addresses; it does not provision or scale Kubernetes Pods.
3. Configure and deploy matching Runner Pods or a Helm `runner.pools` entry using exactly that pool ID. For the bundled chart, an extra pool named `blue` has an internal service named `<release>-runtime-blue` on port 8091. Use an internal DNS name appropriate to your installation. Expose and configure a public origin separately if clients run outside the cluster.
4. The existing assignment console is a legacy offline-allocation path. Stop and fence the old group's workloads before changing membership; an offline registration alone cannot prove that a partitioned/frozen workload stopped. Connected Runners prevent the update, and experimental serving grants or retained grant history conservatively prevent direct reassignment. Use the [safe move protocol](tenant-group-move-protocol.md) for its internal prepare/wait/fence-verified completion; production fence-provider/API/UI integration remains unfinished. Never delete grant history to bypass this restriction.
5. Check the group's pool status and endpoint setup URL. The pool receives its group's active Endpoints and eligible Guardrails, including Guardrails explicitly shared with those tenants. Sending another group's Endpoint credential to this pool must be rejected. Tenants in the same group intentionally share Runners and can contend for capacity.
6. Optionally open **Runtime Models** on the group to grant a validated runtime configuration, block active Model access, or explicitly retain platform defaults. These [group grants](group-model-configurations.md) govern configuration and future credential retrieval; delivered keys require separate rotation/fencing. Optional [group admission starts](group-rate-admission.md) and the [actual admission monitor](tenant-admission-monitor.md) add bounded controls and measurements without creating CPU/memory reservations.

Moving a pool similarly requires that pool's Runners to be offline; the default pool remains in the default group. Group membership and pool updates advance the desired-state generation and create an audit event. Creating, renaming or removing an empty group does not alter Runner state. A group cannot be deleted while it still owns a tenant or pool.

The current internal Runner selection uses the group's default pool when present; otherwise it selects the first registered pool by ID. Kubernetes Service load balancing distributes work among that pool's replicas. Registering multiple pools in a group does not currently provide cross-pool failover or balancing. Configure a shared Service or ingress if automatic balancing across multiple pools is needed.

An omitted public origin on a non-default pool falls back to its internal runtime origin in Endpoint setup. That URL is usable only where the address is reachable. Set the public origin before giving callback URLs to clients outside the cluster. Default-pool URLs inherit the existing Controller runtime configuration unless explicitly overridden.

## Runner synchronization and trust

A Runner must have a current Controller connection and an accepted group-scoped desired state before serving runtime or internal execution traffic. After a disconnect it becomes unavailable until it reconnects and synchronizes. This trades availability during a Controller outage for safer allocation changes; a restored last-known-good artifact store is retained but is not served until synchronization. Administrators must stop old-group Runners before reassignment and must not reuse stale Runner images that lack this fence.

The control-plane Runner token, mTLS deployment identity, Redis, Controller and databases remain platform-trusted and shared. Group assignment does not by itself provide a hostile-node security boundary, tenant-level network policy, separate cloud accounts, or physical CPU isolation. Operators should restrict network access to group Services and use appropriate Kubernetes and infrastructure isolation for their threat model. Last-known status is not proof that a partitioned or old-version Runner has stopped; drain and terminate its process before reallocating.

## Initial local verification — 2026-10-27

The following records the initial proof before the local lab was reassigned; the current grouping is described below.

The local `guard-tenants` kind cluster now has two live pools: `default` for the existing tenantA/B/C fixtures and `group-demo` for a new synthetic `group-demo-tenant`. The demo tenant has no human login; its synthetic Endpoint uses a distinct private credential and an explicitly shared, already published lab Guardrail. No existing tenant was moved. The demo Runner uses the same local artifact and executes real Input and Output guard checks.

The live check confirmed:

- All three existing tenant Endpoints authenticate on the default Runner; the demo Endpoint authenticates on the group-demo Runner.
- The default Runner rejects the demo Endpoint, and the demo Runner rejects the default group's Endpoint, both with HTTP 401.
- Input and Output checks returned HTTP 200 on their respective real Runner Pods.
- Tenant A can see its group's Runner pool, cannot see the demo pool, and receives HTTP 403 when attempting to modify Runner capacity.
- During the Controller restart, the upgraded default Runner became unready and its runtime returned unavailable until it reconnected and applied current state.

Both Runner Pods were ready without new restarts. An idle snapshot with both pools showed approximately 1.35 GiB of the 1.925 GiB Docker VM in use; one CPU remains shared, so this is not a production sizing or high-load guarantee. The previous Tenant Load Lab remains a shared-Runner experiment and was paused during this rollout; it does not generate traffic for the new demo group.

The local group demo is opt-in state outside Helm: its Deployment/Service-equivalent StatefulSet and Services are recorded in `.local-secrets/tenant-runtime-20261026/tenant-group-demo-manifest.json`, and the fixture credential is in `group-demo-fixture.json` under that private directory. The latter must remain private. The local Runner and Controller use the `dev-tenant-groups` and `dev-tenant-groups-v2` images respectively. A Helm upgrade may replace the patched default image; ensure the Controller and every Runner are upgraded together, with Runner fencing available before changing membership.

Inspect the pools with the private kubeconfig:

```bash
kubectl --kubeconfig .local-secrets/tenant-runtime-20261026/kubeconfig \
  -n tali get pods -l app.kubernetes.io/component=runner \
  -L tasklattice.io/runner-pool
```

The verification used 17 PostgreSQL migration/allocation cases, Controller authorization and routing tests, UI tests, and Runner synchronization and regression tests. The [control-plane allocation tests](../controller/server/services/tenant-groups.postgres.test.ts) include actual cross-group desired-state filtering and shared-Guardrail revocation; the [live verification record](../.local-secrets/tenant-runtime-20261026/group-live-verification.json) contains statuses but no Endpoint key.

## API

Platform-admin APIs include `GET/POST /api/v1/tenant-groups`, `PATCH/DELETE /api/v1/tenant-groups/:id`, `GET /api/v1/tenants`, `PUT /api/v1/tenants/:id/group`, `POST /api/v1/tenant-groups/:id/pools`, and `PUT /api/v1/runner-pools/:id/group` or `/connectivity`. Assignment requests carry `{ "groupId": "…", "expectedGroupId": "…" }`. Pool creation carries its ID, name, `runtimeUrl`, and optional `publicUrl`.

See the generated OpenAPI contract for request/response schemas and the [previous isolation audit](multi-tenancy-isolation-audit-2026-10-24.md) for the state before group allocation. The [load lab](tenant-load-lab.md) now supports separate Runner pools and an optional client-side quota simulation.

## Current local lab allocation

The retained lab assigns tenantA and tenantB to the `default` group and Runner pool; tenantC belongs to `group-demo` and uses the separate `group-demo` Runner pool. The lab sends each tenant to its configured pool, reports measured Runner metrics separately, and verifies configured pool membership against Controller before starting traffic or a peak. TenantC retains ownership of the common lab Guardrail and explicitly shares it with A and B. This is group-level Runner allocation, not dedicated CPU or isolation from the single local node and shared dependencies.

## Pool-scoped authentication and Model authority — 2 November source status

The Controller can be configured with the optional private environment variable `CONTROLLER_RUNNER_POOL_TOKENS_JSON`, a JSON object mapping each registered pool ID to a distinct, at least 32-character token. If present, the gRPC control stream accepts only a matching pool token and rejects the legacy bearer, unconfigured tokens, and registrations claiming another pool. The model-credential endpoint also accepts only pool tokens in this mode, and candidate validation credential leases are bound to the selected Runner's pool before dispatch. The map is validated at startup, and tokens must be distinct from one another and the legacy Controller token. The Runner uses its pool token for the control stream and model-credential requests through `GUARD_RUNNER_CONTROL_TOKEN`; if unset it retains legacy behavior. Generate high-entropy tokens using a cryptographically secure random source; the length check alone does not guarantee adequate entropy. Treat both variables as secrets and provision them through a secret manager, not a chart values file or command-line argument.

Separate per-pool Controller-to-Runner HTTP credentials, scoped telemetry identity,
and Helm Secret references are now implemented. A fully scoped composition can
omit the legacy Runner secret when every required role is configured. Active
Model configuration and credential resolution can use explicit immutable group
grants, or explicit blocked/legacy modes. Draining prevents future configuration
and active credential retrieval. These source changes have not been enabled in
the retained demonstration. Read [HTTP pool credentials](runner-http-pool-credentials.md)
and [group Model grants](group-model-configurations.md) before rollout.

This is **not a complete group security boundary**. Pool credentials remain shared
among that pool's workloads, and previously delivered keys cannot be recalled.
Rotation requires coordinated Controller/Runner restart; automatic live token
reload is not implemented. Enable maps only after provisioning all required
private role tokens and preparing a coherent rollout; old Runners cannot
register or resolve credentials once scoped authentication is enabled. Leaving
the maps unset preserves legacy behavior and its broader trust boundary. Network,
node, database, Redis and Provider isolation require their own controls.

Guardrail and Endpoint deletion checks consider all relevant incoming events and all affected Runner pools, including events with unknown ownership. Tenant-facing counts and last-request times show only that tenant's attributed events and Routers; pool telemetry watermarks are hidden. The safety booleans remain global: a confirmation requirement can reveal that some recent traffic exists outside the visible count, and a stale-telemetry result can reveal that the overall check is not fresh. These signals are necessary to avoid silently allowing unsafe deletion. Platform administrators see the global aggregate. Audit records retain the safety decision without global traffic counts or timestamps.
