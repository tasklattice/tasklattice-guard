# Group-wide distributed admission starts

The optional v2 policy adds one rate budget across every participating pool and
replica of a Controller Tenant Group. Each accepted request atomically consumes
three histories: group total, tenant total across those pools, and selected pool
total. It remains a **rate of admission starts**, not distributed concurrency,
capacity reservation or physical resource isolation. Defaults are off; the demo
was not enabled with this policy.

The existing [v1 pool policy](distributed-tenant-admission.md) remains supported
unchanged when v2 is absent. v1 and v2 cannot be enabled together on one Runner:
v2 already contains the pool budget, and independently charging two policies
would not provide one atomic hierarchical decision.

## Identity from Controller snapshots

`DesiredState.allocation_group_id` is optional protocol field 12. The Controller
projects the actual pool group and its epoch under the allocation transaction.
Immediately before dispatch it compares that projection with the durable
challenged dispatch allocation. A changed group or epoch suppresses dispatch;
neither field comes from client headers or Runner policy configuration.

ArtifactStore persists both values inside the same protobuf snapshot and
publishes them atomically with authenticated Endpoint owners/routes/artifacts.
`authenticated_endpoint_allocation` reads credential validity, tenant, group,
epoch and generation under one store lock. Legacy snapshots without group or
epoch provide no v2 authority; missing fields never default to a group or epoch 0.

In v2 mode the control client fences serving before applying a new snapshot.
It requires the challenged Controller group and local pool epoch to match the
explicit policy. A missing/mismatched snapshot cannot leave the old allocation
serving merely because it was last-known-good. Delayed WAL uploads retain their
current-session authorization during a snapshot refresh; disconnect/reconnect
still clears it. This is independent of whether serving itself is permitted.

The external Endpoint gate then:

1. Requires current serving synchronization/optional lease authority and
   authenticates the Endpoint owner.
2. Captures its Controller group/epoch/generation and validates group/tenant/pool
   policy before joining the bounded local queue.
3. Rechecks the same authenticated allocation after obtaining a local permit.
4. Calls the one atomic Redis v2 decision for those identities.
5. Rechecks serving authority, credentials and the exact allocation after Redis
   returns, before handing the local permit to execution.

An allocation change while queued or awaiting Redis fails closed. A consumed
start is retained when a later check/cancellation prevents execution; the local
permit is released. `X-Group-ID`, `X-Tenant-Group`, tenant headers and request
parameters cannot choose another Redis group or pool budget.

These are current **accepted local Controller snapshots**, not a synchronous
database lookup on each Endpoint request. Control partitions, suspended processes,
mixed versions and allocation moves still require the documented lease/fencing
and rollout assumptions. This mechanism does not make a stale/uncooperative
Runner trustworthy or certify safe physical moves by itself.

## Explicit v2 policy

The exact complete JSON fields are:

```json
{
  "group_id": "actual-controller-group-id",
  "revision": "v2-example-1",
  "window_ms": 1000,
  "group_limit": 12,
  "tenant_limits": {"tenantA": 8, "tenantB": 8},
  "pool_limits": {"pool-ab-1": 7, "pool-ab-2": 7},
  "pool_epochs": {"pool-ab-1": 0, "pool-ab-2": 0}
}
```

Use actual Controller IDs and epochs, not display names or an assumed epoch 0.
Every participating pool/replica uses the **same complete policy**, including
revision and all member pool epochs. The trusted Runner pool must appear in it;
all locally configured admission tenants must be included. Local tenant subsets
are allowed, but an Endpoint lacking a local budget still fails closed.

Enable `GUARD_RUNNER_GROUP_RATE_ENABLED=true` and supply
`GUARD_RUNNER_GROUP_RATE_JSON`. Existing local admission, Redis URL and pool
control authentication are required. Supplying JSON with the flag off is an
error. A v1 policy plus v2 flag is an error. Startup also validates programmatic
settings, so it cannot silently skip a configured group gate.

Unknown/duplicate fields and invalid identities fail startup. IDs/revision are
nonempty, unpadded valid UTF-8 strings of at most 256 characters. The window is an
integer 100–86,400,000 ms. Limits are integers 1–100,000, never booleans. Tenant and
pool maps each contain 1–1,000 entries; `pool_epochs` has exactly the pool-limit
keys and nonnegative safe-integer values. Each sum of `min(limit, group_limit)`
for tenant and pool histories is at most 100,000 entries.

