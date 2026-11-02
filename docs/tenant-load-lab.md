# Tenant Load Lab

The Tenant Load Lab is an optional, administrator-only local experiment at `/settings/tenant-load-lab`. It sends synthetic requests for tenantA, tenantB, and tenantC through real Guard Runners, lets an operator add a temporary traffic peak, and plots measured occupancy, latency, and throughput. In the retained local deployment, tenantA and tenantB share the default Runner group, while tenantC uses the separate group-demo Runner group.

**The quota mode limits this experiment's load generator. It does not enable tenant quotas or CPU allocation. Runner group allocation is real, but the groups still share local infrastructure and do not provide complete resource isolation.** Read the [isolation audit](multi-tenancy-isolation-audit-2026-10-24.md) alongside the results.

## What executes

Each started client pipeline performs these operations in order:

```text
Client queue
  → real Runner Input check using this tenant's Endpoint key
  → local HTTP fake LLM: asynchronous 120 ms timer, harmless fixed response
  → real Runner Output check using the same Endpoint and call ID
  → record the completed pipeline's measured durations
```

The generation model is fake; both guard checks are real. Each check uses the configured, tenant-owned Endpoint credential and reaches the assigned group’s Runner, which resolves the published Router and executes the pinned Guardrail and its policy. The lab itself acts as a simple non-streaming gateway; it does not send requests through an independently deployed LiteLLM gateway or an existing business application. The fake LLM runs inside the experiment service and exposes `/v1/chat/completions`. It performs no external inference and uses concurrent timers rather than a serial model queue. Its configured delay is 120 ms; observed HTTP latency also includes event-loop scheduling and transport overhead, so the measured model p95 need not equal exactly 120 ms.

The three existing lab Endpoints and published Routers target the **same immutable lab Guardrail version and signed artifact**, so they run the same local detection plan. The lab Policy has one keyword Rule: block `LAB_BLOCK_MARKER` on Input and Output. Its four tests cover a blocking and a benign example on each Rail. Policy tests and Guardrail tests run through the Controller/Runner validation workflow before publication; the published Guardrail carries its frozen suite. Continuous chart traffic is harmless and should be allowed, while provisioning separately checks real marker blocking.

TenantC owns this new Policy and Guardrail and shares only the Guardrail with A and B. Each tenant owns its own Endpoint and Router. These are separate fixtures from the earlier [Default runtime smoke](multi-tenancy-deployment-2026-10-26.md): **Default is not shared with tenantC or edited for this experiment.**

Source: [workload service](../scripts/tenant-load-lab.mjs), [administrator page](../controller/src/routes/tenant-load-lab.tsx), and [Controller proxy](../controller/server/services/tenant-load-lab.ts).

Policy decisions follow the gateway contract: blocked input stops before the fake model, blocked output stops delivery, and transformed content is passed forward. The lab counts blocks and transformations separately from errors; latency and completed throughput cover delivered responses.

## Compare the two modes

| Mode | Load-generator behavior | What changes in Runner |
| --- | --- | --- |
| Group allocation | Dispatch queued arrivals in arrival order under the global generator limits; no per-tenant admission quota. | Each tenant uses the Runner pool configured for its group. |
| Quota simulation (client-side) | Round-robin dispatch with at most **4 active client pipelines and 10 pipeline starts per rolling second per tenant**. Excess arrivals wait in that tenant's bounded client queue. | Nothing. Admission is simulated before requests reach Runner. |

Both modes use the same real Endpoints and Guardrail artifact. Each admitted client pipeline makes **two** guard HTTP calls. The 10 pipeline starts/s quota therefore limits pipeline admission, not the number of guard calls completed in a particular second.

Baseline arrival rates vary smoothly around 3–5 pipelines/s per tenant, starting at four. A peak raises the selected tenant's offered rate to 60 pipelines/s by default. The private configuration can set `peakRps` within 12–80. The UI offers 15-, 30-, or 60-second peaks and an early **Release peak** control.

These baseline and simulated-quota settings are deliberately bounded for the one-CPU, approximately 2 GB local environment. They set offered work and admission limits, not displayed latency or throughput: the charts still use actual completed requests and observed errors.

The generator also bounds the complete experiment to 120 pipeline starts per rolling second, 64 active pipelines, and 32 queued records per tenant. When multiple groups are configured, it reserves 16 of those generator slots for each other group so a peak in one group cannot monopolize the test tool itself. With the two local groups, each can occupy at most 48 of the 64 slots. This is a load-generator safeguard, not a Runner quota; it applies in both modes. Offered arrivals can exceed the start-rate cap. When a tenant's queue is full, excess arrivals are dropped and counted as errors; the tool does not allocate unbounded pending promises.

