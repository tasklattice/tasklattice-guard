# TaskLattice Guard observability

The production observation path is the same hierarchy a GuardRail owner uses:

```text
GuardRail -> Endpoint -> Runner -> completed check
                                  -> allow | deny | transform | technical error
                                  -> Action -> Model RPC
```

Controller topology metrics populate the selectors even when a valid resource
has never received traffic. Runner request metrics supply business outcomes and
latency. Platform signals explain a degraded business SLI; they are not the
primary Overview navigation model.

Controller `/metrics` caches database-backed topology and capacity gauges for
10 seconds and merges concurrent snapshot requests into one collection job. A
scrape waits at most 50 ms for that job, then returns process counters and current
connection-pool state even if the database is unavailable. Failed collections
clear database-derived gauges and back off for 10 seconds. The snapshot freshness,
last-success timestamp and in-flight gauge distinguish unavailable or stale data
from current zero values; the ServiceMonitor interval is independently configurable.

Security Events use `/api/v1/telemetry/security-events`: 25 individual findings
per page by default, or 50. Time/severity filters precede the SQL item limit. A
cursor preserves the occurrence/ingestion boundary and the full filter scope;
statistics load independently through `/api/v1/telemetry/metrics`.

## OpenTelemetry Collector outages

OTLP trace export runs on a background batch worker. The official exporter keeps
its standard endpoint, headers, TLS, timeout and bounded per-batch retry behavior.
After a failed batch, the Runner backs off across subsequent batches: initially
30 seconds, then 60, 120 and 240 seconds, capped at 5 minutes. A 20% jitter
spreads retry attempts across Runners; the maximum wait remains 5 minutes.
The next batch after the cooldown probes the Collector. No requests or retry
timers run during cooldown, and successful delivery resets the backoff.

Each continuous outage produces one ERROR, with no repeated SDK retry logs.
Recovery produces an INFO; a later outage can produce a new ERROR. Cooldown
batches and failed batches are dropped, so traces from the outage are incomplete
and are not replayed. Guard checks continue normally. This policy only applies
to OpenTelemetry traces; durable Controller telemetry and its WAL delivery keep
their existing retry and persistence behavior.

## Controller report persistence diagnostics

GuardRail and Policy report saves emit one JSON object per line to Controller
stdout/stderr, with `event="validation.report_save"`. Search by `runId`, then
group by `attemptId`: retries of one run receive distinct attempt IDs. Delegation
from the control plane into Policy persistence keeps the same attempt ID. These
are application logs, not additional OpenTelemetry spans.

Every stage emits `started` before doing work, followed by `succeeded` or
`failed`. `durationMs` measures that stage; `elapsedMs` measures time since the
save began. Timings use a monotonic clock. Stages can be nested, so their
durations must not be added together. A stage with only `started` identifies
work that had not finished when logging stopped; it does not prove a timeout.

The stages distinguish initial run lookup, `pool_acquire`, `begin`, transaction
timeout setup, `lock_guardrail` / `lock_run` / `lock_parent_run`, candidate
request loading and normalization/digest validation, scope validation,
`write_report`, `complete_outbox`, `write_audit`, `prune_history` (GuardRail) or
`aggregate_policy_results` (Policy), `commit` / `rollback`, and `pool_release`.
The outer `save` succeeds only after persistence returns, including transaction
completion and connection release when a transaction was needed. A successful
write stage alone does not prove the transaction committed. Duplicate or
already-deleted runs can finish as successful no-ops.

Each entry carries a numeric pool snapshot, without issuing another DB query:

| Field | Meaning |
| --- | --- |
| `pool.max` | Configured pool connection limit |
| `pool.total` | Connections currently tracked by the pool |
| `pool.idle` | Connections available for reuse |
| `pool.busy` | `total - idle`; includes connections being established |
| `pool.waiting` | Requests queued for a connection at this instant |

`pool: null` means counters are unavailable, not an empty pool. A timed-out
acquisition leaves the wait queue before its failure is logged, so `waiting: 0`
on that entry does not rule out pool exhaustion. These are event snapshots,
not continuous pool metrics.

