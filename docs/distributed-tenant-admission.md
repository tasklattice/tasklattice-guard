# Distributed tenant admission

The implemented opt-in stage adds a Redis sliding-window **rate of admission
starts**, shared by Runner processes and replicas of one trusted pool. Defaults
are off. It does not reserve capacity or impose a distributed simultaneous-work
limit. Local caps remain described in [tenant-admission.md](tenant-admission.md).

This document describes v1 pool-scoped policy. Separate opt-in
[v2 group admission](group-rate-admission.md) now provides group totals, tenant
totals across member pools and pool totals in one atomic decision. v1 and v2
cannot be co-enabled on one Runner.

## Exact quota scopes and units

| Mechanism | Identity and scope | Unit | Consistency boundary |
| --- | --- | --- | --- |
| Existing local admission | Authenticated Endpoint tenant in one Runner process | Active HTTP callback/Scan request/WebSocket stream | One event loop and bounded queue |
| New tenant rate | `(trusted pool ID, authenticated tenant ID)` across participating replicas | Redis admissions per rolling `window_ms` | One authoritative Redis primary and intact history |
| New pool rate | Trusted Runner pool ID across participating replicas | Admissions in the same rolling window | Same atomic decision as tenant rate |
| Tenant group aggregate | Available through separate v2 policy | Admission starts | Controller group/epoch plus one group Redis authority |
| Tenant rate across pools | Available within one group through v2; v1 remains pool-scoped | Admission starts | No global cross-group tenant guarantee |
| Distributed concurrency/reservation | Not implemented | None | Requires further worker fencing and lifecycle work |

The Runner uses its configured pool and the Controller snapshot's authenticated
Endpoint owner. Client tenant headers/query/body fields cannot select a budget.
Pool authentication and Controller snapshot/allocation correctness remain
prerequisites; this gate does not consult the Controller on every request.

One LiteLLM input or output callback consumes one start; the two callbacks of an
application interaction consume separate starts. One Scan request consumes one
start before bounded body parsing. One WebSocket admission consumes one start
before accept; frames do not consume additional starts. Invalid Scan bodies,
clients that never send a WebSocket start frame, failures and cancellations can
consume starts. `/verify`, internal APIs, health and metrics are excluded.

These are **admission timestamps**, not actual execution-start timestamps. A
delayed network reply can postpone execution after Redis recorded a grant. The
quota does not prove an identical bound on actual execution starts in each
wall-clock interval. Long executions/streams can outlive their window, so active
work can exceed the rate limit. Local concurrency caps apply separately.

## Configuration and explicit provisioning

Distributed admission requires existing local admission, a pool control token,
and `GUARD_RUNNER_CALL_CONTEXT_REDIS_URL`. A separate asynchronous Redis client
uses that URL; it does not block the event loop with synchronous Redis calls.

```sh
GUARD_RUNNER_DISTRIBUTED_RATE_ENABLED=true
GUARD_RUNNER_DISTRIBUTED_RATE_JSON='{"pool_id":"group-ab","revision":"v1","window_ms":1000,"pool_limit":20,"tenant_limits":{"tenantA":12,"tenantB":12}}'
```

JSON must contain exactly those five fields, with no duplicate keys. IDs and
revision must be nonempty, unpadded valid UTF-8 strings, at most 256 characters.
The window is an integer 100–86,400,000 ms; limits are integers 1–100,000, never
bools; there are 1–1,000 tenants. The pool must match `GUARD_RUNNER_POOL_ID` and the
tenant-ID set must exactly match local admission. JSON supplied with the flag off
fails startup. Every replica must match the provisioned policy, including its
revision. Requests never overwrite policy. Per-tenant retained-history bounds
also have a strict aggregate cap described below.

Helm accepts optional complete `runner.default.tenantAdmission` and
`runner.default.distributedRateAdmission` objects, or those same fields on each
`runner.pools[]` entry. Fields inside each object use the exact snake_case JSON
names above and in the local admission document. Presence renders the matching
`*_ENABLED=true` and `*_JSON` environment variables; absence leaves them off.
There is no inheritance from the default pool to named pools. Chart schema and
helpers reject unknown/incomplete/invalid policy, pool/tenant mismatches and
excessive history bounds before deployment.