## Read the measurements correctly

| Display | Definition |
| --- | --- |
| Tenant occupancy | `min(100, active client pipelines / 4 × 100)`. Four is a reference scale and the simulated quota, **not allocated CPU**. The adjacent in-flight count can exceed four in shared mode even when the bar is already at 100%. |
| Tenant in flight | A started pipeline still executing Input, the local model, or Output. It is not the number of requests currently holding Runner admission slots. |
| Offered / completed rate | Arrivals / successful completions observed over the latest second, in client pipelines/s. |
| End-to-end p95 | Nearest-rank p95 of successfully completed pipeline durations in the last 15 seconds, including client queue wait. |
| Guard p95 | p95 of the measured Input HTTP duration plus Output HTTP duration for each successful pipeline. This includes network overhead, not just engine execution. |
| Model p95 | p95 of the measured local fake-model HTTP stage. The model health tile separately measures the fake model's timer-to-response duration. |
| Client queue p95 | p95 of the time an admitted pipeline spent waiting in the load generator. It is distinct from the Runner admission queue. |
| Runner admission / CPU / memory | Process-wide observations from each configured Runner pool's real `/metrics` endpoint. They are not tenant resource shares. |

The server samples once per second and keeps up to 180 history points. Latency values are empty until successful requests complete. Stage percentiles are calculated independently and **must not be added together** to obtain end-to-end p95. Errors and cancelled requests are not successful latency samples, so read the error counters and throughput alongside p95.

The neighbor-impact table compares the median of sampled p95 values before and during the latest peak, with up to 15 seconds of baseline. It requires at least three usable samples in each period. Its percentage change describes those sampled measurements; it is not a percentile recomputed from the union of all raw requests or proof of causation. Rolling latency windows overlap the start/end of a peak.

If metrics authentication or gauges are unavailable, the page shows unavailable measurements rather than inventing CPU or admission values. When a Runner URL addresses a Service with multiple replicas, a scrape observes the selected replica rather than a fleet aggregate; use a single known Runner per group for this local comparison.

## Run an experiment in the console

1. Sign in with the platform administrator account and open **Settings → Tenant Load Lab**, or `/settings/tenant-load-lab`. Tenant business users cannot read or control the lab API.
2. Select **Group allocation** and press **Start experiment**. Merely opening the page or starting the workload server does not generate guard traffic; health/metrics polling can still occur.
3. Let a baseline accumulate for at least 15 seconds. Check that all three tenants complete requests, errors remain understood, and both Runner groups are ready.
4. Choose a 30-second peak for tenantC. Observe C's offered/in-flight counts, its queue and p95, and A/B's measured throughput and p95. The Runner cards show separate measurements for the A+B and C groups. Record the neighbor-impact comparison once enough samples exist.
5. Release the peak or let it expire, then watch recovery. A peak need not degrade neighbors on every machine: local Rule execution may be too fast to saturate the Runner at these bounded rates. The page reports the result rather than manufacturing interference.
6. Switch to **Quota simulation (client-side)**. A mode change stops traffic and resets accumulated measurements. Press Start again, collect a fresh baseline, then repeat the same tenant and peak duration.
7. Compare started work, queues, errors, and p95 in both runs. A quota can move waiting into the selected tenant's client queue; a low occupancy bar alone is not evidence of lower total latency.
8. Press **Pause** when finished. It stops scheduling, clears client queues and peaks, and cancels active HTTP work. **Reset** also clears counters and measured history. Browser closure alone does not stop the server-side experiment.

No screenshot or example chart is a substitute for running this sequence. Record the mode, time, rates, fixture artifact/version, limits, errors, and resource state with any reported comparison.

## Retained local deployment

The local deployment uses the private Kubernetes context described in [the deployment record](multi-tenancy-deployment-2026-10-26.md). The experiment runs as a separate private Deployment and ClusterIP Service named `tali-guard-tenant-lab` in namespace `tali`, on port **38110**. It has no host/public port. Its local-only resource settings are a 64 MiB memory request, 192 MiB memory limit, and 25m CPU request.

The retained Redis settings are now a **64 MiB memory request and 256 MiB memory limit**, recorded in the private `values-2g.yaml`. These replace the earlier 32 MiB request / 96 MiB limit for this local experiment; they do not change product defaults.

