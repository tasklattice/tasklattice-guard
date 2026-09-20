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
- The OrbStack/local baseline login is username `admin` and password `password`.
  Controller maps that username to the internal Better Auth identity
  `admin@tasklattice.local`; these local-only credentials must not be used in
  production.
- Production has no default credentials. Its bootstrap administrator is created
  through Better Auth from a strong deployment Secret, with a default minimum
  password length of 12.
- Bootstrap is idempotent: it creates a missing administrator but never resets
  an existing administrator's password during Controller startup. Passwords
  changed through Better Auth therefore survive restarts and upgrades.
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

## Capacity and observability

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
[observability/README.md](../observability/README.md)
for installation, metric semantics, alert budgets, and the unavoidable upstream
bypass-denominator boundary.

If any Runner pool has more than one replica, Redis is required for shared
input/output call-version pinning.

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

Shared Redis stores call and stream state, including protected content. It is
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

- [Production values](../charts/tali-guard/values.yaml): externally managed
  dependencies and Secrets, plus production observability defaults.
- [Local values](../charts/tali-guard/values-dev.yaml): bundled development
  PostgreSQL/Redis, an offline bootstrap password hash, and certificate-free
  Token-authenticated control traffic. The chart generates internal keys/tokens
  in a bootstrap Job; production keeps mTLS enabled by default.
- [Debug overlay](../charts/tali-guard/values-debug.yaml): additional tracing and
  profiling; use `npm run helm:deploy:dev:debug` for the local OrbStack deployment.

The Helm installer does not read model credentials from `.env` or create
Provider Secrets. Configure Providers, Models, and protection assignments
through the UI; see [model configuration](model-configuration.md).