Chart distributed mode additionally requires
`security.poolAuthentication.enabled=true` with all normal Secret references and
an explicit `runner.callContextRedisUrl`. It rejects bundled ephemeral
`redis.enabled=true`, even for one-replica pools. An external URL is an operator
declaration, not proof of persistence/failover safety; the assumptions below still
apply. Helm neither initializes nor replaces Redis policy. No test-only bypass
or automatic provisioning Job is supplied.

Provision the identical JSON once with an operator identity:

```sh
python -m runner.distributed_rate_admission provision --policy /path/to/rate-policy.json
```

The existing Redis URL environment variable supplies credentials. Do not place
them in the command line/policy. The command never prints the URL. **Startup and
request handlers never provision state.** The command refuses any existing
policy/counter key and cannot replace policy, reset history or repair partial
state. Failure can leave partial state, which remains unauthorized. Rerunning
cannot overwrite it. No administrative hot update/reset API is implemented.

Policy change/recovery requires external operator coordination: stop/fence all
participating Runners, settle in-flight work, inspect/reconcile state, and wait
at least the prior complete window after the last possible old admission before
deliberately provisioning new history. Partitions and old processes need
external fencing; restarting processes alone does not prove old ones stopped.
There is no automated safe policy transition or full-budget reset.

## Atomic decision and failure behavior

`runner/distributed_rate_admission.py` contains the Lua scripts/client. Hashed
pool IDs form Redis Cluster hash tags so all policy/history keys for one pool
share a slot; hashed tenant IDs cannot inject key names/hash tags. One `EVAL`:

1. Checks policy type and exact canonical policy digest.
2. Requires no TTL on the policy and both applicable history keys.
3. Requires initialized sorted sets, their sentinel, and no other negative scores.
4. Uses Redis `TIME` and refuses a backward movement relative to the stored clock.
5. Prunes timestamps at/before `now - window_ms`, checks **both** counts, then
   inserts one unique attempt ID into both histories only if both have room.

The effective window is `(now - window_ms, now]` in integer Redis milliseconds.
Full budgets consume neither start and return rounded-up `Retry-After`. Requests
are serialized by one primary. Missing/unprovisioned policy, unknown tenant,
digest mismatch, eviction/deletion, TTL, malformed keys/sentinel, detected clock
regression, permission error, Redis outage or timeout fails closed. HTTP returns
the existing generic admission 503; exhaustion returns 429. Scan keeps its error
envelope; WebSocket rejects before accept with 1013. Existing auth/adapter checks
run first and retain their errors.

The order is local permit/queue, authenticated owner recheck, Redis charge, then
another owner/credential/serving-authority recheck. An ownership/lease change or
cancellation during the Redis wait prevents execution and releases the local
permit. Local queued requests have not consumed a distributed start. Once
recorded, a distributed start is never refunded after failure/cancellation.

Connection/socket timeouts are one second, with an outer two-second bound and
at most 32 Redis connections per process for this client. Automatic retries are
disabled. If a charge commits but its reply is lost, the request fails without
execution; its start remains consumed. No uncertain grant is reused. Lua errors
do not roll back writes; partial charges can conservatively reduce throughput
while the request fails. Redis state must remain authoritative and intact for
the stated aggregate bound.

There is no distributed queue or fairness guarantee: exhaustion rejects after
the local gate. Local bounded FIFO/round-robin scheduling is process-local.
Replicas/tenants can race for pool starts. A busy tenant is bounded by its rate
cap, but neither rate nor local cap is a capacity reservation.

## Memory, clocks, failover and trust

History keys have **no TTL**. A sentinel distinguishes initialized empty history
from a missing/evicted key. Missing state is never interpreted as zero or silently
initialized. Normal window progression expires old timestamps inside intact
state; state loss never automatically restores a full budget.

