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
| Controller | `ghcr.io/tasklattice/tali-guard-controller:<Chart.appVersion>` | Yes, exactly one replica |
| Runner | `ghcr.io/tasklattice/tali-guard-runner:<Chart.appVersion>` | Yes, minimum 1; production defaults to 2 replicas |
| PostgreSQL | External PostgreSQL 14+ | Yes |
| Development PostgreSQL | `postgres:17-alpine` | Only when `postgresql.enabled=true` |
| Development Redis | `redis:7.4-alpine` | Included locally to support scaling beyond one Runner |
| Redis | `runner.callContextRedisUrl` | Only when any Runner pool has more than one replica |

Set top-level `publicUrl` once to configure the shared UI/Endpoint address and
Better Auth trusted origin. `runner.publicUrl` is only needed for a different
data-plane domain or deployment prefix and takes precedence for Endpoint setup.
If both are empty, Endpoint setup derives its scheme, hostname and port from
the incoming Controller request. Behind a reverse proxy, set `X-Forwarded-Host`
and `X-Forwarded-Proto` to the external address; the ingress must overwrite these
headers. Route `/runtime/v1/endpoints` to Runtime on that same origin.
Service calls without an HTTP request fall back to the origin of `CONTROLLER_PUBLIC_URL`.
The endpoint contains no Runner Pod identity.
The Controller's internal calls (including Playground) always use Service DNS,
independently of the advertised URL. `controller.publicUrl` configures
UI/auth when the shared `publicUrl` is empty.

LiteLLM stores that Endpoint base URL and appends its Basic Guardrail API
suffix (`/beta/litellm_basic_guardrail_api`) for runtime callbacks. Runner
implements that contract directly; Controller remains outside the request path.

Scan uses the same Endpoint base URL and appends `/backend/v1/scans`; its Bearer
credential must belong to the Endpoint UUID in the path. The chart's optional
Ingress routes `/runtime/v1/endpoints` to Runtime for both protocols. An external
VirtualService should route `/runtime/v1/endpoints/` to the Runtime Service on
8091 before its Controller catch-all rule. The old root `/backend/v1/scans` route
is no longer served.

### Share the UI domain and port with runtime requests

Use this minimal environment override with the chart defaults (namespace `uat`):

```yaml
fullnameOverride: tali-guard-uat
publicUrl: https://guard-uat.example.com:8443
runner:
  callContextRedisUrl: redis://redis.uat.svc.cluster.local:6379/0
database:
  existingSecret: tali-guard-uat-database
security:
  bootstrapAdmin:
    existingSecret: tali-guard-uat-bootstrap-admin
observability:
  serviceMonitor: { enabled: false }
  prometheusRule: { enabled: false }
  grafanaDashboard: { enabled: false }
```

`publicUrl` is the browser-facing HTTP(S) origin: scheme, hostname and optional
port, without credentials, path, query or fragment. Host casing, default ports
(HTTP 80 / HTTPS 443) and an optional trailing slash are normalized to match the
browser's Origin. It sets the UI/auth base URL, the advertised runtime base URL and the
trusted browser origin together; no duplicate `controller.publicUrl`,
`runner.publicUrl` or `controller.trustedOrigins` is needed. It overrides the
local Controller URLs in `values-dev-uat.yaml`. Remove a previously configured
`runner.publicUrl` when adopting the shared address (that field remains an
explicit data-plane override). The Controller appends the Endpoint UUID and
protocol path:

- Scan: `https://guard-uat.example.com:8443/runtime/v1/endpoints/<uuid>/backend/v1/scans`
- LiteLLM: `https://guard-uat.example.com:8443/runtime/v1/endpoints/<uuid>/beta/litellm_basic_guardrail_api`

Use the standalone [VirtualService example](examples/virtualservice-shared-host.yaml)
with the snippet above. It uses the chart's defaults directly and
assumes namespace `uat`, existing PostgreSQL and Redis, and two existing Secrets
in that namespace:

| Example Secret | Required keys |
| --- | --- |
| `tali-guard-uat-database` | `database-url`: PostgreSQL connection URL |
| `tali-guard-uat-bootstrap-admin` | `username`, `name`, login credential and optional `revision`; exact field names and overrides are in [account operations](../../docs/operations.md#bootstrap-account-operations) |

Replace the Secret names and Redis URL with your environment's values. The
example inherits ClusterIP Services, disabled Ingress, two Runner replicas,
internal mTLS and automatic internal credentials. Monitoring integrations are
disabled so it does not require Prometheus Operator/Grafana; omit its
`observability` block if your UAT uses those integrations. Images and resource
settings inherit chart defaults; retain environment-specific overrides as needed.

Replace the host, namespace, Gateway reference and destination Service names with your UAT
values. Keep existing release/Service naming when upgrading. Merge the data-plane
rule **before the catch-all** in the VirtualService already serving the UI; do
not create a competing catch-all for the same host. The chart does not install
this example automatically.

For the example naming, the rendered Controller configuration is:

```text
CONTROLLER_PUBLIC_URL=https://guard-uat.example.com:8443
BETTER_AUTH_TRUSTED_ORIGINS=https://guard-uat.example.com:8443
CONTROLLER_RUNTIME_PUBLIC_URL=https://guard-uat.example.com:8443
CONTROLLER_RUNTIME_SERVICE_URL=http://tali-guard-uat-runtime.uat.svc.cluster.local:8091
```

Runner callbacks and gRPC also continue to use the Controller Service on ports
8080 and 9090. No internal URL override is needed.

The existing Gateway and ingress load balancer must expose the chosen external
port (`8443` here); `VirtualService.hosts` contains only the hostname. TLS must
terminate at the Gateway or an upstream proxy so HTTP paths are available for
routing. The example sends the complete path unchanged to Runtime port `8091`
and all remaining UI/API paths to Controller port `8080`. It disables runtime
proxy retries and the route timeout to support LiteLLM WebSocket streams;
Runner/client deadlines and any gateway idle timeout still apply. See the
[Istio VirtualService reference](https://istio.io/latest/docs/reference/config/networking/virtual-service/).

For a separate runtime deployment prefix, override `runner.publicUrl`
(such as `https://runtime.example.com/guard`), also
match that prefix at the gateway and remove **only** `/guard` before forwarding;
preserve `/runtime/v1/endpoints/<uuid>/...`. The example above needs no rewrite.

Without Helm, configure `CONTROLLER_RUNTIME_PUBLIC_URL` on the Controller for
the advertised address and retain `CONTROLLER_RUNTIME_SERVICE_URL` for internal
calls. An empty runtime public URL uses the incoming Controller origin. Restart
the Controller after environment changes; Helm config changes trigger its
rollout automatically. Existing Endpoint IDs and credentials do not change;
reloading their details returns the newly configured address.

Production image repositories/tags, dependency contracts, and low-overhead
metrics defaults live in [`values.yaml`](values.yaml).
The only development/UAT profile is [`values-dev-uat.yaml`](values-dev-uat.yaml).
It preserves the local `tali-guard` release in namespace `tali` on ports
38081/38082; it does not create a separate migration target.

## Everyday values and advanced overrides

`values.yaml` contains deployment defaults and common configuration examples
for external URLs, Secrets, local Services, monitoring/debugging, SLOs and Pod
security. Internal defaults load automatically. Advanced Secret key-name overrides
are listed in [`files/security-defaults.yaml`](files/security-defaults.yaml); see
[account operations](../../docs/operations.md#bootstrap-account-operations) for the
external account Secret contract. Use `values-dev-uat.yaml` as the
only development override. There are no separate advanced, debug or migration
profiles; copy just the settings your environment needs from `values.yaml`.

This chart does not ship a `values.schema.json` file. Helm does not perform
JSON schema checks on Values, so internal deployment platforms can inject
metadata such as `global`, `labels` or `commonLabels` at any level.
Unknown or removed options are ignored by the chart; accepting a value does not
make it a supported setting. Extra metadata reaches Kubernetes resources only
when a chart template or the platform's rendering pipeline applies it.
Kubernetes resource and security-context objects remain pass-through settings.
Kubernetes and the application validate their own configuration when deployed.

Template checks cover deployment dependencies and conflicts: at least one
default Runner, database and account initialization, required Secrets and TLS,
shared Redis for multiple replicas, and destinations for enabled telemetry.
ServiceMonitor labels also preserve chart-owned resource identity.

The chart owns deployment, service exposure, infrastructure dependencies and
platform observability. Adapter behavior uses application defaults. The old
`runner.scan.maxBodyBytes` and `runner.scan.timeoutSeconds` values have no effect
and should be removed from custom values; the chart no longer injects
Scan environment variables. Runner currently defaults to a 1 MiB request body
and a 25-second Scan timeout. UI controls for those limits are separate work.

The development values list only overrides. Images, ports, dependency defaults
and security defaults are inherited; the debug CLI adds telemetry settings to
the same development values, without another values file.

For ordinary shared-domain deployments, use just:

```yaml
publicUrl: https://guard.company.com:8443
```

Better Auth's trusted origin and Ingress host are derived automatically. Its
origin check includes scheme and port; the gateway's internal Service destination
is not a browser origin. `publicUrl` is always included even when extra browser
origins are supplied through `controller.trustedOrigins`. That field does not
change the canonical auth URL or share sessions across domains.

For a separate data-plane domain, add only the override:

```yaml
publicUrl: https://guard.company.com
runner:
  publicUrl: https://runtime.company.com
```

UI-only/multi-URL configurations use the Controller URL settings when top-level
`publicUrl` is empty. `controller.publicUrl` accepts a non-empty string array or
a single string; the first entry is Better Auth's canonical base URL. All entries
derive trusted origins (scheme, host, port) and distinct Ingress hosts. Without
a shared URL, an explicit `controller.trustedOrigins` continues to replace the
derived list for compatibility. The local development profile uses this mode
for `http://localhost:38081` and the UI dev server `http://localhost:8092`.
With its Runtime LoadBalancer enabled, Endpoint setup advertises
`http://localhost:38082`; internal Controller calls still use Service DNS.

Explicit `ingress.host` still replaces derived Ingress hostnames. Remove stale
host/origin overrides when changing environments. Ingress TLS certificates must
cover the configured hostnames. Changing `publicUrl` updates the Controller
configuration and triggers its rollout; the gateway must already route the new
hostname and data-plane paths.

Controller and Runner image tags default to `Chart.appVersion`;
explicit `controller.image.tag` / `runner.image.tag` still take precedence.

Controller replicas are fixed at one. Internal ports are fixed at 8080/9090
(Controller), 8091 (Runner), 5432 (bundled PostgreSQL), and 6379 (bundled Redis).
The old `controller.replicaCount`, internal `service.*Port` / `service.port`,
and `serviceAccount.automount` values are silently ignored and must be removed from
custom values. External database/Redis URLs and local public Service ports
remain configurable. For public Services of type `NodePort`, `public.port` sets
the Service port, not the node port; Kubernetes allocates the node port, and this
chart does not expose a fixed `nodePort` override.

`postgresql.enabled=true` and `database.existingSecret` are mutually exclusive,
as are `redis.enabled=true` and `runner.callContextRedisUrl`. A login minimum
above eight characters requires external account Secrets for every enabled
bootstrap account (including the default user, unless disabled).

Ordinary Pods do not mount service-account tokens; the
credential initialization Job uses its own dedicated ServiceAccount.

## OrbStack/local installation

The development profile initializes the built-in accounts,
enables single-node PostgreSQL plus Redis infrastructure, and inherits mTLS
with Runner Token authentication. A Helm bootstrap Job generates signing
keys and internal tokens directly in Kubernetes; rendering contains no private keys.
Its `admin` and `user` accounts sign in through Better Auth's Username plugin;
email login is disabled. See [account operations](../../docs/operations.md#bootstrap-account-operations)
for their initial credentials.

One command rebuilds the moving `:dev` images and installs or upgrades the
whole Guard release on the `orbstack` context:

```bash
npm run helm:deploy:dev
```

This single entry point upgrades an existing release or installs a missing one,
then waits for workload readiness (up to `HELM_TIMEOUT`, default `5m`). There is
no need to check whether it is already deployed. Cluster or permission errors
stop the command; they do not trigger an uninstall or clear data.

To deploy the same local environment with every performance-debug feature
enabled, use the Debug overlay entry point:

```bash
npm run helm:deploy:dev:debug
```

Both commands use `values-dev-uat.yaml`. The debug command additionally enables
`observability.performanceDebug` and supplies Tempo/Pyroscope URLs and monitoring
selector labels through Helm flags. Override its local defaults using
`HELM_OTLP_ENDPOINT`, `HELM_PYROSCOPE_ADDRESS`, and `HELM_MONITORING_RELEASE`;
use `--set` for the debug switch and `--set-string` for backend/label overrides
after `--` to replace these CLI defaults. `HELM_DEBUG_VALUES` is retired.

The install target does not read model configuration or credentials from the
repository `.env` and does not create Provider Secrets. Register models,
credentials, and capability assignments after deployment through the
Controller UI.

The deployment helper can also be used after `npm run images:build:dev`:

```bash
bash scripts/helm-upgrade.sh tali-guard ./charts/tali-guard orbstack tali \
  --values ./charts/tali-guard/values-dev-uat.yaml \
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

`npm run helm:deploy:dev` keeps both application tags fixed at `dev` and changes a
Helm-managed rollout revision annotation on every run. Controller and all
Runner pools therefore replace their Pods and load the latest local `dev`
images even though the image names remain unchanged. The command waits for Pod
readiness; use `npm run helm:status` to inspect the deployment at any time.

Check the deployment and access Controller:

```bash
npm run helm:status
```

Open <http://localhost:38081> directly and sign in with the image-provided local `admin` login.
Every initialization Job run (including Helm installs, upgrades and rollbacks)
overwrites managed account Secrets with the image-provided credentials and a new
revision. Controller reapplies mounted credentials at startup and after Secret
updates, retaining account IDs and resource ownership but revoking previous
sessions. A login key changed in the UI is therefore reset by reinitialization or
a Controller restart. External account Secrets are never modified by the Job;
Controller synchronizes their mounted credentials through the same path. See
[account operations](../../docs/operations.md#bootstrap-account-operations).
No port-forward process is required. A development-only data-plane Service is
exposed separately at <http://localhost:38082>;
its root returns component metadata, while protected traffic uses `/runtime/v1`.
Endpoint setup advertises `http://localhost:38082` with this local profile.
Callers inside the cluster can instead use
`http://tali-guard-runtime.tali.svc.cluster.local:8091`; Controller's internal
calls always use that Service address.

## Production installation

Internal credentials, the CA and mTLS certificates are initialized automatically.
Configure the database/Redis connections and the initial administrator. For TLS,
the only normal setting is `security.controlTls.enabled` (default `true`).
No CA, signing key, Token, or External Secrets operator is required in Values.
See [automatic credentials](#automatic-credentials-and-persistent-ca) for lifecycle details.

### Optional externally managed credentials

The following workflow is an alternative for installations whose platform manages
credentials and certificates centrally; it is not required by the default setup.

Keep `postgresql.enabled=false`. Provide a PostgreSQL URL through an existing
Secret, preferably created by the platform secret manager:

```bash
kubectl -n guard-system create secret generic guard-database \
  --from-literal=database-url='postgresql://guard:REDACTED@postgres.example:5432/guard'
```

For an externally managed administrator, have the platform provision an account
Secret and set `security.bootstrapAdmin.existingSecret`. Use the Controller
runtime's account field contract, or configure its field-name overrides. Otherwise
set only the administrator username/name and let the initialization Job create it.

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
Both certificates must chain to `ca.crt`. Providing this external Secret replaces
the chart's automatic CA/certificate initialization for this installation.

If the Controller and Runners connect to HTTPS model Providers whose server
certificates are issued by a private CA, create a Secret containing the PEM CA
certificate and configure it once for both planes:

```bash
kubectl -n guard-system create secret generic guard-model-provider-ca \
  --from-file=ca.crt=company-root-ca.crt
```

```yaml
security:
  customCa:
    existingSecret: guard-model-provider-ca
    certificateKey: ca.crt
```

The chart mounts that Secret key read-only at
`/etc/ssl/certs/tasklattice-custom-ca.crt` in the Controller and every Runner
Pod. When the externally managed Secret is rotated, restart the workloads so
the `subPath` mount receives the new certificate.

Model configuration is managed in **Settings → Providers / Models / Guardrail
Catalog** and persisted in the Controller database:

- Register Providers and their credentials, then register Models.
- Validate and save the Control Plane Chat model to use it for Policy authoring
  and Playground generation. Runner activation is not required.
- Validate and save Input / Output Rail capability bindings, then use
  **Activate on Runner** to distribute them to Runners.

Helm configures deployment infrastructure: images, resources, networking,
databases, and platform Secrets. It does not configure model endpoints,
model credentials, or evaluator bindings. The removed `controlPlaneAgent`,
`models`, and `evaluators` values are silently ignored; remove them from private
values files and do not reuse stale values from a previous Helm release.
Existing model configurations saved in
the Controller database are preserved across Helm upgrades.

Install with a private environment values file containing the actual public
URL, resource sizing, ingress, and Secret references. Image tags default to the
packaged Chart appVersion and only need overrides for custom builds. Helm loads
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

## Guardrail import/export

File import and export work in every installation without package signing keys,
source IDs, trusted-source ConfigMaps or environment checks. Export immutable
versions, then choose the `.guardrail.zip` file in **Import Guardrail package**.
Identical versions are skipped; conflicting immutable content is rejected.
The retired `controller.promotion` configuration is silently ignored; remove it from
custom values. No promotion material is mounted into the Controller.

Development uses only `values-dev-uat.yaml`; there is no separate migration
target profile or pair-deployment command. Import/export works between any
ordinary installations.
Default is preconfigured once during initial installation, with local protections
and a bundled immutable version. It follows the same edit, test, publish and
delete workflow as any Guardrail. Startup preserves changes and deletions.
Router rules and Fallback targets explicitly select the versions serving traffic;
there is no global runtime baseline or startup package setting.

## Scaling contract

Controller remains one replica in this chart version. GuardRails 0 defaults to
one StatefulSet replica in `values-dev-uat.yaml` and two in production `values.yaml`,
with a minimum of one replica and `minAvailable: 1`; the production Pods are
`<release>-tali-guard-runner-0` and `-1`. Scale the data plane with
`runner.default.replicaCount` and `runner.pools`. Production must set
`runner.callContextRedisUrl` when any pool has more than one replica so
input/output checks for one request remain pinned to the same Guardrail
generation across Pods. The development profile provides its own Redis.

Every Runner pool gets a stable logical Runtime Service; individual Pod names
are never part of the upstream contract. Kubernetes performs ordinary balancing
with no session affinity. Input/output consistency comes from `call_id` and the
required shared Redis context when a pool has multiple replicas. The optional
Ingress routes `/runtime/v1/endpoints` directly to Runtime and other paths to
Controller UI/API; protected runtime traffic never traverses Controller.

Each pool also gets a private headless governing Service for StatefulSet network
identity. Upstream endpoints continue to use only the load-balanced Runtime
Service; the headless Service and ordinal Pod names are not public endpoints.

## Prometheus and Grafana

Production defaults enable the authenticated Controller/Runner
ServiceMonitors, SLO recording and alerting rules, and both Grafana dashboards.
Full request tracing and continuous profiling remain disabled, so normal
production operation does not pay full-sampling or profiler overhead. A
Prometheus Operator and Grafana dashboard sidecar are therefore part of the
production platform contract; set their selector labels under
`observability.serviceMonitor.labels` and `observability.prometheusRule.labels`
when required.

Use `observability.serviceMonitor.labels` to add the same metadata labels to
both the Controller and Runner ServiceMonitors:

```yaml
observability:
  serviceMonitor:
    enabled: true
    labels:
      release: "monitoring"
      team: "platform"
```

Set `release` to the value expected by your Prometheus ServiceMonitor selector.
These labels only extend each ServiceMonitor's `metadata.labels`; they do not
change its Service selector, target labels, or scraped metric labels. The
default is `{}`, which adds no custom labels. The same configuration applies
when `observability.performanceDebug.enabled` forces ServiceMonitors on.

All label values must be strings. Quote numeric or boolean-looking YAML values
(for example, `build: "123"` and `enabled: "true"`), and use `--set-string` for
CLI overrides. Kubernetes requires string values for resource labels.
Helm's standard `null` override removes a label before rendering; for
example, `--set observability.serviceMonitor.labels.team=null` removes `team`
inherited from a values file.

When rendering ServiceMonitors, Helm rejects any custom entry using one of
these chart-generated label keys, even if the supplied value matches:

- `helm.sh/chart`
- `app.kubernetes.io/name`
- `app.kubernetes.io/instance`
- `app.kubernetes.io/version`
- `app.kubernetes.io/managed-by`
- `app.kubernetes.io/part-of`
- `app.kubernetes.io/component`

The error identifies `observability.serviceMonitor.labels` and the reserved
key so it can be removed from your overrides.

For an on-demand, full Runner performance-debug deployment, override the
telemetry settings on your environment values:

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

`performanceDebug.enabled=true` forces Runner tracing, continuous profiling,
both authenticated ServiceMonitors, the PrometheusRule, and both Grafana
dashboards on. It also overrides `observability.tracing.sampleRatio` to `1` so
every request can be followed from a latency exemplar to Tempo and Pyroscope.
Helm rejects the deployment if either backend address is missing.

The preset intentionally does not change per-GuardRail runtime logging levels
or enable content capture. In production it defaults to `false`. Setting the
preset back to `false` returns to production behavior: metrics, SLO rules, alerts, and
dashboards stay enabled, while full Trace/Profile collection stops. The example
targets Tempo and Pyroscope in the `monitoring` namespace and uses
`release: monitoring`; override those values for a differently named stack.

`observability.slo` configures per-GuardRail availability, latency, complete
coverage, error-budget burn, and platform freshness budgets. The bundled
`GuardRails Overview` exposes only the ordered, cascading GuardRail,
Endpoint, and Runner filters. It opens with **System Overview · Global** for
system status, Runner fleet health, Controller uptime, Runner/evidence freshness, and
topology; that section is not narrowed by the business filters. **Traffic &
Latency · Selected scope** follows. Its throughput panel stacks mutually
exclusive allow, deny, transform, and technical-error checks so its height is
completed checks/s. Its one Latency panel keeps successful-check latency
semantics, renders P95 as the dominant line alongside P90 and P99, and lets the
panel legend isolate a percentile without changing the rest of the dashboard.
Availability, Protection Health, Endpoint SLI, and Runner Load/Health
follow; their tables and the collapsed Diagnostics latency views use fixed
P95. Router, version, phase, protocol, namespace, release, and Pool are not
Overview filters.
The bundled `GuardRails Troubleshooting` workbench keeps the same first three
selectors, then adds Provider, Model, and Action drilldowns. It separates
latency ownership, scoped technical failures, policy-trigger semantics,
module-level protection failures, global pre-auth entry failures, traces and
profiles, Pool/convergence state, and Runtime Evidence pipeline health.
The initialization Job creates a retained `security.metrics` Bearer Secret and injects it
into Controller, every Runner, and both ServiceMonitors. Use
`security.metrics.existingSecret` when the platform owns secret rotation.
Roll Controller and Runner Pods after rotating that external token because it
is injected through environment variables.
The dashboard datasource UID is `tasklattice-prometheus`; change the Grafana
datasource UID during import only when the installation cannot provision that
stable UID. Full metric semantics, standalone Grafana setup, and the product
label-cardinality budget and upstream bypass boundary are in the repository's
[observability guide](../../docs/observability.md).

## In-cluster account initialization

The image initializes `admin` and `user` with their corresponding roles.
Configure `username` and `name`, or supply `existingSecret`.
Set `security.bootstrapUser.enabled=false` to omit the second account.

Managed account Secrets are overwritten on every initialization Job run.
Controller applies mounted account revisions while retaining account IDs and
resource ownership; previous sessions are revoked.

See [account operations](../../docs/operations.md#bootstrap-account-operations)
for initial credentials, Secret fields, Base64 inspection, reset behavior, and
migration of existing users.

## Automatic credentials and persistent CA

The default security configuration is:

```yaml
security:
  controlTls:
    enabled: true
  bootstrapAdmin:
    username: admin
    name: Administrator
```

A single initialization Job reuses the Controller image. On first installation it
creates bundled database credentials, account logins, Ed25519 artifact-signing keys,
internal tokens, the log-encryption key,
and an ECDSA P-256 CA. That CA signs the Controller server and Runner client
certificates. Both the CA certificate and **CA private key** are persisted in the
TLS Secret, alongside the issued certificate/key pairs. Workload volumes select
only their leaf keys/certificates and the CA certificate; **neither Controller nor
Runner receives the CA private key**. Key generation uses a memory-backed temporary
volume. No private keys enter Values, the chart package, or Helm rendering.

Subsequent installs/upgrades/rollbacks reset managed account credentials and
validate/reuse infrastructure credentials.
The CA signing routine can issue replacement certificates using the persisted CA
without changing the trust root. The initialization Job retains valid infrastructure credentials. There is no background renewal controller: expired/incompatible
bundles fail clearly and require coordinated certificate renewal and workload
restart. A valid certificate bundle without a CA private key is preserved; its lost CA
private key cannot be recovered, so renewal needs an explicit CA migration.

All generated Secrets use the installation **Namespace** as their `ownerReference`,
with `helm.sh/resource-policy: keep` and ArgoCD prune/delete protection. Deleting a
Job, Deployment, Controller ConfigMap, or Helm release does not remove these
credentials. Reinstalling with the same release name/namespace reuses infrastructure Secrets
and resets managed accounts.
Only explicit Secret deletion or deletion of the Namespace removes them.
Secrets owned by other resources are rejected without modifying key data.
External Secrets are not adopted.
The Controller ConfigMap is an ordinary Helm-managed configuration
resource; changing it triggers a Controller rollout through its checksum.

The initialization ServiceAccount can get/patch the named internal Secrets and
create Secrets. A narrowly scoped ClusterRole allows **get on this Namespace only**
to obtain its UID; it grants no namespace mutation or Secret access in other
namespaces. Installing the chart requires permission to create this RBAC.
Hook RBAC can remain after uninstall. ArgoCD maps Helm initialization hooks to
[PreSync](https://argo-cd.readthedocs.io/en/stable/user-guide/helm/#helm-hooks);
use a full sync, since selective sync does not execute hooks.

To use plaintext gRPC, set only `security.controlTls.enabled: false`; Runner Token
authentication and artifact signatures stay enabled. The local `values-dev-uat.yaml`
inherits the default mTLS mode and initializes local accounts and dependencies.
Automatic mTLS needs no other certificate settings.

The initialization Job, PostgreSQL readiness init container, and Helm test Pod
share `controller.image`, its pull policy, and `imagePullSecrets`. The Helm test
uses Node.js HTTP health checks, so it needs no BusyBox or other tools image.
There are four local deployment images: Controller, Runner, PostgreSQL and Redis.
Controller and Runner remain separate artifacts. Jobs, init containers and tests
reuse the applicable application image without introducing a separate tools image.
The local profile sets `Never` for all images and requires them to be preloaded.

Internal Secret names/key fields are implementation defaults in
`files/security-defaults.yaml`, rather than a checklist in public Values. See
[account operations](../../docs/operations.md#bootstrap-account-operations) for
external account Secret fields and their overrides. The login policy uses
`controller.auth.minLoginLength`.
External `controlTls.existingSecret` takes precedence over automatic issuance.
To disable initialization, supply all required externally managed Secrets.
New installations do not need `bootstrap.enabled` or `controlTls.autoGenerate` overrides.

All chart-owned Secrets are created by the initialization Job; no Secret resource
or generated data is rendered by Helm. Managed names use an `-init` suffix (with
a hash for long names). The Job creates missing managed Secrets and validates
existing ones. Infrastructure key data and database logins are retained; managed
account logins are reset. External Secrets are referenced as supplied and are not
copied or modified.

The bundled PostgreSQL uses its managed Secret as the source of truth for the
configured database account. Before serving, an init container synchronizes that
account through a private local connection, preserving existing database data.
The serving database keeps its normal authentication configuration. Startup fails
if synchronization cannot complete; it never recreates a missing database role.
This uses the existing Controller and PostgreSQL images, with no extra image.

If the managed database Secret is deleted, rerun initialization and restart both
PostgreSQL and Controller to load the recreated credentials. Helm upgrades restart
both automatically when the bundled database is enabled. Repeating initialization
alone reuses an existing Secret. External databases are never modified.

Back up persistent data and all Secrets together. Other lost signing or encryption
keys cannot be recovered by synchronizing the database account. GitOps
installations must run the bootstrap hook before starting workloads.

Supply credentials through the referenced Secrets.
Use current complete Values with `--reset-values` rather than retaining removed
fields through `--reuse-values`. Removed chart options are ignored and no longer
configure the application. Rebuild and publish the Controller image before using
this chart; its initialization protocol and mounted-account support must match
the templates.

## Redis capacity and context degradation

Bundled Redis now starts with `redis.maxmemory: 4gb` (4 GiB),
`redis.maxmemoryPolicy: noeviction`, and a 6 GiB container memory limit. Redis
memory accounting is not identical to container RSS; the remaining headroom
covers allocator overhead and transient operations. A memory limit reduces OOM
risk but is not a guarantee against an unusually large allocation.

All Runner pools receive these settings:

```yaml
runner:
  callContext:
    ttlSeconds: 300
    compressPlans: true
    capacityFallback: true
redis:
  maxmemory: 4gb
  maxmemoryPolicy: noeviction
  resources:
    limits:
      memory: 6Gi
```

An external Redis must be configured separately with an appropriate memory
budget and `noeviction`; Helm does not change managed Redis configuration.
Compression requires every shared-context reader to support the new encoding.
For an upgrade from an older binary, deploy compatible readers with
`compressPlans: false` first, then enable writes. TTL is not refreshed by
outcome/completion updates.

With capacity fallback enabled, Redis allocation errors stop context writes and
history buffering for the current request. Existing readable context remains
usable. If context is missing and Redis reports exhausted memory, the request
is checked independently against the currently published route and current
supplied content. This includes correlated output: it can no longer claim the
original input's version pin, history, cumulative outcome, or completion
idempotency. No local unbounded replacement cache is created. Detection is not
bypassed; connection/authentication errors, corrupt plans, and normal context
expiration still fail normally. A missing context after capacity recovers is
not automatically treated as a capacity failure.

Responses requested with `x-guard-evidence: evaluations-v1` include
`context.status: degraded`, `reason: redis_capacity`, and `historyAvailable`.
Controller traces contain `context:redis-capacity`. Debug body-correlation
failures preserve the current audit event and set `callCaptureIncomplete` and
`callCaptureUnavailableReason: redis_capacity`.

The authenticated Runner `/metrics` endpoint exposes shared Redis used/max
memory and availability, plus `guard_runner_context_degraded_total` by operation.
Redis credentials need `INFO memory` permission; no keys or contents enter these
metrics. The existing ServiceMonitor scrapes them. Helm's PrometheusRule adds:

- memory above 80% for 5 minutes (warning);
- memory above 95% for 1 minute (critical);
- context allocation/history degradation within 5 minutes (warning);
- capacity metrics unavailable for 1 minute (critical);
- no configured memory limit for 5 minutes (warning).

Enable `observability.serviceMonitor.enabled` and
`observability.prometheusRule.enabled` when Prometheus Operator is installed.
The self-contained development preset keeps them disabled. Alertmanager
notification destinations remain an environment-level configuration. Recovery
requires both memory headroom and successful new context writes; reducing TTL
or evicting active assignments is not a recovery procedure.