Failures extract only allowlisted fields from the error/cause chain:
`error.code`, `error.sqlState`, and a fixed `error.category`. SQLSTATEs include
`55P03` (lock unavailable, including lock timeout), `57014` (query cancellation, including statement timeout),
`40P01` (deadlock), `53300` (too many connections), and `25P03` (idle transaction
timeout). Recognized network codes such as `ECONNRESET` are preserved with
`sqlState: null`. The driver's code-less pool wait and connection establishment
timeouts become `pool_acquire_timeout` and `connection_timeout`; no code is
invented. Other uncoded errors have category `unknown`.

For an incident, find the first failed stage in an attempt, then compare its
pool snapshot and error with preceding stages. A `lock_guardrail` failure with
`55P03` shows lock contention; `pool_acquire_timeout` with all connections busy
shows that the caller could not obtain a connection, but does not by itself
identify which other operation held them. Later rollback/save/transport errors
can describe consequences of the same initial failure.

Idle pool failures, checked-out transaction connection failures, periodic jobs, Runner disconnect/control failures and
unexpected HTTP errors use the same safe error fields and pool snapshots under
`database.pool_idle_error`, `database.transaction_connection_error`, `controller.background_error`,
`runner.disconnect_error`, `runner.control_error`, `runner.reconcile_error`, and `controller.http_error`.
HTTP diagnostics use the route template, not query strings or raw request
paths. Report bodies, candidate configuration, SQL/parameters, raw error
messages/stacks/details, connection URLs, tokens and credentials are excluded.
The gRPC error response also uses a fixed message with only the safe error
code/category, so a Runner cannot echo Drizzle's SQL parameters into its logs.

## Database pool audit (2026-10-30)

Scope: Controller runtime entry points, the installed pg/pg-pool/Drizzle code,
70 transaction call sites (including the adapter), transaction helper calls,
background scheduling, shutdown, metrics and Helm probes. Fault injection ran
against a disposable PostgreSQL 17 database. No deployed cluster was queried;
its actual connection counts, PostgreSQL role settings, restarts and resource
pressure remain unknown.

Validation: the server build, OpenAPI consistency check, 277 targeted regression
tests and 116 offline Helm tests passed. Coverage includes real database faults,
report persistence, chunk replay, Runner concurrency/draining, metrics outages,
authentication and bootstrap. All 55 migrations also succeeded on a fresh
temporary database and on an idempotent rerun. Migration checkouts are discarded
(`total=0`) after their extended budget is used; the next ordinary checkout
restores its configured session limits (`total=1, idle=1, waiting=0` in the
one-connection regression pool).

### Ownership and effective defaults

The main process creates one shared pool. Authentication, API requests, Runner
control, telemetry, report persistence, observability reads and bootstrap
account synchronization all use it. There is no per-request pool creation in
these paths. Migration/bootstrap CLI processes create and close their own
pools; the startup wait script closes each temporary Client in `finally`.

| Setting | Application/installed driver default | Scope |
| --- | --- | --- |
| Maximum connections | 20, or 2 in test mode | Per process, created on demand |
| Minimum connections | 0 | Does not prewarm connections |
| Acquisition/connection timeout | 5,000 ms | Does not limit SQL execution |
| Idle connection eviction | 10,000 ms | Only connections returned to the pool |
| Maximum connection lifetime | 0 (disabled) | No age-based rotation |
| General statement/lock/idle-transaction limits | 30 s / 5 s / 30 s | Set on every new pooled connection; configurable as below |
| Migration statement/lock/idle-transaction limits | 300 s / 30 s / 30 s | Separate checkout, destroyed after migration success or failure |
| Report/progress writes | 2 s lock, 30 s statement, 30 s idle transaction | Transaction-local settings |
| Observability reads | 20 s budget by default | `boundedRead`; recalculates remaining statement budget through its `execute` helper |

There is no general application-wide transaction deadline or acquisition queue
length limit. A statement limit is not a transaction-total limit: many short
statements can hold a connection for much longer. `boundedRead` callbacks that
use `tx` directly inherit the last statement timeout but do not recompute the
remaining budget for each subsequent statement. All these limits depend on
server responsiveness; an unresponsive network is a separate failure mode.