Controller is configured with:

```text
CONTROLLER_TENANT_LOAD_LAB_URL=http://tali-guard-tenant-lab:38110
```

The URL is an HTTP(S) origin reachable **from Controller**. It cannot include URL credentials, a query, a fragment, or a non-root path. An unset/unreachable service produces a 503 lab-unavailable response. The optional service is not part of ordinary Guard runtime request routing.

The deployed Controller feature image is `ghcr.io/tasklattice/tali-guard-controller:dev-tenant-lab`. On this one-CPU, approximately 2 GB Docker VM, the normal multi-stage Docker build competed with the live cluster and caused PostgreSQL/Redis out-of-memory restarts. The local feature image was therefore packaged from host-built `controller/dist` and `controller/dist-server` over the existing `:dev` image, retaining its Linux Node runtime and installed dependencies. This is a local resource-saving build path, valid here because the dependency manifest/lockfile was unchanged; it is not a substitute for updating dependencies when needed.

To reproduce that packaging approach, build on the host and use a small temporary Docker context containing only the compiled outputs:

```bash
npm run build:ui --prefix controller
npm run build:server --prefix controller
lab_build_context=$(mktemp -d)
cp -R controller/dist controller/dist-server "$lab_build_context/"
cat > "$lab_build_context/Dockerfile" <<'DOCKERFILE'
FROM ghcr.io/tasklattice/tali-guard-controller:dev
COPY --chown=65532:65532 dist /opt/tasklattice/guard-controller/dist
COPY --chown=65532:65532 dist-server /opt/tasklattice/guard-controller/dist-server
DOCKERFILE
docker build --pull=false \
  -t ghcr.io/tasklattice/tali-guard-controller:dev-tenant-lab \
  "$lab_build_context"
```

Load the resulting architecture-specific image into the private kind node using the image-import procedure in the deployment record before changing the local Controller image. Host `node_modules` and private fixture files are not copied into this image. The lab workload itself mounts its current script/configuration and has a **192 MiB memory limit**. The local replacements use Deployment strategy `Recreate`: on the one-CPU cluster, a rolling update's extra Pod can remain Pending with `Insufficient cpu`. Recreate avoids the surge request but briefly interrupts the local component; this is not a production availability strategy.

Private files retained under `.local-secrets/tenant-runtime-20261026/` include:

| File | Purpose |
| --- | --- |
| `identities.json` | Synthetic A/B/C credentials used by provisioning; never served to the browser. |
| `load-lab-fixtures.json` | Policy/Guardrail validation and publication IDs, dedicated Endpoint credentials, Router identities, and readiness evidence. |
| `load-lab-config.json` | Host-local workload configuration using the loopback Runner URL. |
| `load-lab-kubernetes-config.json` | Workload configuration using the internal Runner Service URL and the existing metrics token. |
| `tenant-lab-deployment.yaml` | Local Deployment and Service definition; the script is mounted from a ConfigMap at `/lab`, private configuration from a Secret at `/private`. |

These are ignored local state, not committed product configuration. Keep credential-bearing files mode 0600. The browser receives only aggregate state through the administrator proxy, never Endpoint keys, session cookies, model credentials, or raw workload configuration. The workload's own `/state` and `/control` endpoints have no separate user authentication; keep its Service private and use the Controller boundary for console access.

Inspect the retained service without printing its Secret:

```bash
kubectl --kubeconfig .local-secrets/tenant-runtime-20261026/kubeconfig \
  -n tali get deployment/tali-guard-tenant-lab service/tali-guard-tenant-lab
```

Reapply the retained local manifest only when intentionally restoring this experiment:

```bash
kubectl --kubeconfig .local-secrets/tenant-runtime-20261026/kubeconfig \
  -n tali apply -f .local-secrets/tenant-runtime-20261026/tenant-lab-deployment.yaml
```

This requires the corresponding private Secret and script ConfigMap to exist. The manifest alone cannot recreate missing credentials, published fixtures, or the Controller environment. The lab is an opt-in local overlay, not a new default Helm component.

## Local resource findings

Two distinct resource failures occurred on the approximately 2 GB local VM:

| Trigger | Observed failure | Local response |
| --- | --- | --- |
| Standard Docker build while the cluster was running | Build-time memory competition caused PostgreSQL/Redis out-of-memory restarts. | Build Controller outputs on the host and package the small feature-image overlay described above. |
| First quota-mode peak, 2026-10-26 at approximately 17:03:13 Asia/Shanghai | Redis was `OOMKilled` under its 96 MiB container limit. Real Runner Redis timeouts and HTTP 500 responses affected all three tenants. | Pause traffic, raise Redis to a 64 MiB request / 256 MiB limit in the private local overlay, and repeat the comparison after recovery. |

The failed peak is evidence of a shared infrastructure failure, not a clean shared-versus-quota latency comparison. Client-side admission limits did not isolate tenants from Redis failure. The larger Redis allocation allows another local measurement; it does not establish production sizing or guarantee that quota simulation protects neighbors. Read errors, restarts, and shared dependency health alongside the latency charts, and distinguish recovery/retest observations from the failed interval.

A subsequent baseline of approximately 18 total client pipelines/s also encountered database connection timeouts and Runner `httpx.ReadTimeout` errors after running for several minutes, without another recorded OOM. CPU/scheduling contention is a possible explanation, not an established cause. The final local tuning reduces baseline arrivals to 3–5 pipelines/s per tenant and the simulated quota to 10 starts/s per tenant; the four-pipeline simulated concurrency cap, 60-pipelines/s offered peak, and 120-starts/s global ceiling remain. Clean comparisons must be measured again under those settings rather than inferred from the failed runs.

## Host-local reproduction

For a workload process on the host, keep Controller and Runner loopback access available as described in the deployment record, then run from the repository root with Node 24:

```bash
TENANT_LOAD_LAB_CONFIG=.local-secrets/tenant-runtime-20261026/load-lab-config.json \
TENANT_LOAD_LAB_HOST=127.0.0.1 \
TENANT_LOAD_LAB_PORT=38110 \
node scripts/tenant-load-lab.mjs
```

A Controller also running on the host can use `CONTROLLER_TENANT_LOAD_LAB_URL=http://127.0.0.1:38110`. A Controller inside Kubernetes cannot reach the host's loopback address by that URL; use the private in-cluster Service for the deployed console. Likewise, a lab Pod needs `runnerBaseUrl` to name the internal Runner Service, typically `http://tali-guard-runtime:8091`, rather than a host port-forward.

The private configuration can assign a Runner and group to each tenant (omitting these fields preserves the single-Runner default):

```json
{
  "runnerBaseUrl": "http://127.0.0.1:38082",
  "peakRps": 60,
  "tenants": [
    {"id": "tenantA", "name": "Tenant A", "endpointId": "<owned-lab-endpoint-A>", "credential": "<private-endpoint-key-A>", "groupId": "default", "groupName": "A + B", "poolId": "default", "runnerBaseUrl": "http://runner-ab:8091"},
    {"id": "tenantB", "name": "Tenant B", "endpointId": "<owned-lab-endpoint-B>", "credential": "<private-endpoint-key-B>", "groupId": "default", "groupName": "A + B", "poolId": "default", "runnerBaseUrl": "http://runner-ab:8091"},
    {"id": "tenantC", "name": "Tenant C", "endpointId": "<owned-lab-endpoint-C>", "credential": "<private-endpoint-key-C>", "groupId": "group-demo", "groupName": "C", "poolId": "group-demo", "runnerBaseUrl": "http://runner-c:8091"}
  ]
}
```

The displayed group labels come from this private lab configuration. Before starting an experiment or triggering a peak, Controller verifies each configured tenant and pool against its persisted group membership. If an administrator changes membership, update the private lab configuration before starting more traffic; pausing remains available. A change to a pool runtime address also requires updating the lab target URL.

An optional global or per-tenant `runnerMetricsToken` field or `TENANT_LOAD_LAB_RUNNER_METRICS_TOKEN` environment variable supplies the existing metrics credential. Keep it in private configuration; do not paste it into documentation, screenshots, browser inputs, or shell command arguments.

## Recreate the dedicated fixtures

The shipped [provisioning helper](../scripts/provision-tenant-load-lab.mjs) uses native Node 24 and the supported Controller/Runner APIs. Start with a disposable installation containing the persisted A/B/C user accounts, the real Controller/Runner port-forwards, and their private identity file. The helper does not create accounts or alter existing Default smoke fixtures.

Inspect the definition and validate it offline first:

```bash
node scripts/provision-tenant-load-lab.mjs --help
node scripts/provision-tenant-load-lab.mjs --self-test
node scripts/provision-tenant-load-lab.mjs --definition
```

