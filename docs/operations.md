# Operations and Security

This guide covers account and runtime identities, protected data, capacity, and
observability. Use the [Helm deployment guide](../charts/tali-guard/README.md) for
installation, dependency settings, and production Secrets.

## Identity and security

- Human authentication, sessions, password hashing, password changes, roles,
  and account administration are delegated to **Better Auth** in Controller.
- Scripts and API clients can use personal Access Tokens with module permissions,
  expiry, and revocation. Effective permissions are limited by the owner's
  current role. These are separate from Runner tokens and Endpoint credentials;
  see [Access Tokens](account-access-tokens.md).
- Human login uses Better Auth's Username plugin. Email sign-in, public
  registration and email recovery endpoints are disabled; admins create users
  with a username and password. Database-backed sessions honor resets immediately.
- See [bootstrap account operations](#bootstrap-account-operations) for initial
  credentials, reinitialization, and Secret inspection.
- Runner control uses a Runner token plus mutual TLS by default. The shared
  initialization Job creates and retains its CA/credentials in Namespace-owned
  Secrets; removing workloads or the release does not remove those credentials.
- Artifacts use Controller-held Ed25519 private signing keys; Runners receive
  only the public key.
- Endpoint credentials are shown once. Controller stores a SHA-256 verifier
  and Runners authenticate locally.
- Runtime Events contain metadata by default. When a Guardrail logging level
  qualifies for content capture and an encryption key is configured, Runner
  encrypts the request/model content before writing its WAL or sending it to
  Controller; PostgreSQL stores the resulting ciphertext rather than plaintext.

## Bootstrap account operations

Both bootstrap accounts initialize in every environment: `admin` / `password`
with the admin role, and `user` / `password` with the user role. Configure their
`username` and `name`, or use `existingSecret` with `username`, `name`, and
`password` fields. Set `security.bootstrapUser.enabled=false` to omit the second
account. A minimum above eight characters requires external account Secrets.
There is no `localDefault` or precomputed password-hash setting.

The Job overwrites managed account Secrets on every run. Kubernetes stores their
`data.password` in ordinary Base64; mounted values are already decoded. For debug:

```bash
kubectl -n tali get secret tali-guard-bootstrap-admin-init \
  -o jsonpath='{.data.password}' | base64 --decode
```

Controller initializes or overwrites these configured accounts at startup,
retaining their IDs and resource ownership. It also checks mounted account
Secrets every two seconds. A Job rerun writes a new `revision`, so the same initial
password is reapplied after Kubernetes refreshes the mounted Secret, even if the
user changed their password in the UI. Resetting restores the configured role and
name, clears a ban, and revokes previous sessions. Other user accounts are retained.
External Secret updates use the same synchronization path; the Job never modifies
external Secrets. Allow for Kubernetes' projected-volume refresh delay.

The only mounted account fields are `username`, `name`, `password` and optional
`revision`. Optional `usernameKey`, `nameKey`, and `credentialKey` customize names.
The Controller passes the decoded password to Better Auth. Better Auth alone
hashes and verifies database credentials; no hash generation or import is needed
in Helm, the Job, or development setup. Base64 is an encoding for inspecting
initial credentials, not the database's password-verification algorithm.

Login and account management accept usernames, not email addresses. Existing
accounts migrate to normalized email local parts, preserving IDs and credentials;
invalid or duplicate local parts receive deterministic `account_<digest>` names.
Look up these migrated names in Users. Better Auth's required internal email
column remains implementation metadata and cannot be used to sign in. Sessions
are checked against the database, so resets and bans take effect immediately.

## Capacity and observability

Guardrail detail → **Security findings** exposes the **Prompt History logging**
setting. INFO retains blocked/failed checkpoints, DEBUG also retains content
transformations, and TRACE retains all checkpoints. This runtime setting does
not change enforcement. Security findings remain available at all three levels.
Default overrides `filter-denied-insults` / `category/denied_insults` to `allow`
on input and output: matched findings are recorded without changing content or
stopping later Policies. The source Policy retains its original block action.
Observation-only acceptance still asserts the original Rule match and unchanged
content; it does not exclude the inherited test.

Runner heartbeat summaries include request/error/timeout deltas, inflight and
maximum concurrency, p95 latency, cgroup-normalized process CPU and memory, active
Guardrails, real admission-queue depth, observation interval, compile load, and
applied generation. Controller calculates RPS using the actual observation
window, weights error ratios by request volume, preserves worst-Runner latency,
and includes queue/concurrency/resource pressure in replica guidance. Safe RPS
per Runner remains an operator-provided planning value, and recommended replica
count remains guidance rather than an automatic scaling decision.

- Controller metrics: `GET /metrics` on port `8080`
- Runner metrics: `GET /metrics` on port `8091`
- Capacity API: `GET /api/v1/runner-pools`

Helm protects both metrics endpoints with a retained, dedicated Bearer Secret
and configures ServiceMonitor to use it. Standalone deployments can set
`CONTROLLER_METRICS_TOKEN` and `GUARD_METRICS_TOKEN`; leaving them unset keeps
the local endpoint unauthenticated for backward-compatible development only.

The Prometheus contract separates technical execution results from firewall
decisions and adds control convergence, artifact delivery, WAL/outbox age, and
evidence freshness. Production defaults create ServiceMonitors,
PrometheusRules, and the Grafana dashboard ConfigMap; the Debug profile adds
100% tracing and continuous profiling. See
[observability guide](observability.md)
for installation, metric semantics, alert budgets, and the unavoidable upstream
bypass-denominator boundary.

If any Runner pool has more than one replica, Redis is required for shared
input/output call-version pinning.

### Topic Control Rail validation diagnostics

When **Guardrail Catalog → Topic Control → Validate** fails, Runner emits
`rail_validation_case_failed` and `rail_validation_model_exchange` JSON events
at WARNING level. Filter Runner container logs by `validation_id` or `case_id`.
The latter events contain the model/profile, method, URL, actual request body
(including the system prompt and generation parameters), final HTTP status,
response body, and any captured call or parsing error. NVIDIA native NeMo Rails,
OpenAI-compatible Topic Control classifiers, and TypeSafe JEV are covered.
An HTTP 200 response with an incorrect verdict also produces these diagnostics.
A failed case's **Runner output** includes the same `model_exchanges` for copying
from the existing validation failure details.

Capture is scoped to Topic Control validation samples. Successful cases emit no
payload diagnostics; live Guardrail traffic keeps its existing content logging
policy. Authorization/Cookie headers, credential fields, URL userinfo, and known
Provider credentials are redacted. Request and response bodies are limited to
32,768 characters each with an explicit `body_truncated` flag, and each case
retains at most 16 observed HTTP exchanges. Native NeMo retries expose the final
HTTP response. A transport failure before a response leaves `response` null.

## Availability and retained state

Production checks go directly from the application or gateway to a ready Runner
through the Runtime Service. Controller and PostgreSQL are outside that check
path. Playground is an exception: Controller orchestrates its model calls and
Runner checks.

The chart uses two baseline Runner replicas, readiness-gated Service endpoints,
a disruption budget, and a drain window. A synchronized Runner can continue with
its last-known-good generation during a temporary Controller outage. The chart
still runs one Controller; management, publication, reconciliation, and telemetry
ingest depend on it. Production availability also depends on failure-domain
scheduling, spare capacity, and externally managed HA PostgreSQL and Redis.

Shared Redis stores call context, including protected input content. Output buffers and NeMo iterators live only in their WebSocket connection. It is
not a load balancer and does not replicate historical model runtimes. Context
expiration or a replica without the pinned release can prevent an associated
check from completing. Keep Redis private, access-controlled, and encrypted in
transit. Runner recovery state and telemetry WAL use `emptyDir` in the chart and
do not survive Pod replacement.

See [architecture](architecture.md) for state ownership, control protocols,
release retention, and availability boundaries. See
[gateway integration](gateway-integration.md) for stream failure handling and
the distinction between enforce, dry run, and fail-open behavior.

## Deployment profiles

- [Configuration reference](../charts/tali-guard/values.yaml): deployment defaults
  and annotated examples for dependencies, Secrets, networking and observability.
- [Development/UAT values](../charts/tali-guard/values-dev-uat.yaml): the only
  development profile, with PostgreSQL/Redis, a local bootstrap account and
  automatically generated internal credentials/mTLS certificates.

For local performance diagnostics, use `npm run helm:deploy:dev:debug`; it applies
telemetry flags to the same development values. For other environments, configure
`observability.performanceDebug.enabled` and the Tempo/Pyroscope URLs documented
in `values.yaml`. There is no separate debug or migration-target values file.

The Helm installer does not read model credentials from `.env` or create
Provider Secrets. Configure Providers, Models, and protection assignments
through the UI; see [model configuration](model-configuration.md).