Ordinary Drizzle queries use `pool.query`, whose installed implementation
releases its checkout on completion/error. Explicit transactions use the
central adapter's `finally` release. Nested `tx.transaction` uses the same
connection and savepoints. Reviewed service helper calls pass `tx`/`db` through
the catalog, policy, routing and pricing paths; no additional confirmed path
was found that holds a transaction while acquiring a second global connection.
That static result is not proof that all production workloads are contention-free.

### Confirmed defects and current fixes

- **BEGIN/ROLLBACK ownership, including migrations:** the installed Drizzle implementation starts
  BEGIN before its `try/finally`. The adapter owns the checkout across BEGIN
  failure and destroys connections left in a transaction after rollback failure.
  The migrator calls `session.transaction` directly, bypassing a public
  `db.transaction` override. `runMigrations` now uses the same protected
  `withDatabaseConnection` checkout as business transactions, including its
  metadata queries and internal transaction. Migration BEGIN failure also
  releases the connection in the PostgreSQL regression test.
- **Fatal errors on checked-out connections:** pg-pool removes its idle error
  listener when a connection is acquired. A backend termination between SQL
  statements previously killed a real child process with an unhandled `error`
  event. Each transaction now installs its own listener, captures safe report
  identifiers at checkout, logs the first fault, preserves its original code
  over a secondary rollback error, and destroys the failed connection. The
  listener is removed after release hands error ownership back to the pool.
  Backend termination (`57P01`) and idle-transaction timeout (`25P03`) both
  recover in subprocess tests. Repeated checkouts do not accumulate listeners.
- **Failure amplification:** periodic jobs skip overlapping ticks;
  Runner disconnect writes catch and log rejection. Idle pool errors also
  have an explicit listener. These guards prevent those failures from becoming
  process crashes or overlapping copies of the same timer job.
- **Lost retry evidence:** `reconcileAll` previously swallowed individual DB
  failures with `allSettled`, allowing desired-state outbox events to be marked
  processed. Failures now produce `runner.reconcile_error`; the event remains
  pending until reconciliation succeeds. Healthy Runner dispatches can still
  progress.

In a separate synthetic contention check, a one-connection pool had a 150 ms
acquisition timeout and ran a 400 ms SQL statement. A second caller timed out
while the first statement completed normally (407 ms in that run), after which
`total=1, idle=1, busy=0, waiting=0`. This demonstrates the distinction between
temporary exhaustion and a leaked checkout. It is not a production latency
measurement or proof of the original incident's initiating cause.

### Hardening applied after the audit

The ordinary connection settings and Runner synchronization ceiling are exposed
through environment variables and Helm values. Timeout values must be positive
integers (milliseconds); synchronization concurrency must be between 1 and 8.

| Environment variable | Helm value | Default |
| --- | --- | --- |
| `CONTROLLER_DATABASE_STATEMENT_TIMEOUT_MS` | `controller.databaseTimeouts.statementMs` | 30000 |
| `CONTROLLER_DATABASE_LOCK_TIMEOUT_MS` | `controller.databaseTimeouts.lockMs` | 5000 |
| `CONTROLLER_DATABASE_IDLE_TRANSACTION_TIMEOUT_MS` | `controller.databaseTimeouts.idleTransactionMs` | 30000 |
| `CONTROLLER_RUNNER_SYNC_CONCURRENCY` | `controller.runnerSyncConcurrency` | 4 |

- **Server-side cancellation:** ordinary SQL and lock waits inherit the settings
  above. Report writes retain their transaction-local 2 s lock / 30 s statement /
  30 s idle limits. Migrations use their own larger budget and discard that
  connection afterward, preventing session settings from leaking into requests.
  TCP keepalive is enabled. A statement budget is not a transaction-total budget
  and does not impose a client-side deadline on an unresponsive network.
