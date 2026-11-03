# Opt-in Endpoint admission in one Runner process

An additional opt-in [distributed rate of admission starts](distributed-tenant-admission.md)
can share pool and tenant rate budgets across replicas. It is separate from the
local simultaneous-work caps described here and requires explicit Redis policy
provisioning; it does not create distributed concurrency guarantees.

`GUARD_RUNNER_TENANT_ADMISSION_ENABLED=true` enables local admission for external LiteLLM callbacks, Scan requests and output WebSocket streams. The default chart configuration leaves it off. The setting requires `GUARD_RUNNER_TENANT_ADMISSION_JSON` containing all five fields below; unknown or duplicate fields, invalid tenant IDs, non-integer capacities and unbounded timeouts are rejected at startup. Configuration supports 1–1,000 nonempty, unpadded valid UTF-8 tenant IDs of at most 256 characters each.

```json
{
  "capacity": 4,
  "tenant_limits": { "tenantA": 2, "tenantB": 2 },
  "max_queued": 8,
  "max_queued_per_tenant": 4,
  "queue_timeout_seconds": 0.25
}
```

This configuration is an administrator-controlled local process setting. It is not accepted from a request. Changing it requires restarting the Runner. Providing JSON while the enable flag is off is rejected rather than silently ignored.

Helm can render this same object from optional `runner.default.tenantAdmission`
or each `runner.pools[].tenantAdmission`. Object field names remain exactly as
shown in the JSON; a complete object enables that pool, while absence leaves it
off. Named pools do not inherit default-pool admission. Chart validation rejects
unknown/missing fields and invalid values before rollout. Helm never provisions
or resets a distributed rate policy.

The authenticated Endpoint's owner comes from the Controller-assigned desired-state snapshot. Request headers such as `X-Tenant` do not select a budget. The gate checks current serving authority and authenticates the Endpoint and its owner before queueing, then repeats those checks after obtaining a slot. Unknown, missing or changed ownership and missing tenant budgets fail closed with 503. Credential and adapter errors retain the existing adapter responses. A full queue or elapsed queue timeout returns 429 with `Retry-After: 1`; Scan preserves its structured error envelope. An overloaded or unavailable WebSocket admission is closed with code 1013 before acceptance, which a network client may observe as a failed handshake.

LiteLLM's FastAPI/Pydantic body parsing occurs before this route-level gate. A LiteLLM permit covers callback processing through telemetry and response construction, and is released before ASGI response serialization/network delivery. A Scan permit additionally covers its bounded body read and validation, then execution and response construction. A WebSocket permit covers the whole accepted stream through cleanup. `/verify`, health/metrics and Controller-owned internal work do not use this external-work quota. The existing Runner synchronization/lease middleware wraps queued and active requests and can cancel them on authority loss. Permits and queue entries are released on cooperative cancellation; ownership is rechecked after waits.

The limiter applies a total process cap and per-tenant hard caps, bounded queues, FIFO order within each tenant and round-robin selection among eligible tenants. These are caps rather than reserved capacity. A tenant whose cap fills all process slots can delay another tenant until work finishes. To leave room for B in the example, A's cap is lower than total process capacity. Neither queueing nor caps guarantee CPU, memory, latency, Provider quota or fault isolation.

Each Runner process, including each server worker, has its own limiter. Running two processes with this configuration can admit twice these counts. Group-wide limits require a distributed permit/lease coordinator or carefully partitioned budgets with enforced recovery and fencing; that work is not implemented here. The current implementation does not charge a complete application's Input → external LLM → Output pipeline as one permit: separate callbacks each acquire their own slot, and a stream acquires one slot for its own lifetime. Direct asynchronous/internal jobs and upstream Provider budgets remain separate controls. Client disconnects that do not cancel the handler may remain queued until the bounded timeout or may hold an active permit until the existing work timeout/cleanup; no instant disconnect-reclamation guarantee is made.

This protects honest traffic within the Runner's trust domain. A compromised Runner can ignore a local limiter, and tenants sharing a Runner pool still share its process and infrastructure. Use the deployment's stronger isolation tier for guarantees beyond those local controls.

## Measured admission monitoring

When local admission is enabled, the existing Runner Prometheus registry includes the following metrics. Labels come only from the configured, authenticated Endpoint owner set (at most 1,000 tenants); invalid or unknown owners never create metric series. Use the production metrics bearer token and restrict monitoring access to platform operators. The metrics endpoint includes all configured tenants for that Runner and is not a tenant-filtered API.

| Metric suffix after `guard_runner_tenant_admission_` | Meaning |
| --- | --- |
| `active{tenant_id}` | Actual locally held permits, including a pending Redis admission decision |
| `queued{tenant_id}` | Actual local queue depth |
| `limit{tenant_id}`, `capacity` | Configured per-tenant cap and total local cap |
| `attempts_total{tenant_id,outcome}` | Admitted, queue full, queue timeout, rate limited, cancelled or unavailable outcomes |
| `wait_seconds{tenant_id,outcome}` | Histogram from trusted owner resolution to admission outcome, including queue/Redis waits |
| `held_seconds{tenant_id}` | Histogram of permit lifetime, including Redis waits, callback execution/telemetry/cleanup or stream lifetime |

For example, `histogram_quantile(0.95, sum by (le, tenant_id) (rate(guard_runner_tenant_admission_wait_seconds_bucket{outcome="admitted"}[5m])))` shows admission wait p95. Retain the pool/deployment labels when aggregating across pools; sum active/queued counts across replicas but do not present the local cap as a distributed concurrency limit. The held-time histogram is not full application or network latency: separate input/output callbacks, the external LLM, pre-gate parsing and ASGI delivery have their documented boundaries. These metrics do not measure tenant CPU or memory. Missing scrapes or instrumentation failure mean unavailable evidence; observer errors are isolated so they cannot strand permits or interrupt queue dispatch.