Only the currently accessed tenant history is pruned; inactive tenants can keep
old bounded histories indefinitely. Pool history holds at most `pool_limit`
starts; each tenant holds at most `min(tenant_limit, pool_limit)`. Configuration
requires the sum of those tenant bounds to be at most 100,000. Thus each pool
retains at most 200,000 start entries plus sentinels/policy. This is an entry
bound, not a byte-memory guarantee. Account for Redis allocator overhead, all
pools, call contexts, logs and other users; choose lower limits locally. This
stage changes no Redis memory/eviction setting and is not enabled in the demo.

Safety assumes one correct authoritative primary, intact history, matching
policy on every participating Runner and suitable clock behavior. Redis `TIME`
avoids disagreements between Runner clocks. Detected backward movement refuses
admission until the clock catches up or operators reconcile. Forward jumps can
prune early relative to elapsed real time. Failover, asynchronous-replication
rollback, snapshot restore or partial data loss can remove starts while retaining
markers/digest; that is not generally detectable. Split brain/independent
primaries can over-admit. Cluster slot placement does not fix these issues.

There is no unconditional guarantee across Redis failover/data rollback or
arbitrary clock changes. Use an explicit persistence/failover policy or an
external failover gate that stops serving and reconciles before resuming. A
healthy Redis connection cannot prove complete history.

The client targets one Redis authority and does not implement Redis Cluster
routing. Hash tags prepare compatible key placement, rather than certify a
Cluster/failover deployment.

Runtime commands include EVAL and TYPE, PTTL, HGET/HSET, TIME, ZSCORE/ZCOUNT/ZCARD,
ZRANGE, ZREMRANGEBYSCORE and ZADD. Provisioning additionally uses EXISTS/HDEL and
creates initial keys. `RedisRateAdmission.state_keys` exposes exact keys for
administration. Use per-pool Redis ACL key patterns/network identities for
compromised-Runner isolation. Broad shared Redis credentials can modify other
pools' history or invoke provisioning outside this application. A pool-scoped
writer can still tamper with its own history. The shared URL supplies no
per-pool ACL by itself; account for separate call-context/log commands if using
ACLs. This change provisions no credentials/ACLs and does not create a security
boundary against compromised Runners.

## Remaining distributed concurrency design

An expiring Redis semaphore cannot safely represent running work: a paused or
partitioned Runner may keep executing after a permit expires and another Runner
reclaims it. Full support needs durable unique permits, authoritative group
identity/policy, bounded distributed scheduling, renewal/cancellation/revocation,
and worker fencing before doing work. Renewals alone cannot supply fencing.
External LLM/tool side effects may not be cancelable/rollbackable; the design must
define whether lost workers remain charged, drain, or are forcibly isolated
before replacement. Safe moves/epoch transitions remain prerequisites for broader
reservation claims. This rate stage creates no concurrency leases and makes no
CPU, memory, provider-capacity or latency guarantee.

The existing parsing boundary also applies: FastAPI/Pydantic parses LiteLLM
requests before admission; Scan bounds body parsing and WebSocket holds its
local permit for the stream. Transport memory/pre-route parsing need other
controls.

## Verification

`tests/data_plane/test_distributed_rate_admission.py` covers strict policy,
fail-closed responses, cancellation and post-Redis owner/credential/authority
rechecks. With `GUARD_TEST_REDIS_URL` it verifies real two-client tenant/pool
contention, no charge on denial, rolling windows, concurrent work outliving a
window, missing/TTL/wrong-type/corrupt state, policy mismatch, backward-clock
detection, conservative lost replies, cancellation after charge and two Runner
HTTP APIs sharing the budget. It deletes only randomly named test pool keys;
there is no FLUSHDB. Existing Endpoint tests cover HTTP/Scan/WebSocket errors,
forged headers, Retry-After and local-permit release. These tests do not prove
production failover behavior, CPU/memory isolation or an unconfigured ACL setup.
