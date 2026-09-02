# TaskLattice Guard Helm Chart

Release builds package this Chart at `/opt/tali/helm/tali-guard.tgz` inside the
Controller image. The image exposes that path through `TALI_HELM_CHART`.

This chart deploys exactly two Guard application component types:

- **Guard Controller** — TypeScript UI/API, Better Auth, desired state,
  reconciliation, audit, telemetry ingest, and capacity views.
- **Guard Runner** — Python/NeMo data plane. `GuardRails 0` is the mandatory
  baseline pool and authoritative NeMo configuration compiler; `default` remains
  only its internal protocol ID. Every Runner pool is a StatefulSet, so instance
  IDs use stable ordinal Pod names such as `tali-guard-runner-0` instead of
  rollout-dependent hashes.

PostgreSQL and optional Redis are infrastructure dependencies, not additional
Guard application components.

## Images and dependencies

| Purpose | Default image/configuration | Required |
| --- | --- | --- |
| Controller | `ghcr.io/tasklattice/tali-guard-controller:0.2.0` | Yes, exactly one replica |
| Runner | `ghcr.io/tasklattice/tali-guard-runner:0.2.0` | Yes, GuardRails 0 >= 2 replicas |
| PostgreSQL | External PostgreSQL 14+ | Yes |
| Development PostgreSQL | `postgres:17-alpine` | Only when `postgresql.enabled=true` |
| Development Redis | `redis:7.4-alpine` | Local two-replica GuardRails 0 only |
| Redis | `runner.callContextRedisUrl` | Only when any Runner pool has more than one replica |

Integration setup instructions always target the stable Runtime Service through
its canonical in-cluster DNS name:
`http://<service>.<namespace>.svc.cluster.local:<service-port>`. Helm derives
the service, namespace, and port from the release. The endpoint contains no
Runner Pod or instance identity, never points at `controller.publicUrl`, and
does not require a manually maintained hostname.

LiteLLM stores that Integration base URL and appends its Basic Guardrail API
suffix (`/beta/litellm_basic_guardrail_api`) for runtime callbacks. Runner
implements that contract directly; Controller remains outside the request path.

Production image repositories/tags, dependency contracts, and low-overhead
metrics defaults live in [`values.yaml`](values.yaml).
[`values-debug.yaml`](values-debug.yaml) is the full Trace/Profile overlay. The
self-contained OrbStack/local profile lives in [`values-dev.yaml`](values-dev.yaml).

## OrbStack/local installation

The development profile contains explicitly marked local-only credentials and
an Ed25519 signing key, enables single-node PostgreSQL plus Redis infrastructure,
and asks Helm to generate and retain the control-channel mTLS CA and certificates.
Its baseline login is username `admin` and password `admin`. Controller maps
the username to the internal Better Auth email `admin@tasklattice.local`.

One command rebuilds the moving `:dev` images and installs or upgrades the
whole Guard release on the `orbstack` context:

```bash
make install
```

This single entry point upgrades an existing release or installs a missing one,
then waits for workload readiness (up to `HELM_TIMEOUT`, default `5m`). There is
no need to check whether it is already deployed. Cluster or permission errors
stop the command; they do not trigger an uninstall or clear data.

To deploy the same local environment with every performance-debug feature
enabled, use the Debug overlay entry point:

```bash
make install-debug
```

This is equivalent to applying `values-dev.yaml` followed by
`values-debug.yaml`; it preserves the separation between local infrastructure
and temporary observability overhead.

When the repository `.env` contains `QWEN_CONTROL_API_KEY`,
`QWEN_GUARD_API_KEY`, or `LLAMA_GUARD_API_KEY`, this target also creates or
updates the `tali-guard-provider-keys` Secret. The Qwen control model is used by
Controller authoring and optional TALI taxonomy refinement; configured native
Guard Providers are connected to every Runner pool.

The deployment helper can also be used after `make images`:

```bash
bash scripts/helm-upgrade.sh tali-guard ./charts/tali-guard orbstack tali \
  --values ./charts/tali-guard/values-dev.yaml \
  --wait --timeout 5m
```

The helper calls `helm upgrade` for an existing release, or `helm install
--create-namespace` for a missing one. It explicitly passes `--server-side=false`
to both paths: Helm 4.0.0's `upgrade --install` fallback does not forward this
option and can fail when reusing retained Secrets with
`metadata.managedFields must be nil`. Retained credentials and certificates are
reused, not deleted. An uninstalled release with retained history is reinstalled
with `--replace`; failed upgrades are reported without automatic reinstall.

