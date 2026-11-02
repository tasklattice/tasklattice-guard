# Actual tenant admission monitoring

The **Measured tenant admission** panel in `/settings/tenant-load-lab` reads real
Endpoint admission measurements independently of the optional traffic generator.
Its group cards and occupancy/wait charts use the current database placement:
A and B appear together when they belong to the same tenant group, while C
appears separately when assigned to another group. No placement is hardcoded.
Existing Guard traffic, policies, fake application LLM and client quota-simulation
controls retain their existing execution path.

## Measurement and authority flow

1. `TenantAdmissionMetrics` observes actual limiter state changes, admission
   outcomes and permit release. It maintains a bounded detached diagnostic
   snapshot alongside the existing Prometheus metrics. Occupancy is the number
   of held local Endpoint permits; Redis rate-admission waits count as held.
   Queue depth counts the local queue.
2. The Runner includes `tenant_admission_snapshot_json` in its authenticated
   control heartbeat. The payload contains configured tenant IDs, local capacity
   and tenant caps, six cumulative outcome counters, admitted-wait histograms,
   permit-held histograms and the process monotonic observation time. It contains
   no Endpoint credentials, request bodies or arbitrary metrics URLs.
3. The Controller first accepts the heartbeat using the durable Runner ID, boot,
   current control-session ID and increasing sequence. Only an accepted heartbeat
   updates the diagnostic store. Source pool identity comes from the accepted
   database registration, rather than from the JSON payload.
4. Before returning a view, the Controller reads a consistent allocation/session
   inventory under the allocation reader lock. Every source must match its
   current Runner/boot/session/pool, have a current undisconnected durable session
   and a recent report, and be neither offline nor synchronizing. Every reported
   tenant must currently belong to that pool's database tenant group. An invalid
   source makes the affected aggregate unavailable; partial sums are not shown
   as complete group occupancy.
5. `GET /api/v1/tenant-admission-monitor` requires an authenticated **admin**
   account and settings-read permission, returns `Cache-Control: no-store`, and
   optionally accepts one `poolId` source filter. Tenant accounts cannot query
   it. The browser polls this API and never receives metrics tokens or chooses
   an upstream metrics URL.

The snapshot itself is diagnostic data from trusted Runner code. Pool-scoped
control credentials provide the configured pool identity; the legacy shared
control credential retains its existing broader trust boundary. Monitoring does
not grant serving, allocation, fencing or telemetry-freshness authority.

## Counts, intervals and latency

Tenant capacity is the sum of configured local tenant caps on selected sources.
Group capacity is the sum of those sources' actual Endpoint permit capacities.
Tenant caps are limits and do not reserve otherwise shared group slots.

Attempts include admitted, queue-full, queue-timeout, rate-limited, cancelled
and unavailable outcomes. Rejected totals combine queue/rate/availability
denials; cancellations remain separate. Displayed totals belong to the current
Runner processes and are not durable historical billing totals.

Rates use cumulative counter differences over each source process's monotonic
observation interval. A first observation, process/session replacement, invalid
interval or counter reset yields unavailable rates. A valid interval with no
new events has a measured zero rate. Occupancy gauges can still be measured when
an interval rate is unavailable.

Admitted-wait p95 and permit-held p95 are explicitly **histogram estimates** from
valid bucket deltas, summed across selected sources' latest measured intervals.
They use fixed upper bounds of 1, 5, 10, 25, 50, 100, 250 and 500 milliseconds,
then 1, 2, 5, 10, 30 and 60 seconds, plus an open-ended bucket. No observations,
a reset or a p95 that falls in the open-ended bucket produces a gap. Charts do
not connect missing values. Wait covers admission to a permit; held time also
includes distributed rate checks, callback execution and cleanup. These are
separate from whole-application Input → LLM → Output latency.

Gauges are point observations at heartbeat cadence and can miss brief bursts.
The browser polls every five seconds; the Controller normally receives
heartbeats every ten seconds. Source freshness is three heartbeat intervals,
bounded between 15 and 120 seconds. Offline, stale, invalid and missing sources
show unavailable values rather than invented zeros. A failed browser refresh
also removes live-looking current values while retaining recorded chart history.

## Resource bounds and operational limits

- Each report is at most 64KiB and contains at most 64 configured tenants. Larger
  Runner configurations keep enforcing admission but explicitly refuse a partial
  monitoring map. Malformed, duplicate, inconsistent or unknown fields are
  rejected. Numeric ceilings keep bounded cross-source sums exactly integral.
- A Controller retains at most 32 current source records. Views support at most
  32 groups, 32 pools and 128 database tenants. Over-limit inventories are
  unavailable; selecting a source pool can narrow the view.
- At most four source-filter histories are retained, with 60 points per bounded
  entity. Inactive sources/filter caches expire after ten minutes. The monitor
  stores no database history and starts empty after Controller restart.
- Histories reset after allocation, tenant-name or source boot/session changes,
  so old measurements are not relabeled with new placement. With several
  Controllers, this view covers locally received heartbeats; sources reporting
  to another Controller remain unavailable here. A shared HA history merger is
  not implemented.

These are finite diagnostic storage bounds, not a claim that every possible
Runner/Controller workload fits a 2Gi Docker cluster. The tests exercise real
limiter observations, payload boundaries, API authorization, histogram/reset
handling and current PostgreSQL registration/session/group checks. They do not
deploy Runners or certify host-level CPU/memory isolation.
