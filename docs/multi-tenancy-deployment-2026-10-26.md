# Local deployment and live tenant runtime verification

Verified on **2026-10-26**, Asia/Shanghai, using `feat/multi-tenant-v2` at `6044b72` plus the local Docker-context fix described below. This supersedes the environment-readiness assessment from [2026-10-24](multi-tenancy-local-testing-2026-10-24.md); the [resource-isolation limitations](multi-tenancy-isolation-audit-2026-10-24.md) remain unchanged.

## Result

**The reduced stack is deployed and ready for shared-Runner logical multi-tenancy tests. Tenant-specific Runner placement, compute quotas, and fairness are still not implemented.** Increasing Docker memory enables the deployment; it does not introduce those isolation features.

- Fresh kind cluster: `guard-tenants`, context `kind-guard-tenants`.
- Namespace/release: `tali` / `tali-guard`, Helm revision 1.
- Controller, one compiler-capable Runner, PostgreSQL 17, and Redis 7.4 are ready.
- Controller and Runner images were built from this checkout; no older cached Guard application image was used.
- Internal control uses the chart's mTLS configuration and signed artifacts.
- No external detection model, local model server, monitoring stack, or mock SSO chooser was enabled.
- The deployment, synthetic tenant fixtures, and Controller/Runner port-forwards are retained for further local testing.

Local access:

| Service | URL |
| --- | --- |
| Console and management API | <http://localhost:38081> |
| Runner readiness | <http://localhost:38082/health/ready> |
| Runtime Endpoint base | `http://localhost:38082/runtime/v1/endpoints/<endpoint-id>` |

The console root, `/health/ready`, `/ui-version.json`, and Runner readiness returned HTTP 200. The Runner reported Controller connected, desired state synchronized, generation 5 applied, and one active/prewarmed Guardrail version.

## Measured resources

Docker Desktop exposes one CPU and **2,066,731,008 bytes RAM**, approximately 1.925 GiB. A single-node kind control plane used about 607 MiB before the application was installed. One CoreDNS replica was retained for this local-only cluster.

After the real runtime smoke, the entire kind node used approximately **1,019 MiB / 1.925 GiB**. This is a point-in-time working-set observation, not a load-test peak or production sizing guarantee.

Application container working sets sampled after the smoke:

| Container | Bytes | Approximately |
| --- | --- | --- |
| Controller | 174,927,872 | 167 MiB |
| Runner | 140,554,240 | 134 MiB |
| PostgreSQL | 47,562,752 | 45 MiB |
| Redis | 12,668,928 | 12 MiB |

All four application Pods were ready, with **zero container restarts** and no recorded prior termination reason. The Helm test Pod completed successfully. No sustained traffic, model-backed checks, or two-Runner workload was measured.

## Test-only configuration

The ordinary development values were combined with this private overlay. The product defaults were not changed:

```yaml
controller:
  service:
    public:
      enabled: false
  resources:
    requests: {cpu: 25m, memory: 128Mi}
    limits: {memory: 384Mi}
runner:
  publicUrl: http://localhost:38082
  default:
    replicaCount: 1
    maxConcurrency: 1
    resources:
      requests: {cpu: 50m, memory: 384Mi}
      limits: {memory: 768Mi}
  service:
    public:
      enabled: false
postgresql:
  resources:
    requests: {cpu: 25m, memory: 96Mi}
    limits: {cpu: 500m, memory: 256Mi}
redis:
  resources:
    requests: {cpu: 10m, memory: 32Mi}
    limits: {cpu: 250m, memory: 96Mi}
```

Memory requests total 640 MiB and application memory caps total 1,504 MiB. The measured workload fit, but the caps plus Kubernetes overhead are not a guarantee that every component can simultaneously reach its cap inside this VM. Use this configuration for a small serial smoke, not capacity certification. `maxConcurrency: 1` is per Guardrail version; it does not establish a whole-Runner or tenant quota.

Private local files are under `.local-secrets/tenant-runtime-20261026/`:

- `kind.yaml`, `kubeconfig`, `values-2g.yaml`: the isolated cluster and deployment configuration.
- `identities.json`: disposable tenantA/B/C login credentials, mode 0600.
- `provision-accounts.mjs`: internal Better Auth provisioning for those synthetic accounts.
- `runtime-smoke.mjs`: native Node acceptance script.
- `runtime-fixtures.json`: synthetic Endpoint keys and Router identities, mode 0600.
- `runtime-smoke-result.json`: sanitized assertion/execution evidence.

These files are ignored local state and must not be committed. Existing `.env`, old stopped PostgreSQL containers, and the existing user kubeconfig/context were not modified. Commands for this cluster use its private kubeconfig explicitly.

## Actual live checks

The smoke passed **21 checks**, made **10 real runtime requests**, and inspected **10 actual execution events**. It completed at approximately 11:04 on 2026-10-26, Asia/Shanghai.

