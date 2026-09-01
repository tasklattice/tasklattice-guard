# TaskLattice Guard observability

The production observation path is the same hierarchy a GuardRail owner uses:

```text
GuardRail -> Integration -> Runner -> completed check
                                  -> allow | deny | transform | technical error
                                  -> Action -> Model RPC
```

Controller topology metrics populate the selectors even when a valid resource
has never received traffic. Runner request metrics supply business outcomes and
latency. Platform signals explain a degraded business SLI; they are not the
primary Overview navigation model.

## Business metric semantics

`guard_runner_guardrail_requests_total` counts completed GuardRail checks. Its
bounded product identity labels are `guardrail_id` and `integration_id`.
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
slow. Its selectors begin with GuardRail, Integration, and Runner, followed by
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
outcomes: GuardRail, Integration, phase, Action, Provider, Model, operation,
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
The span attributes include the selected GuardRail/Integration/Runner scope,
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
  rejection by Runner. GuardRail and Integration selectors intentionally do
  not apply before those identities have been authenticated and resolved;
- the collapsed **Runner and telemetry internals** section contains Pool
  desired/ready/serving replicas, per-Runner convergence and heartbeat, and
  evidence pipeline age, backlog, and failure rate.

## Topology and Overview filters

The only globally visible business scope filters are ordered and cascaded:

1. **GuardRail** — friendly `guardrail_name`, stable `guardrail_id` value
2. **Integration** — friendly `integration_name`, stable `integration_id`
   value, constrained by the selected GuardRail relationship
3. **Runner** — stable `runner_id`, constrained through the topology Pool

They come from:

- `guard_controller_guardrail_info`
- `guard_controller_integration_info`
- `guard_controller_guardrail_integration_info`
- `guard_controller_runner_info`

This is intentionally independent of traffic counters, so a zero-traffic legal
GuardRail, Integration, or Runner remains selectable. Percentile selection is
not a dashboard-wide filter: P90, P95, and P99 live together in the Latency
panel and are explored through that panel's legend.

Deployment, GuardRail version, phase, protocol, namespace, release, Pool, and
Pod are not Overview filters. Deployment/version/phase/protocol remain useful
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
- Integration and Runner SLI tables, with fixed P95 latency;
- Diagnostics, collapsed by default, with fixed P95 latency views.

There are no separate Allow/Deny/Transform stats, no P90/P95/P99 card wall,
and no global percentile selector.

## Resolved identity and no-traffic behavior

`__unmatched__` and `__unresolved__` GuardRail or Integration identities are
shown in the dedicated routing-integrity panel and excluded from product
availability, latency, coverage, and error-budget denominators. They are also
alerted independently.

No ratio uses a clamped denominator or `or vector(0)`. Therefore a selection
with no checks produces `N/A` rather than a fabricated 100% availability or
coverage. Missing telemetry also remains missing and is handled by scrape-loss
platform alerts.

## Recording rules

The Overview contract removes Deployment, version, phase, and protocol while
retaining `guardrail_id`, `integration_id`, and `runner_id`:

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

Product alerts preserve GuardRail, Integration, and Runner identity: fast/slow
availability burn, p95/p99 latency, incomplete coverage, and fail-open. They
require positive traffic, so an idle scope does not page. Identity-resolution
failures alert separately. Platform alerts cover Controller/Runner scrape loss,
replica deficit, convergence, stale heartbeat/evidence, WAL/outbox backlog, and
artifact rejection.

Default objectives are configured under `observability.slo`:

```yaml
availabilityTarget: 0.999
runtimeP90Seconds: 1.0
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

Add [`values-debug.yaml`](../charts/tali-guard/values-debug.yaml) for a bounded
production troubleshooting window:

```bash
helm upgrade --install tali-guard ./charts/tali-guard \
  --namespace guard-system \
  --values ./values-company-production.yaml \
  --values ./charts/tali-guard/values-debug.yaml \
  --wait --timeout 15m
```

This single switch enables 100% Runner trace sampling, continuous profiling,
authenticated metrics scraping, alerts/recording rules, and the Overview and
Troubleshooting dashboards. Tempo and Pyroscope addresses are deliberately
required rather than inferred. Disable the preset after the investigation to
remove the full-sampling overhead; explicitly enabled individual observability
components remain active. The preset never changes GuardRail runtime logging
or content-capture settings. Its default Tempo/Pyroscope addresses and
`release: monitoring` selectors are intended for the repository's local stack;
override them when production uses another namespace or Helm release name.

The chart creates authenticated Controller and Runner ServiceMonitors, a
PrometheusRule, and a sidecar-discoverable dashboard ConfigMap. It retains a
dedicated metrics Bearer token. Set `security.metrics.existingSecret` when the
platform owns rotation and roll workloads after rotating an injected token.

For standalone Grafana, supply `PROMETHEUS_URL` and mount:

| Repository path | Grafana path |
| --- | --- |
| `observability/grafana/provisioning/datasources` | `/etc/grafana/provisioning/datasources` |
| `observability/grafana/provisioning/dashboards` | `/etc/grafana/provisioning/dashboards` |
| `charts/tali-guard/grafana/dashboards/tasklattice-guard-overview.json` | `/var/lib/grafana/dashboards/tasklattice-guard/tasklattice-guard-overview.json` |
| `charts/tali-guard/grafana/dashboards/tasklattice-guard-troubleshooting.json` | `/var/lib/grafana/dashboards/tasklattice-guard/tasklattice-guard-troubleshooting.json` |

The metrics datasource UID is `tasklattice-prometheus`. Troubleshooting also
provisions `tasklattice-tempo` and `tasklattice-pyroscope`.

The local kube-prometheus-stack values enable anonymous Editor access for the
port-forwarded development environment only. Editor is required for Grafana
Explore, which renders a selected Tempo trace and its related profile. Do not
use this anonymous role on an internet-facing Grafana:

```bash
helm upgrade monitoring prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --reuse-values \
  --values observability/grafana/kube-prometheus-stack-values-local.yaml
```

## Cardinality budget

The allowed high-frequency business topology dimensions are:

- `guardrail_id`
- `integration_id`
- `runner_id` as a scrape target label
- configured Action, Provider, Model, and operation identifiers
- bounded enums such as result, disposition, coverage, enforcement mode,
  failure mode, stage, and error class

Controller `*_info` metrics carry friendly names; names are not copied onto
high-frequency counters or histograms. Raw metrics may retain Deployment,
version, phase, and protocol for diagnostics, but the Overview recording rules
drop them before long-lived aggregation.

Budget active series approximately as:

```text
active GuardRails x Integrations x Runners
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
checks for the same Integration and window, accounting for retries and
pre-execution rejection.