Deployment-path regression tests run with
`.venv/bin/python -m pytest -q tests/contract/test_helm_upgrade.py`. To also test
install, upgrade, and reinstall with retained Secrets on a local cluster, prefix
the command with `GUARD_HELM_TEST_CONTEXT=orbstack`. This creates and removes an
isolated namespace containing only a test Secret and ConfigMap, not Guard data.

`make install` keeps both application tags fixed at `dev` and changes a
Helm-managed rollout revision annotation on every run. Controller and all
Runner pools therefore replace their Pods and load the latest local `dev`
images even though the image names remain unchanged. The command waits for Pod
readiness; use `make helm-status` to inspect the deployment at any time.

Check the deployment and access Controller:

```bash
make helm-status
```

Open <http://localhost:38081> directly and sign in with `admin` / `admin`. The
bootstrap operation only creates a missing Better Auth user; Controller restarts
and Helm upgrades do not reset a password that has subsequently been changed.
No port-forward process is required. A development-only data-plane Service is
exposed separately at <http://localhost:38082>;
its root returns component metadata, while protected traffic uses `/runtime/v1`.
The host-facing development endpoint remains `http://localhost:38082`, while
Integration setup instructions use
`http://tali-guard-runtime.tali.svc.cluster.local:8091` for callers
inside the cluster.

## Production installation

Keep `postgresql.enabled=false`. Provide a PostgreSQL URL through an existing
Secret, preferably created by the platform secret manager:

```bash
kubectl -n guard-system create secret generic guard-database \
  --from-literal=database-url='postgresql://guard:REDACTED@postgres.example:5432/guard'
```

Create a Better Auth bootstrap administrator Secret with a strong, unique
password. Production has no application default credentials, and the chart's
default minimum password length is 12:

```bash
kubectl -n guard-system create secret generic guard-bootstrap-admin \
  --from-literal=email='admin@example.com' \
  --from-literal=password='replace-with-a-long-random-password' \
  --from-literal=name='Administrator'
```

Create an asymmetric Ed25519 artifact-signing Secret:

```bash
openssl genpkey -algorithm ED25519 -out private-key.pem
openssl pkey -in private-key.pem -pubout -out public-key.pem
kubectl -n guard-system create secret generic guard-artifact-signing \
  --from-file=private-key.pem \
  --from-file=public-key.pem
```

Create `guard-control-tls` with these keys:

- `ca.crt`
- `tls.crt` and `tls.key` for the Controller server certificate
- `runner.crt` and `runner.key` for the Runner client certificate

The Controller certificate must be valid for the Controller Service DNS name.
Both certificates must chain to `ca.crt`. Production intentionally requires an
externally managed Secret instead of auto-generating a private CA.

To enable business-boundary generation, create a separate model credential
Secret:

```bash
kubectl -n guard-system create secret generic guard-control-plane-ai \
  --from-literal=api-key='replace-with-provider-key'
```

Then set `controlPlaneAgent.provider.existingSecret=guard-control-plane-ai` in
the production values file. `baseUrl`, `model`, `name`, and `secretKey` can
be overridden under the same values object.

Runtime model configuration is split in two. `models.runtimes` declares
reusable physical endpoints; `evaluators.bindings` maps a stable Evaluation
Contract and Evaluator Profile onto a runtime. Fallback is scoped to bindings
for the same contract, so a model is never used for a capability it does not
implement. Credentials are supplied through `models.credentials`. For example:

```yaml
models:
  runtimes:
    - id: qwen3guard
      client: openai_chat
      base_url: http://qwen3guard.models.svc.cluster.local/v1
      model: Qwen/Qwen3Guard-Gen-8B
      api_key_env_var: QWEN_GUARD_API_KEY
  credentials:
    existingSecret: tali-model-runtime-credentials

evaluators:
  bindings:
    - id: qwen-content
      contract_ref: tali.guard.content-safety.v1
      profile_ref: tali.qwen3guard.v1
      model_ref: qwen3guard
      priority: 10
```

See
[`docs/tali-safety-taxonomy-and-providers.zh-CN.md`](../../docs/tali-safety-taxonomy-and-providers.zh-CN.md)
for the complete contract.

Install with a private environment values file containing the actual public
URL, image tags, resource sizing, ingress, and Secret references. Helm loads
the chart's production `values.yaml` automatically:

```bash
helm upgrade --install tali-guard ./charts/tali-guard \
  --namespace guard-system \
  --create-namespace \
  --values ./values-company-production.yaml \
  --set database.existingSecret=guard-database \
  --set security.bootstrapAdmin.existingSecret=guard-bootstrap-admin \
  --set security.artifactSigning.existingSecret=guard-artifact-signing \
  --set security.controlTls.existingSecret=guard-control-tls \
  --set-string runner.callContextRedisUrl='redis://managed-redis.guard-system.svc:6379/0' \
  --rollback-on-failure \
  --wait \
  --timeout 15m
```

