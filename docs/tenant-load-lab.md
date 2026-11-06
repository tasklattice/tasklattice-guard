# Tenant Load Lab

The administrator portal at `/settings/tenant-load-lab` compares real traffic for
tenantA, tenantB and tenantC. It provides changing baseline load, temporary peaks,
occupancy and latency charts, and an optional client quota simulation. No example
traffic is plotted before the generator runs.

In the retained local configuration, **A and B share the default Runner pool;
C belongs to group-demo and uses a separate Runner pool**. These groups still
share local CPU, memory, storage, PostgreSQL and Redis. Separate pools establish
allocation boundaries; their existence does not prove performance isolation.

Use the [current Kubernetes runbook](local-k8s-runtime-2026-11-05.md) for service
placement, browser access, measured capacity and fresh acceptance evidence. The
[multi-tenancy status](multi-tenancy-status.md) lists implemented controls and
remaining isolation work.

## What actually executes

```text
Generator's bounded client queue
  → tenant-specific upstream LiteLLM gateway and gateway credential
  → real Input check: Endpoint → Router → published Guardrail → assigned Runner
  → standalone OpenAI-compatible fake generation model
  → real Output check through the existing upstream Guard provider
  → gateway completion delivered to the generator
```

Each pipeline sends a non-streaming Chat Completions request with `Hello.` to
its configured gateway model. The gateway uses the existing TaskLattice Guard
provider for Input and Output protection. A blocked Input skips generation;
a blocked Output prevents delivery. The generator does not issue those callbacks
itself and does not serve a model.

The fake model lives in the sibling `tasklattice-fake-llm` project and runs as an
independent Kubernetes service. Its local target delay is 120 ms, with concurrent
requests. Only application generation is synthetic. Endpoint authentication,
Router selection, signed Guardrail execution, Runner admission and telemetry are
real. The lab fixtures use a simple `LAB_BLOCK_MARKER` keyword Policy; harmless
chart traffic does not evaluate model-based detector quality.

## Conduct a comparison

1. Sign in as a platform administrator and open **Settings → Tenant Load Lab**.
2. Confirm the displayed A/B and C group/pool assignments, Runner readiness, and
   external model diagnostics. The **Measured tenant admission** panel shows
   actual Runner permits independently of the generator.
3. Select **Group allocation**, then **Start**. Allow at least 15 seconds of
   successful baseline traffic before requesting a peak.
4. Choose a 15, 30 or 60 second duration and peak A. Observe B in the same group
   and C in the separate group: delivered p95, throughput, errors, queues and
   group Runner process gauges. **Release peak** ends the peak early.
5. Read **Neighbor impact** after there are at least three valid samples before
   and during the peak. It compares the medians of sample p95 values, using up
   to 15 seconds before the peak. This is not a new percentile of raw requests.
6. Pause, or switch to **Quota simulation** and start a fresh comparison. A mode
   change stops traffic and clears experiment measurements. **Reset** also
   stops traffic and clears the generator's history and counters.

Pause cancels generator HTTP calls and clears its queues and active peaks.
Already accepted upstream work may take time to settle. Pausing or resetting the
generator does not reset Runner counters or the independent model service.

## Two generator modes

| Mode | Client admission behavior | Meaning |
| --- | --- | --- |
| Group allocation | Oldest queued arrival first, within global and group generator bounds | Observe the real configured Runner placement without the simulated tenant cap. |
| Quota simulation | Round-robin tenants; at most 4 in-flight pipelines and 10 starts/sec per tenant | Compare client admission fairness on the same real Runner placement. |

Both modes cap the generator at 64 in-flight pipelines, 120 gateway starts/sec,
and 32 queued records per tenant. Excess arrivals count as errors. With multiple
groups, each group leaves 16 slots available for every other group; with the
two-group fixture, one group can occupy at most 48 of the 64 slots. These are
test-tool limits, not Runner quotas or CPU reservations.

Baseline load changes smoothly toward a new random rate every three seconds.
Source defaults are 3–5 pipelines/sec per tenant, initially 4. Deployment settings
can lower these rates for limited hardware; the current local runbook records
the tested deployment. The configured peak defaults to 60 pipelines/sec and is
bounded to 12–80. Offered load can exceed delivered throughput.

## Interpret the measurements

| Display | Actual measurement and limitation |
| --- | --- |
| Tenant occupancy | Generator in-flight pipelines ÷ 4 reference slots, capped at 100%. Four is a visual reference and the quota-mode cap, not allocated CPU or a Runner permit count. The numeric in-flight count can exceed four in Group allocation mode. |
| Delivered p50/p95 | Successful gateway completion latency, including the generator's queue wait. A rolling 15-second window excludes failed requests; read it alongside errors and delivered throughput. |
| Offered / delivered rate | Arrivals / successful completions observed in the preceding second. These are pipeline rates, not counts of individual Guard checks. |
| Client queue p95 | Generator queue wait for successfully completed pipelines in the rolling window. It is distinct from Runner admission wait. |
| Guard / model stage latency | Unavailable from the standard gateway completion; shown as gaps rather than inferred by subtracting percentiles. |
| External model p95 | Read-only diagnostics from the independent model service. Its scope and sample window belong to that service, not one tenant or one gateway stage. |
| Group Runner gauges | Real admission in-flight, queue, capacity, process CPU and resident memory, summed once per configured pool. Missing scrapes make gauges unavailable. Shared host contention remains possible. |

Generator history has one sample per second and retains at most 180 points.
Latency is unavailable when its window contains no successful completions.
Every non-2xx gateway response, timeout, malformed completion and dropped client
arrival counts as an error. The gateway does not expose reliable decision,
block-phase or transformation details to this generator; its chart counters
cannot certify policy decisions. Use Runner telemetry and the acceptance checks
in the runbook to verify Input/Output enforcement.

**Measured tenant admission** instead uses authenticated Runner heartbeats and
current Controller group assignments. Its permit occupancy, queue, rejection
counters and histogram-derived wait/held p95 describe actual local admission.
Local caps do not reserve group capacity. Missing/stale/reset observations
produce gaps. Its history is local to the Controller and can clear on restart
or allocation/session changes. See the [monitor guide](tenant-admission-monitor.md).

## Configuration and permissions

The feature is optional. Set `CONTROLLER_TENANT_LOAD_LAB_URL` to the private lab
service. The service reads `TENANT_LOAD_LAB_CONFIG`, containing three gateway
bindings, Runner group/pool addresses and optional model diagnostics. Starting
the service alone does not start load. Keep it on a private network: its direct
`/state` and `/control` endpoints have no independent user authentication.

The Controller exposes administrator-only `GET /api/v1/tenant-load-lab/state` and
`POST /api/v1/tenant-load-lab/control`; personal tokens also need Settings
read/write permission respectively. The browser receives aggregate state, not
gateway keys, Endpoint keys or private fixture configuration. Start and peak
commands check that configured pools still belong to the tenants' current groups;
allocation drift requires a configuration update before new load can start.

Implementation entry points are [the generator](../scripts/tenant-load-lab.mjs),
[shared contracts](../controller/shared/tenant-load-lab.ts),
[portal](../controller/src/routes/tenant-load-lab.tsx) and
[Controller proxy](../controller/server/services/tenant-load-lab.ts).

This lab does not establish streaming behavior, model safety quality, physical
CPU/memory isolation, distributed concurrency guarantees, or production capacity.
The current runbook separates measured happy paths from these unverified areas.