`--self-test` always checks the four fixture cases and local construction invariants. When built Controller modules are present under `controller/dist-server`, it additionally runs the actual Policy/Router schemas, declarative compiler, execution-plan builder, and inherited-test generator. Its JSON output distinguishes passed repository validation from a skipped check when those build outputs are absent. It does not contact a service or replace live Runner validation.

Provision or resume these dedicated fixtures explicitly:

```bash
GUARD_SMOKE_IDENTITIES_FILE=.local-secrets/tenant-runtime-20261026/identities.json \
GUARD_SMOKE_CONTROLLER_URL=http://127.0.0.1:38081 \
GUARD_SMOKE_RUNNER_URL=http://127.0.0.1:38082 \
GUARD_SMOKE_ORIGIN=http://localhost:38081 \
node scripts/provision-tenant-load-lab.mjs --execute
```

The origin must be trusted by this Controller. `GUARD_LAB_STATE_FILE` and `GUARD_LAB_CONFIG_FILE` can select alternate private output paths; defaults are `load-lab-fixtures.json` and `load-lab-config.json` under the local directory above. Preserve the state file for reruns: it pins account/resource identities and refuses to overwrite edited fixtures. All service URLs must be loopback addresses, and no service call happens without `--execute`.

The helper creates C's local Policy, executes its four tests, publishes it, then creates/tests/publishes the lab Guardrail and checks its four frozen cases. It shares that new Guardrail with A/B, creates each tenant's dedicated Endpoint/Router, applies the reviewed change request with an explicit local-lab emergency reason, and verifies all three Routers target the same signed artifact/version. Final probes check benign Input, blocked marker Output, and independent assignments for one raw call ID across A/B/C. C's Default access must remain denied before and after setup.

For the Pod, use the private `load-lab-kubernetes-config.json` with the internal Runner URL. Install/update the script ConfigMap and configuration Secret from files without printing their contents:

```bash
kubectl --kubeconfig .local-secrets/tenant-runtime-20261026/kubeconfig -n tali \
  create configmap tali-guard-tenant-lab \
  --from-file=tenant-load-lab.mjs=scripts/tenant-load-lab.mjs \
  --dry-run=client -o yaml | \
kubectl --kubeconfig .local-secrets/tenant-runtime-20261026/kubeconfig -n tali apply -f -
kubectl --kubeconfig .local-secrets/tenant-runtime-20261026/kubeconfig -n tali \
  create secret generic tali-guard-tenant-lab \
  --from-file=config.json=.local-secrets/tenant-runtime-20261026/load-lab-kubernetes-config.json \
  --dry-run=client -o yaml | \
kubectl --kubeconfig .local-secrets/tenant-runtime-20261026/kubeconfig -n tali apply -f -
kubectl --kubeconfig .local-secrets/tenant-runtime-20261026/kubeconfig -n tali \
  apply -f .local-secrets/tenant-runtime-20261026/tenant-lab-deployment.yaml
```

Restart the local lab Deployment after script/configuration changes so a running process reads them. Set the Controller environment URL shown above and restart the local Controller with its feature image. Starting/restarting the lab service leaves traffic stopped until Start is pressed.

## Final deployed comparison — 2026-10-26

The final comparison ran at approximately **22:33–22:35 Asia/Shanghai** against the deployed Runner after increasing Redis to 256 MiB. Both modes used a smoothly varying 3–5-pipeline/s baseline per tenant, a 60-pipeline/s offered peak for tenantA held for 30 seconds, the same three Endpoints/artifact, and the same 120 ms asynchronous fake model. Each mode collected 17 seconds of baseline and 35 observations spanning peak/recovery.

The numbers below are **medians of sampled rolling p95 measurements**, using 15 baseline samples and 30 peak samples, matching the page's neighbor-impact comparison. They are not a percentile over a combined request population.

| Mode | Tenant | Before peak | During peak | Median completion rate before → during | Errors/drops by end of observation |
| --- | --- | --- | --- | --- | --- |
| Shared | A | 341 ms | 2,974 ms | 4 → 31 pipelines/s | 792 |
| Shared | B | 352 ms | 2,826 ms | 4 → 4 pipelines/s | 0 |
| Shared | C | 352 ms | 2,930 ms | 4 → 3.5 pipelines/s | 0 |
| Client quota simulation | A | 566 ms | 3,777 ms | 4 → 10 pipelines/s | 1,475 |
| Client quota simulation | B | 559 ms | 438 ms | 4 → 4 pipelines/s | 0 |
| Client quota simulation | C | 568 ms | 409 ms | 4 → 4 pipelines/s | 0 |