## Scaling contract

Controller remains one replica in this chart version. GuardRails 0 defaults to
two StatefulSet replicas with `minAvailable: 1`; the generated Pods are
`<release>-tali-guard-runner-0` and `-1`. Scale the data plane with
`runner.default.replicaCount` and `runner.pools`. Production must set
`runner.callContextRedisUrl` when any pool has more than one replica so
input/output checks for one request remain pinned to the same Guardrail
generation across Pods. The development profile provides its own Redis.

Every Runner pool gets a stable logical Runtime Service; individual Pod names
are never part of the upstream contract. Kubernetes performs ordinary balancing
with no session affinity. Input/output consistency comes from `call_id` and the
required shared Redis context when a pool has multiple replicas. Controller
Ingress exposes only the management UI/API, and protected runtime traffic never
traverses Controller.

Each pool also gets a private headless governing Service for StatefulSet network
identity. Upstream integrations continue to use only the load-balanced Runtime
Service; the headless Service and ordinal Pod names are not public endpoints.

## Prometheus and Grafana

Production defaults enable the authenticated Controller/Runner
ServiceMonitors, SLO recording and alerting rules, and both Grafana dashboards.
Full request tracing and continuous profiling remain disabled, so normal
production operation does not pay full-sampling or profiler overhead. A
Prometheus Operator and Grafana dashboard sidecar are therefore part of the
production platform contract; set their selector labels under
`serviceMonitor.labels` and `prometheusRule.labels` when required.

For an on-demand, full Runner performance-debug deployment, add the debug
profile after the private environment profile:

```bash
helm upgrade --install tali-guard ./charts/tali-guard \
  --namespace guard-system \
  --values ./values-company-production.yaml \
  --values ./charts/tali-guard/values-debug.yaml \
  --wait --timeout 15m
```

`performanceDebug.enabled=true` forces Runner tracing, continuous profiling,
both authenticated ServiceMonitors, the PrometheusRule, and both Grafana
dashboards on. It also overrides `observability.tracing.sampleRatio` to `1` so
every request can be followed from a latency exemplar to Tempo and Pyroscope.
Helm rejects the deployment if either backend address is missing.

The preset intentionally does not change per-GuardRail runtime logging levels
or enable content capture. In production it defaults to `false`. Removing the
debug overlay returns to production behavior: metrics, SLO rules, alerts, and
dashboards stay enabled, while full Trace/Profile collection stops. The debug
profile targets Tempo and Pyroscope in the `monitoring` namespace and uses
`release: monitoring`; override those values for a differently named stack.

`observability.slo` configures per-GuardRail availability, latency, complete
coverage, error-budget burn, and platform freshness budgets. The bundled
`GuardRails Overview` exposes only the ordered, cascading GuardRail,
Integration, and Runner filters. It opens with **System Overview · Global** for
system status, Runner fleet health, Controller uptime, Runner/evidence freshness, and
topology; that section is not narrowed by the business filters. **Traffic &
Latency · Selected scope** follows. Its throughput panel stacks mutually
exclusive allow, deny, transform, and technical-error checks so its height is
completed checks/s. Its one Latency panel keeps successful-check latency
semantics, renders P95 as the dominant line alongside P90 and P99, and lets the
panel legend isolate a percentile without changing the rest of the dashboard.
Availability, Protection Health, Integration SLI, and Runner Load/Health
follow; their tables and the collapsed Diagnostics latency views use fixed
P95. Deployment, version, phase, protocol, namespace, release, and Pool are not
Overview filters.
The bundled `GuardRails Troubleshooting` workbench keeps the same first three
selectors, then adds Provider, Model, and Action drilldowns. It separates
latency ownership, scoped technical failures, policy-trigger semantics,
module-level protection failures, global pre-auth entry failures, traces and
profiles, Pool/convergence state, and Runtime Evidence pipeline health.
The chart creates a retained `security.metrics` Bearer Secret and injects it
into Controller, every Runner, and both ServiceMonitors. Use
`security.metrics.existingSecret` when the platform owns secret rotation.
Roll Controller and Runner Pods after rotating that external token because it
is injected through environment variables.
The dashboard datasource UID is `tasklattice-prometheus`; change the Grafana
datasource UID during import only when the installation cannot provision that
stable UID. Full metric semantics, standalone Grafana provisioning paths, and
the product label-cardinality budget and upstream bypass boundary are in the repository's
`observability/README.md`.
