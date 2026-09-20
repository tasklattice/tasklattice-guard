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

Endpoint setup instructions always target the stable Runtime Service through
its canonical in-cluster DNS name:
`http://<service>.<namespace>.svc.cluster.local:<service-port>`. Helm derives
the service, namespace, and port from the release. The endpoint contains no
Runner Pod or instance identity, never points at `controller.publicUrl`, and
does not require a manually maintained hostname.

LiteLLM stores that Endpoint base URL and appends its Basic Guardrail API
suffix (`/beta/litellm_basic_guardrail_api`) for runtime callbacks. Runner
implements that contract directly; Controller remains outside the request path.

Production image repositories/tags, dependency contracts, and low-overhead
metrics defaults live in [`values.yaml`](values.yaml).
[`values-debug.yaml`](values-debug.yaml) is the full Trace/Profile overlay. The
self-contained OrbStack/local profile lives in [`values-dev.yaml`](values-dev.yaml).

## Everyday values and advanced overrides

`values.yaml` contains the normal deployment settings. Internal defaults load
without another `--values` file. Use `values-dev.yaml` for local public Services
and moving-image rollout revisions. `values-advanced.yaml` documents optional
SLO, sampling, password policy, and Pod security overrides; copy only the fields
needed by your environment. Existing advanced overrides remain supported.

`controller.publicUrl` accepts a non-empty string array (or a legacy single
string). The first entry is Better Auth's canonical base URL. All entries supply
trusted origins (scheme, host and port); duplicates and URL paths are removed
from the origin list. Ingress creates a rule for each distinct hostname:

```yaml
controller:
  publicUrl:
    - https://guard.company.com
    - https://guard-test.company.com
```

For local development, the profile includes both `http://localhost:38081` and
`http://localhost:8092` for the UI dev server. Explicit
`controller.trustedOrigins` replaces the derived list; explicit `ingress.host`
replaces the derived Ingress hostnames. Existing release values can retain these
overrides; remove stale overrides when changing public URLs. Additional trusted
origins do not change the canonical auth URL or share sessions across domains.
Ingress TLS certificates still need to cover the configured hostnames.

Controller and Runner image tags default to `Chart.appVersion`;
explicit `controller.image.tag` / `runner.image.tag` still take precedence.

Controller replicas are fixed at one. Internal ports are fixed at 8080/9090
(Controller), 8091 (Runner), 5432 (bundled PostgreSQL), and 6379 (bundled Redis).
The old `controller.replicaCount`, internal `service.*Port` / `service.port`,
and `serviceAccount.automount` values are ignored and should be removed from
custom values. External database/Redis URLs and local public Service ports
remain configurable. Ordinary Pods do not mount service-account tokens; the
credential initialization Job uses its own dedicated ServiceAccount.

## OrbStack/local installation

The development profile contains explicitly marked local-only credentials,
enables single-node PostgreSQL plus Redis infrastructure, and uses plaintext
gRPC with Runner Token authentication. A Helm bootstrap Job generates signing
keys and internal tokens directly in Kubernetes; rendering contains no private keys.
Its baseline login is username `admin` and password `password`. Controller maps
the username to the internal Better Auth email `admin@tasklattice.local`.

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

This is equivalent to applying `values-dev.yaml` followed by
`values-debug.yaml`; it preserves the separation between local infrastructure
and temporary observability overhead.

The install target does not read model configuration or credentials from the
repository `.env` and does not create Provider Secrets. Register models,
credentials, and capability assignments after deployment through the
Controller UI.

The deployment helper can also be used after `npm run images:build:dev`:

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

`npm run helm:deploy:dev` keeps both application tags fixed at `dev` and changes a
Helm-managed rollout revision annotation on every run. Controller and all
Runner pools therefore replace their Pods and load the latest local `dev`
images even though the image names remain unchanged. The command waits for Pod
readiness; use `npm run helm:status` to inspect the deployment at any time.

Check the deployment and access Controller:

```bash
npm run helm:status
```

Open <http://localhost:38081> directly and sign in with `admin` / `password`. The
bootstrap operation only creates a missing Better Auth user; Controller restarts
and Helm upgrades do not reset a password that has subsequently been changed.
No port-forward process is required. A development-only data-plane Service is
exposed separately at <http://localhost:38082>;
its root returns component metadata, while protected traffic uses `/runtime/v1`.
The host-facing development endpoint remains `http://localhost:38082`, while
Endpoint setup instructions use
`http://tali-guard-runtime.tali.svc.cluster.local:8091` for callers
inside the cluster.

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
`models`, and `evaluators` values are no longer read; remove them from private
values files as well. Legacy values retained by a previous Helm release are
ignored and do not override Settings. Existing model configurations saved in
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

## Scaling contract

Controller remains one replica in this chart version. GuardRails 0 defaults to
one StatefulSet replica in `values-dev.yaml` and two in production `values.yaml`,
with a minimum of one replica and `minAvailable: 1`; the production Pods are
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
identity. Upstream endpoints continue to use only the load-balanced Runtime
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