In shared mode A reached 57 active client pipelines; B/C reached 14/13. In quota mode all three remained at or below four active client pipelines. A's queue-overflow events show deliberate rejection of excess offered traffic when its 32-record client queue is full. The combined error/drop counter does not separately attribute each increment to queue overflow or a failed HTTP pipeline. Read those counters as client load shedding alongside the measured latency, rather than treating a successful-request p95 as the full outcome.

The fake model's observed service p95 ranged **128–169 ms** during the shared peak and **122–137 ms** during the quota peak. Maximum observed model concurrency was 24 and 8 respectively, against a capacity of 1,024. It had no serial inference queue or external provider. The programmed delay stays 120 ms; CPU scheduling still affects measured response time.

Runner was ready in all 35 recorded observations per mode. Redis, Runner, Controller, and the final workload Pod had no new restarts during the comparison. A Docker snapshot near the shared peak reported approximately **1.27 GiB of 1.925 GiB used and 98% of the single CPU**. This establishes a usable bounded local demonstration, while also showing that CPU headroom is small at peak.

These are sequential, short local runs with random baseline rates and overlapping rolling latency windows. Baselines differ, and the quota run followed shared-load recovery. The lower B/C peak values in the quota run are observations, not evidence that a peak improves performance or a production isolation guarantee. The simulation constrains offered work before Runner; shared CPU, Redis, PostgreSQL, and Controller dependencies remain.

Private observation files and the summary are retained as `load-lab-final-shared-observations.json`, `load-lab-final-quota-observations.json`, and `load-lab-final-comparison.json` under `.local-secrets/tenant-runtime-20261026/`. Earlier failed/interrupted observations are separate files and were not substituted into this final table.

Verification completed: 429 focused Controller tests; 108 route/layout/RBAC tests (overlap with the previous group); 11 native workload tests; Controller typecheck, UI/server/CLI builds, OpenAPI generation/check (143 operations, 436 schemas), provisioning schema/compiler self-test, and whitespace checks. Live tenantA read/control requests returned 403 while the administrator could operate the page.

## Checks and limits of the evidence

Relevant checks are:

```bash
node --check scripts/provision-tenant-load-lab.mjs
node scripts/provision-tenant-load-lab.mjs --self-test
node --test scripts/tenant-load-lab.test.mjs
npm test --prefix controller -- \
  server/http/tenant-load-lab.test.ts \
  src/routes/tenant-load-lab.test.tsx
npm run typecheck --prefix controller
```

The workload tests cover rate/concurrency/queue bounds, cancellation, percentile calculation, concurrent fixed-delay model HTTP, and the Input/model/Output HTTP sequence. Their synthetic Runner responses do not replace a live deployed Runner check. Controller tests cover administrator authority, bounded controls, sanitized state, and service unavailability. UI tests cover presentation and controls.

Offline authoring validation for the dedicated fixture confirmed the actual Policy schema, declarative compiler, plan construction, four inherited cases, and Router schema. That establishes the fixture shape, not a measured load result. The deployed comparison above records the measured windows and configuration separately from these offline checks.

The experiment does not establish production sizing, tenant CPU accounting, enforced tenant budgets, external model performance, distributed load-generator accuracy, or statistically isolated causation. All tenants still share Runner compute, the same Guardrail-version admission semaphore, provider infrastructure, and the deployment trust boundary. Admission fairness exists only in the explicitly labeled generator simulation. Implementing actual Runner tenant isolation requires the authorization, placement, quota, and failure-containment changes described in the [audit](multi-tenancy-isolation-audit-2026-10-24.md).

## Two-group local smoke test — 2026-10-27

After assigning A/B to `default` and C to `group-demo`, each tenant's Input and Output checks succeeded on its assigned Runner. All three Endpoint credentials were rejected with HTTP 401 on the other Runner. Both Runner pools reported ready.

In a 30-second C peak offering 60 pipelines/s, C reached its 48-pipeline generator group ceiling and its bounded client queue dropped excess arrivals. A and B each continued to complete approximately 4 pipelines/s with no errors during the observed peak; their measured p95 increased while the groups shared the one-CPU local node. These are observations from this particular run, not an isolation guarantee or a production benchmark. The generator uses a 120 ms asynchronous fake model. The experiment was reset afterwards to provide a clean baseline for further testing.