- **Shorter telemetry transactions:** runtime and routing ingestion commit at
  most 50 events per transaction, yielding the connection between chunks. They
  also target 1 s per chunk, checked between events; one event and its cost writes
  remain atomic, so a slow event can exceed that soft target. Model catalog reads
  are shared within each chunk, while historical prices still use each event's
  timestamp. Watermarks are written once per Runner per chunk, in stable Runner
  order, and never move backward on replay. Earlier chunks can commit before a
  later chunk fails; event/cost IDs and routing upserts make WAL replay idempotent.
- **Bounded Runner synchronization:** registration, timer and API-triggered
  desired-state/protection synchronization share one concurrency queue. Requests
  for a queued Runner coalesce; a change during an active pass schedules a fresh
  pass at the back of the queue. Failures retain outbox retry evidence. A failed
  read does not free its slot while a sibling database read is still running.
  Outbox completion writes are sequential. The ceiling counts synchronization
  jobs, not individual SQL queries: a full pass can perform two reads concurrently.
- **Scrapes survive database failure:** live pool gauges do not issue SQL:
  `guard_controller_database_pool_connections{state="total|idle|busy"}`,
  `guard_controller_database_pool_max_connections`,
  `guard_controller_database_pool_waiting` and
  `guard_controller_database_pool_state_available`. Snapshot gauges are
  `guard_controller_database_snapshot_fresh`,
  `guard_controller_database_snapshot_last_success_timestamp_seconds` and
  `guard_controller_database_snapshot_in_flight`. A 50 ms response grace period
  does not cancel the snapshot query; the single job remains tracked until all
  its reads settle, including after a sibling failure. Repeated scrapes cannot
  create overlapping snapshot jobs. Safe failure logs include pool counts and
  error categories/codes, never report contents, SQL parameters or credentials.
- **Drain before pool shutdown:** stop HTTP admission and Runner timers first;
  readiness and new application requests return 503 while draining. Accepted
  HTTP work, Runner message chains (including reports already queued behind a
  heartbeat), queued synchronization, timer jobs, metrics
  collection and account sync finish before the pool closes. Disconnect writes
  follow accepted heartbeats, so a late heartbeat cannot overwrite `offline`.
  Background environment checks wait for all siblings after a failure. Pricing
  drains after the producers that can start it; a pricing failure still triggers
  pool cleanup. After an overall 25 s deadline the process closes transports and
  exits with failure, terminating outstanding sockets/work within the default
  Pod grace period. Deadline failure is logged using the same safe error fields.

Deployment capacity still needs accounting: `/health/live` tests process liveness,
not database health, while `/health/ready` uses the shared database. Probe/client
abandonment does not cancel SQL. During rollout, old and new Controller processes
can overlap, each with its own 20-connection pool. Include both processes and other
DB clients in the database connection/memory budget before increasing pool size.
No production cluster state was inspected for this audit.

### Content-free database inspection

Use a separate administrative connection during an incident, because the
application pool itself may be exhausted. These read-only queries intentionally
omit query text, bind values, users' report content and credentials. PostgreSQL
permissions determine which activity is visible. Run the setting query as the
Controller's database role to inspect that role's defaults; settings in another
session do not reveal a transaction's `SET LOCAL` overrides.

```sql
SELECT name, setting, unit
FROM pg_settings
WHERE name IN ('max_connections', 'superuser_reserved_connections',
               'statement_timeout', 'lock_timeout',
               'idle_in_transaction_session_timeout');

SELECT application_name, state, wait_event_type, wait_event, count(*)
FROM pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY application_name, state, wait_event_type, wait_event;

SELECT pid, state, wait_event_type, wait_event,
       clock_timestamp() - xact_start AS transaction_age,
       clock_timestamp() - query_start AS query_age,
       pg_blocking_pids(pid) AS blocking_pids
FROM pg_stat_activity
WHERE application_name = 'tali-guard-controller'
ORDER BY xact_start NULLS LAST;
```

An `idle` PostgreSQL backend can still be checked out by application code;
`idle in transaction` means an open transaction between statements. Compare
server activity with application pool snapshots. Neither server backend count
nor pool `busy` alone establishes a connection leak. For idle sessions,
`query_age` is the age of the last query start, not an active query duration.

## Business metric semantics