Helm exposes optional `groupRateAdmission` on `runner.default` or an individual
`runner.pools[]` entry. It does not infer authority or provision Redis. Supply
the same JSON-shaped fields, complete local admission, pool authentication and
the required external Redis configuration. Defaults remain absent/off.

Chart-known member pools must carry identical complete policies. Remote pool IDs
can be declared for an operator-controlled multi-release rollout; the chart
cannot prove their deployment or their Controller allocation. Every routable
participant must actually run v2. Old/disabled/nonparticipating processes can
bypass this quota if traffic can still reach them. A Redis policy does not
automatically enable quota enforcement on other workloads.

## Provisioning and changes

Provision once with an operator Redis identity:

```sh
python -m runner.group_rate_admission provision --policy /path/to/group-rate-policy.json
```

The URL/credentials come from `GUARD_RUNNER_CALL_CONTEXT_REDIS_URL`, not the
command line or policy. The command checks that every group policy/counter key
is absent before creating state and refuses any existing/partial state. Startup
and request paths never create missing counters, overwrite policy or refill a
lost history. v2 uses a separate namespace; no v1 conversion/reset is automatic.

An epoch/membership/policy revision change needs explicit coordinated drain and
reconciliation across **all** participating pools. Stop/fence old policy writers,
settle work, preserve evidence and wait at least the prior full rate window after
the last possible old admission before deliberately establishing a new history.
Do not change one pool's JSON and expect it to replace group policy. A mismatched
policy or Controller epoch intentionally refuses traffic. A hot update/reset
workflow and distributed reservations are not implemented here.

## Redis algorithm and bounds

The v2 prefix is `tasklattice:guard:rate:v2:{SHA256(group_id)}`. Policy, group,
tenant and pool keys share the same hash slot; tenant/pool IDs are also hashed.
The client targets one Redis authority and does not implement Cluster routing.

One Lua script validates the exact policy digest, persistent key types/sentinels,
absence of TTL and non-regressing Redis time. It prunes timestamps at or before
`now - window_ms`, checks all three counts, and only then adds the same unique
attempt to all three histories. The rolling interval is `(now - window, now]`.
Denial consumes none of them. Exhaustion returns429/Retry-After; missing,
mismatched, evicted or malformed state and Redis failure return503. Scan retains
its envelope and WebSocket uses the shared pre-accept 1013 rejection behavior.

Socket/connect limits are one second, with an outer two-second deadline and at
most 32 client connections per process. Automatic retries are disabled. A lost
reply can leave a consumed start while the request fails; it is never refunded
or reused. Cancellation releases only the local permit. There is no distributed
queue or fairness/reservation promise.

Group history holds at most the group limit; each tenant/pool history holds at
most the smaller of its own limit and the group limit. Configuration bounds
retained starts to at most 300,000 entries per group plus sentinels/policy. Inactive
tenant/pool histories retain their bounded old entries until accessed. This is
an entry bound, not a Redis byte-memory guarantee; account for all groups and
other Redis consumers in a constrained environment.

No TTL is used to reclaim execution permits. Long work can outlive its rate
window while a different pool receives another admission: that is expected and
tested. LiteLLM input/output callbacks count separately, Scan counts its admitted
request, and WebSocket counts admission once. See v1/local documentation for
parsing boundaries, internal/verify exclusions and per-process work caps.

## Trust and operational limits

All member pools of a Tenant Group share this quota trust domain. A compromised
Runner with broad shared Redis credentials can tamper with histories; an honest
gate and pool bearer are not infrastructure attestation. Use suitable group/key
ACLs and network identities where stronger boundaries are required. No ACL or
credential is provisioned by this feature.

The aggregate bound assumes one authoritative Redis primary, intact history,
matching policy on every participant and suitable clock behavior. Redis time
avoids Runner clock disagreements; detected backward movement fails closed.
Forward jumps, asynchronous-replication rollback, snapshot restore, split brain
or partial loss preserving sentinels can defeat a real-time bound. External
failover gating/durability policy remains necessary. No CPU, memory, latency,
Provider-capacity or distributed concurrency guarantee follows from this rate.

## Verification

`test_group_rate_admission.py` covers strict policies/settings, real two-client
two-pool group/tenant/pool caps, an independent group, denial without spending
other budgets, missing/mismatched state, forged group headers, allocation changes,
Redis outage/lost reply, cancellation and work outliving a rate window. It uses
random test-owned keys and never flushes Redis. Store tests restore the exact
group/epoch and preserve old metadata on rejection. Controller tests suppress
stale group/epoch dispatches. These tests do not certify a live quota rollout or
external fencing deployment.