| Area | Verified behavior |
| --- | --- |
| Deployment | Real Controller and synchronized compiler-capable Runner ready. |
| Identity | Normal Better Auth sessions report the persisted tenantA/B/C and role `user`. |
| Authority source | Forged tenant headers do not change identity or inventory. |
| Default | Signed, ready bundled local-only Default, owned by A and left unchanged. |
| Sharing | A grants B read access; B cannot mutate or onward-share the Guardrail; C remains denied. |
| Tenant-owned integration | A and B each create their own Endpoint and Router through the reviewed change-request and explicit emergency-apply workflow. |
| Private roots | A/B/C cannot read or modify the other tenant's private Endpoint/Router through tested direct-ID operations. |
| Runtime authentication | A key does not authenticate B's Endpoint, and B's key does not authenticate A's Endpoint. |
| Call-context boundary | The same raw client call ID at A/B produces independent assignments; each Endpoint's Input/Output retains its own assignment. |
| Actual transformation | The published Default passport fixture is redacted in Input/Output for A/B. |
| Actual blocking | The published Default credential fixture blocks Input and Output under the expected Policy/Rule. |
| Execution evidence | All ten events show completed local execution, **zero model invocations**, and `fail_closed=false`; errors were not counted as successful blocking. |
| Evidence ownership | Each tenant sees its own events, not the other caller's events, even while both use A's shared Guardrail. Foreign direct event-ID reads are denied. |

The fixture contents and expectations were selected from the immutable Default's frozen test suite, rather than assuming arbitrary sample text must match. An initial temporary test assertion allowed only `builtin_content_filter`; it was corrected to include the two verified local boundary contracts, `indirect_prompt_injection` and `memory_poisoning`. Runtime zero-model evidence remained required. No application behavior was changed to make the smoke pass.

Two additional checks passed:

1. `helm test tali-guard`: Controller ready and Runner alive, test Pod `Succeeded`.
2. The previously skipped `test_real_redis_atomic_assignment_and_outcome`: **1 passed**, using an isolated Redis database index and its own temporary keys. The test-only Redis port-forward was closed afterwards.

This now supplies real deployed shared-Runner evidence in addition to the earlier [565 Controller/UI and 61 Runner test results](multi-tenancy-local-testing-2026-10-24.md). Those earlier suites were not all rerun as part of this deployment.

## Build and deployment corrections

The cached old Guard image ran `app.main:app` and predated the current architecture, so both application images were rebuilt. The only application-build configuration edit is in [`.dockerignore`](../.dockerignore): `web/node_modules` became `**/node_modules`. This excludes all host dependency trees, including the 861 MiB Controller tree, and prevents host macOS packages from overwriting Linux dependencies after `npm ci` inside the Docker build.

The sequential builds passed Controller UI/server/CLI compilation and the image build's OpenAPI check, plus Runner dependency installation and CLI packaging. The reduced chart passed strict Helm lint.

The initial `kind load docker-image` requested all platforms from cached multi-platform image indexes and failed on an uncached content digest. Importing the ARM64-only archives resolved it; bootstrap and application startup then completed without changing chart security behavior:

```bash
set -o pipefail
docker image save --platform=linux/arm64 \
  ghcr.io/tasklattice/tali-guard-controller:dev \
  ghcr.io/tasklattice/tali-guard-runner:dev \
  postgres:17-alpine redis:7.4-alpine | \
docker exec --privileged -i guard-tenants-control-plane \
  ctr --namespace=k8s.io images import \
  --platform=linux/arm64 --digests --snapshotter=overlayfs -
```

This command targets only the newly created local kind node. The temporary image-import problem was not a multi-tenancy failure.

Mock SSO was deliberately not enabled: the current guard permits it only outside production with a loopback Controller bind and URL. Weakening that guard or binding the deployed Pod only to loopback would be inappropriate. Test accounts were created internally through Better Auth, assigned persisted tenant IDs, then signed in through the ordinary public login API.

## Continue testing

From the repository root, inspect the retained deployment:

```bash
kubectl --kubeconfig .local-secrets/tenant-runtime-20261026/kubeconfig \
  -n tali get pods,services
```

If loopback port-forwards are no longer running, start each in its own terminal:

```bash
kubectl --kubeconfig .local-secrets/tenant-runtime-20261026/kubeconfig \
  -n tali port-forward --address 127.0.0.1 \
  service/tali-guard-controller 38081:8080
```

```bash
kubectl --kubeconfig .local-secrets/tenant-runtime-20261026/kubeconfig \
  -n tali port-forward --address 127.0.0.1 \
  service/tali-guard-runtime 38082:8091
```

Rerun the retained fixture smoke:

```bash
GUARD_SMOKE_IDENTITIES_FILE="$PWD/.local-secrets/tenant-runtime-20261026/identities.json" \
GUARD_SMOKE_STATE_FILE="$PWD/.local-secrets/tenant-runtime-20261026/runtime-fixtures.json" \
GUARD_SMOKE_RESULT_FILE="$PWD/.local-secrets/tenant-runtime-20261026/runtime-smoke-result.json" \
GUARD_SMOKE_ORIGIN=http://localhost:38081 \
node .local-secrets/tenant-runtime-20261026/runtime-smoke.mjs
```

The script retains and reuses its synthetic Endpoints/Routers. It does not edit Default, change pool capacity, provision arbitrary users, or claim quotas exist. Fixture credentials and cookies are not printed.

## Remaining limits

- One Runner was exercised. The real Redis atomic-claim test does not prove live failover or Input on one deployed Runner and Output on another.
- No tenant-specific pool placement, per-tenant admission fairness, resource/spend quota, or isolated model credential is implemented by the current code.
- Both tenant account roles retain the existing deployment-wide Runner-management permissions described in the isolation audit.
- No adversarial saturation, concurrent heavy publication, production IdP, external detector model, long-duration stability, or Kubernetes rolling-update acceptance was performed.
- A small serial local-only workload fitting at about 1 GiB does not establish that every feature or model-backed workload fits in 2 GiB.

The deployment is suitable for continuing logical tenant/runtime tests now. Strong Runner resource-isolation acceptance requires the corresponding design and implementation changes first.