`guard_runner_guardrail_requests_total` counts completed GuardRail checks. Its
bounded product identity labels are `guardrail_id` and `endpoint_id`.
Prometheus attaches `runner_id` from the stable Kubernetes Pod name through the
Runner ServiceMonitor target relabeling.

| Signal | Definition |
| --- | --- |
| Throughput | Completed resolved checks/s, partitioned into mutually exclusive allow, deny, transform, and technical error outcomes |
| Availability | `result="success"` / all completed resolved checks |
| Latency | `histogram_quantile` over merged successful-check buckets from `guard_runner_guardrail_request_duration_seconds` |
| Coverage | `coverage="complete"` / all completed resolved checks |
| Fail-open | `failure_mode="fail_open"` / all completed resolved checks |
| Error budget | Availability budget remaining over a fixed 30-day window |

`result` is technical execution; `disposition` is policy enforcement. A deny or
transform returned normally has `result="success"` and contributes positively
to availability. The throughput panel therefore uses four non-overlapping
series:

- success + allow
- success + deny
- success + transform
- error or timeout

Their stacked height is total processed throughput. Deny is blue rather than
red because it proves policy enforcement. Technical error and fail-open are
danger signals.

The end-to-end duration ends after the decision and durable telemetry append.
The primary latency panel only includes `result="success"`. It sums histogram
buckets across all selected Runners before evaluating P90, P95, and P99; it
never averages per-Runner percentiles. The one Latency panel renders all three
series together, with P95 as the visually dominant line. Its legend can isolate
P90, P95, or P99 locally without changing any other panel. Tables and the
collapsed Diagnostics latency panels use a fixed P95, including stage,
provider, and queue latency.

## Latency ownership and debugging

The Overview answers whether the product is healthy. The separate
`GuardRails Troubleshooting` dashboard answers why an individual scope is
slow. Its selectors begin with GuardRail, Endpoint, and Runner, followed by
the dependency dimensions Provider, Model, and Action.

Latency ownership deliberately uses different semantics for parallel model
work:

| Signal | Definition |
| --- | --- |
| E2E | Wall duration of the complete GuardRail request |
| Queue | Wall time waiting for Runner admission |
| Action | Wall duration of one version-pinned GuardRail Action |
| Model call | Wall duration of one external model RPC |
| Provider work | Sum of model RPC durations; parallel calls can overlap |
| Model wait | Union of model RPC intervals on the request wall clock; parallel calls are counted once |
| TTFT | Time to first token, when a streaming provider reports it |

The model-call series retain only configured product dimensions and bounded
outcomes: GuardRail, Endpoint, phase, Action, Provider, Model, operation,
result, and error class. Retry count, retry backoff, input/output tokens, and
in-flight calls distinguish provider latency from throttling and Runner
saturation. The same contract covers both TaskLattice model-backed Actions and
NeMo-native `content_safety` / `topic_control` flows. Native NeMo model clients
are wrapped at runtime construction, so their RPC duration, result, tokens,
request-wall interval, and trace span cannot bypass the model panels.

Prometheus histograms carry OpenMetrics exemplars containing `trace_id`.
Tempo receives a `guardrail.request` root span, explicit
`guardrail.queue_wait`, `guardrail.runtime`, and `guardrail.telemetry.append`
stages, a `guardrail.action` span for each Action, and a nested
`guardrail.model.request` span for each model RPC.
The span attributes include the selected GuardRail/Endpoint/Runner scope,
Action, Provider, Model, result, timeout/failure mode, provider-work time, and
model-wait time; request content and credentials are never attached. Pyroscope
profiles are linked to the same trace span. This supports the incident path:

```text
P95 spike -> latency ownership -> exemplar/slow-trace table
          -> request -> queue / runtime -> Action -> model RPC
                     -> durable telemetry append
          -> related CPU flame graph when queue/model wait do not explain E2E
```

No model-call data is a meaningful result when the selected GuardRail uses
only local Actions. It must not be rendered as artificial zero model
latency. The model-wait ratio is zero only while resolved GuardRail traffic
exists and no model wait was observed; it is `N/A` when there is no traffic.

The Troubleshooting dashboard follows the incident path rather than mirroring
raw metric families:

- **Technical failures** locates scoped errors/timeouts by stage and bounded
  reason, then identifies a failing Provider/Model/Action/error class;
- **Policy behavior** separates successful allow/deny/transform throughput,
  the module/risk/policy finding that triggered intervention, and the Action
  that was actually applied;
- **Protection completeness** identifies the failed module, policy, action,
  failure mode, and reason behind incomplete coverage or fail-open;
- **Global entry path** shows authentication, routing, and pre-execution
  rejection by Runner. GuardRail and Endpoint selectors intentionally do
  not apply before those identities have been authenticated and resolved;
- the collapsed **Runner and telemetry internals** section contains Pool
  desired/ready/serving replicas, per-Runner convergence and heartbeat, and
  evidence pipeline age, backlog, and failure rate.

## Topology and Overview filters

The only globally visible business scope filters are ordered and cascaded:

1. **GuardRail** — friendly `guardrail_name`, stable `guardrail_id` value
2. **Endpoint** — friendly `endpoint_name`, stable `endpoint_id`
   value, constrained by the selected GuardRail relationship
3. **Runner** — stable `runner_id`, constrained through the topology Pool

They come from:

- `guard_controller_guardrail_info`
- `guard_controller_endpoint_info`
- `guard_controller_guardrail_endpoint_info`
- `guard_controller_runner_info`

`guard_controller_guardrail_endpoint_info` is derived from each Endpoint's bound
Router and the Guardrail targets pinned in that Router's published revision.
This is intentionally independent of traffic counters, so a zero-traffic legal
GuardRail, Endpoint, or Runner remains selectable. Percentile selection is
not a dashboard-wide filter: P90, P95, and P99 live together in the Latency
panel and are explored through that panel's legend.

Router, GuardRail version, phase, protocol, namespace, release, Pool, and
Pod are not Overview filters. Router/version/phase/protocol remain useful
raw diagnostic dimensions, while namespace and release isolate Prometheus
tenancy. Pool appears only where it explains Runner placement.

The dashboard is layered as follows:

- **System Overview · Global** — system status, Runner fleet health,
  Controller uptime, Runner/evidence freshness, and topology; this section remains
  global and is not narrowed by the business scope filters;
- **Traffic & Latency · Selected scope** — processed throughput plus one
  Latency panel containing a dominant P95 line alongside P90 and P99;
- Availability & SLO;
- Protection Health;
- Endpoint and Runner SLI tables, with fixed P95 latency;
- Diagnostics, collapsed by default, with fixed P95 latency views.

There are no separate Allow/Deny/Transform stats, no P90/P95/P99 card wall,
and no global percentile selector.

## Resolved identity and no-traffic behavior

`__unmatched__` and `__unresolved__` GuardRail or Endpoint identities are
shown in the dedicated routing-integrity panel and excluded from product
availability, latency, coverage, and error-budget denominators. They are also
alerted independently.

No ratio uses a clamped denominator or `or vector(0)`. Therefore a selection
with no checks produces `N/A` rather than a fabricated 100% availability or
coverage. Missing telemetry also remains missing and is handled by scrape-loss
platform alerts.

## Recording rules

The Overview contract removes Router, version, phase, and protocol while
retaining `guardrail_id`, `endpoint_id`, and `runner_id`:

- `guardrail:checks:rate5m`
- `guardrail:request_duration_seconds_bucket:rate5m`
- `guardrail:availability:ratio5m`
- `guardrail:availability:ratio30m`
- `guardrail:availability:ratio30d`
- `guardrail:latency_seconds:p95_5m`
- `guardrail:latency_seconds:p99_5m`
- `guardrail:coverage:ratio5m`
- `guardrail:fail_open:ratio5m`
- `guardrail:error_budget:remaining_ratio30d`

The bucket-rate rule supplies the P90, P95, and P99 series in the single
Latency panel. P95 remains fixed in tables and Diagnostics; fixed p95/p99
recordings are retained for alert evaluation.