## Offline bootstrap password hash

The local profile stores a Better Auth scrypt hash for the initial `password`
login in `security.bootstrapAdmin.passwordHash`. The salt is included in the hash.
The database connection password remains a separate setting.

Generate a compatible hash offline, using the Controller's pinned Better Auth:

```bash
cd controller
printf '%s' 'password' | npm run --silent auth:hash-password
```

Set `security.bootstrapAdmin.email`, leave `password` empty, and paste the full
`salt:hash` output into `passwordHash`. Do not fill both password fields. An
existing bootstrap Secret can instead contain `password-hash` (configurable with
`passwordHashKey`), together with the usual email/name fields. Legacy Secrets with
`password` continue to work. Controller rejects Secrets containing both credentials.
For a non-Helm deployment use `CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD_HASH` instead of
`CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD`.

Hash import is a startup-only operation for a missing administrator. Existing
accounts keep their password, including passwords changed through the UI. Changing
Values does not reset an existing login. Import does not re-hash the hash, expose
an HTTP hash-import endpoint, or change Better Auth's normal password hashing.
Because an imported hash does not reveal password length, the minimum length
policy applies to plaintext setup and future password changes, not hash import.

## Automatic credentials and persistent CA

The default security configuration is:

```yaml
security:
  controlTls:
    enabled: true
  bootstrapAdmin:
    email: admin@example.com
    passwordHash: "<offline Better Auth salt:hash>"
    name: Administrator
```

A single initialization Job reuses the Controller image. On first installation it
creates Ed25519 artifact-signing keys, internal tokens, the log-encryption key,
and an ECDSA P-256 CA. That CA signs the Controller server and Runner client
certificates. Both the CA certificate and **CA private key** are persisted in the
TLS Secret, alongside the issued certificate/key pairs. Workload volumes select
only their leaf keys/certificates and the CA certificate; **neither Controller nor
Runner receives the CA private key**. Key generation uses a memory-backed temporary
volume. No private keys enter Values, the chart package, or Helm rendering.

Subsequent installs/upgrades/rollbacks validate and reuse existing credentials.
The CA signing routine can issue replacement certificates using the persisted CA
without changing the trust root. The initialization Job does not silently rotate
valid credentials. There is no background renewal controller: expired/incompatible
bundles fail clearly and require coordinated certificate renewal and workload
restart. A valid legacy bundle lacking a CA private key is preserved; its lost CA
private key cannot be recovered, so renewal needs an explicit CA migration.

All generated Secrets use the installation **Namespace** as their `ownerReference`,
with `helm.sh/resource-policy: keep` and ArgoCD prune/delete protection. Deleting a
Job, Deployment, Controller ConfigMap, or Helm release does not remove these
credentials. Reinstalling with the same release name/namespace reuses them.
Only explicit Secret deletion or deletion of the Namespace removes them.
Secrets previously owned by this release's Controller ConfigMap are migrated to
Namespace ownership without changing key data. External Secrets are not adopted.
The Controller ConfigMap is once again an ordinary Helm-managed configuration
resource; changing it triggers a Controller rollout through its checksum.

The initialization ServiceAccount can get/patch the named internal Secrets and
create Secrets. A narrowly scoped ClusterRole allows **get on this Namespace only**
to obtain its UID; it grants no namespace mutation or Secret access in other
namespaces. Installing the chart requires permission to create this RBAC.
Hook RBAC can remain after uninstall. ArgoCD maps Helm initialization hooks to
[PreSync](https://argo-cd.readthedocs.io/en/stable/user-guide/helm/#helm-hooks);
use a full sync, since selective sync does not execute hooks.

To use plaintext gRPC, set only `security.controlTls.enabled: false`; Runner Token
authentication and artifact signatures stay enabled. The local `values-dev.yaml`
already selects that mode and includes a bootstrap password hash and dependencies.
Set it to `true` to enable automatic mTLS without any other certificate settings.

The initialization Job and PostgreSQL readiness init container share
`controller.image` and `imagePullSecrets`. There are four local deployment images:
Controller, Runner, PostgreSQL and Redis. Use newly built/published Controller
images containing these runtime scripts; older releases do not contain them.

Internal Secret names/key fields are implementation defaults in
`files/security-defaults.yaml`, rather than a checklist in public Values. Existing
advanced `existingSecret`, custom CA and key-name overrides remain compatible.
External `controlTls.existingSecret` takes precedence over automatic issuance.
Legacy explicit `bootstrap.enabled: false` / `controlTls.autoGenerate: false`
remain supported, but new installations do not need those switches.

Existing Helm-owned internal Secrets are retained during a cluster-connected Helm
upgrade. Offline ArgoCD cannot perform `lookup` for this migration; prevent pruning
existing credentials before migrating an older GitOps deployment. New installations
render deterministically, with no generated private-key material.