Product alerts preserve GuardRail, Endpoint, and Runner identity: fast/slow
availability burn, p95/p99 latency, incomplete coverage, and fail-open. They
require positive traffic, so an idle scope does not page. Identity-resolution
failures alert separately. Platform alerts cover Controller/Runner scrape loss,
replica deficit, convergence, stale heartbeat/evidence, WAL/outbox backlog, and
artifact rejection.

Default objectives are configured under `observability.slo`:

```yaml
availabilityTarget: 0.999
runtimeP95Seconds: 2.5
runtimeP99Seconds: 5.0
completeCoverageTarget: 1.0
burnRateFast: 14.4
burnRateSlow: 6
```

## Prometheus Operator and Grafana

The chart's default [`values.yaml`](../charts/tali-guard/values.yaml) is the
production profile: authenticated metrics scraping, SLO rules, alerts, and both
Grafana dashboards are enabled, while full tracing and continuous profiling are
disabled.

Use the debug settings documented in [`values.yaml`](../charts/tali-guard/values.yaml)
for a bounded production troubleshooting window:

```bash
helm upgrade --install tali-guard ./charts/tali-guard \
  --namespace guard-system \
  --values ./values-company-production.yaml \
  --set observability.performanceDebug.enabled=true \
  --set-string observability.tracing.otlpEndpoint=http://tempo.monitoring.svc.cluster.local:4318 \
  --set-string observability.profiling.serverAddress=http://pyroscope.monitoring.svc.cluster.local:4040 \
  --set-string observability.serviceMonitor.labels.release=monitoring \
  --set-string observability.prometheusRule.labels.release=monitoring \
  --wait --timeout 15m
```

This single switch enables 100% Runner trace sampling, continuous profiling,
authenticated metrics scraping, alerts/recording rules, and the Overview and
Troubleshooting dashboards. Tempo and Pyroscope addresses are deliberately
required rather than inferred. Disable the preset after the investigation to
remove the full-sampling overhead; explicitly enabled individual observability
components remain active. The preset never changes GuardRail runtime logging
or content-capture settings. The example Tempo/Pyroscope addresses and
`release: monitoring` selectors are illustrative; replace them with the addresses
and selectors of your monitoring stack. Guard does not install that stack.

The chart creates authenticated Controller and Runner ServiceMonitors, a
PrometheusRule, and a sidecar-discoverable dashboard ConfigMap. It retains a
dedicated metrics Bearer token. Set `security.metrics.existingSecret` when the
platform owns rotation and roll workloads after rotating an injected token.

For standalone Grafana, configure a Prometheus datasource with UID
`tasklattice-prometheus` pointing at your Prometheus server, then import the
[Overview](../charts/tali-guard/grafana/dashboards/tasklattice-guard-overview.json)
and [Troubleshooting](../charts/tali-guard/grafana/dashboards/tasklattice-guard-troubleshooting.json)
dashboards. To use the trace and profile panels, also configure Tempo and
Pyroscope datasources with UIDs `tasklattice-tempo` and `tasklattice-pyroscope`.
Deploy and manage these monitoring services separately from Guard.

## Cardinality budget

The allowed high-frequency business topology dimensions are:

- `guardrail_id`
- `endpoint_id`
- `runner_id` as a scrape target label
- configured Action, Provider, Model, and operation identifiers
- bounded enums such as result, disposition, coverage, enforcement mode,
  failure mode, stage, and error class

Controller `*_info` metrics carry friendly names; names are not copied onto
high-frequency counters or histograms. Raw metrics may retain Router,
version, phase, and protocol for diagnostics, but the Overview recording rules
drop them before long-lived aggregation.

Budget active series approximately as:

```text
active GuardRails x Endpoints x Runners
x bounded outcome combinations x histogram buckets
```

Do not label metrics with request/call IDs, caller or user IDs, content, raw
error strings, unbounded URLs, or response-supplied model names. Provider and
Model labels must come from version-pinned configuration. Request-specific
identities belong in evidence storage, structured logs, traces, and exemplars.

## Bypass boundary

Runner metrics prove checks only for requests that reached Runner. End-to-end
bypass detection requires a monotonically increasing request counter at the
upstream gateway/model-egress boundary and comparison with GuardRail input
checks for the same Endpoint and window, accounting for retries and
pre-execution rejection.
