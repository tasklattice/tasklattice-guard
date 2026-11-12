# Operations and Security

This guide covers account and runtime identities, protected data, capacity, and
observability. Use the [Helm deployment guide](../charts/tali-guard/README.md) for
installation, dependency settings, and production Secrets.

## Health and version endpoints

Controller and Runner expose the same public operational routes on their HTTP
ports (8080 and 8091 in the container images). All responses use JSON and
`Cache-Control: no-store`; `HEAD` returns the same status and headers without a
body. These routes do not require a session or token.

| Route | Meaning | HTTP status |
| --- | --- | --- |
| `/health/live` | The process can serve HTTP; no dependency checks | 200 with `status: "ok"` |
| `/health/ready` | The instance can accept work | 200 ready, 503 not ready |
| `/healthz` | Alias of `/health/ready`, including its dependency checks | 200 ready, 503 not ready |
| `/version` | Local startup build identity, without database or network lookups | 200, including when build metadata is unknown |

Keep Kubernetes startup and liveness probes on `/health/live`, and readiness
probes on `/health/ready`. `/healthz` is suitable for load-balancer readiness;
using it as liveness would restart instances for dependency outages.

Both readiness routes return top-level `component`, `status`, `ready`, `reason`,
and `error`. A successful check has `status: "ready"`, `ready: true`,
`reason: "ready"`, and `error: null`. An unsuccessful check always returns 503
with the same envelope, for example:

```json
{
  "component": "guard-controller",
  "status": "not_ready",
  "ready": false,
  "reason": "storage_unavailable",
  "error": {
    "code": "storage_unavailable",
    "message": "Controller storage is not ready."
  }
}
```

Controller checks that its database and initialized state are readable, with a
750 ms deadline covering connection checkout and the query. Concurrent probes
share one check. A transaction-local PostgreSQL statement timeout also bounds
server work. Timed-out queries discard their connection; late checkouts are
released without issuing SQL. Reasons include `storage_unavailable`,
`storage_uninitialized`, `storage_timeout`, and `stopping`.

Runner requires synchronized Controller state, a valid serving lease when
enabled, and all active Guardrail versions prewarmed. Failure reasons include
`controller_disconnected`, `controller_unsynchronized`, `registry_closed`,
`missing_prewarmed_guardrail_versions`, `readiness_check_failed`, and `stopping`.
Runtime counts and synchronization observations remain in the response. Failed
checks use the top-level envelope, without FastAPI's former `detail` wrapper.
Liveness and local version queries remain available during dependency failures
and shutdown while the HTTP listener is still accepting requests.

`/version` returns `component`, `version`, `commit`, `branch`, `dirty`, and `source`.
It uses the startup snapshot of `TALI_BUILD_INFO` or Git metadata, with `unknown`
and null fields when metadata is absent. It does not re-run Git per request.
`/api/v1/system/version` remains the authenticated, database-backed fleet
inventory; use each Pod's `/version` for dependency-independent diagnostics.

Unknown paths beneath `/health`, `/healthz`, or `/version`, and unsupported
methods on these operational routes, return JSON 404 with
`error.code: "not_found"`. They never fall through to the Controller UI.

```bash
curl -i http://127.0.0.1:8080/healthz
curl -i http://127.0.0.1:8091/health/ready
curl http://127.0.0.1:8080/version
curl http://127.0.0.1:8091/version
```

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
- Sign-in throttling is keyed by the client address, and every CLI command or
  browser login consumes one attempt (`/sign-in/username`: 10 per 60 seconds per
  client). Without `controller.trustedProxyCidrs`, the Controller ignores any
  supplied `X-Forwarded-For` and uses the connection peer, so one client cannot
  exhaust a bucket shared by every account. Behind an ingress or gateway, list
  its pod CIDRs so the real client address is used; Better Auth then validates
  the forwarding chain instead of trusting it. Automation should reuse a session
  or a personal access token rather than signing in per command.
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
`username`, or use `existingSecret` with `username` and
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
user changed their password in the UI. Resetting restores the configured role, clears a ban, and revokes previous sessions. Other user accounts are retained.
External Secret updates use the same synchronization path; the Job never modifies
external Secrets. Allow for Kubernetes' projected-volume refresh delay.

The only mounted account fields are `username`, `password` and optional
`revision`. Optional `usernameKey` and `credentialKey` customize Secret field names.
The Controller passes the decoded password to Better Auth. Better Auth alone
hashes and verifies database credentials; no hash generation or import is needed
in Helm, the Job, or development setup. Base64 is an encoding for inspecting
initial credentials, not the database's password-verification algorithm.

Local login and account management use usernames. SSO identities keep their
verified email address and use its local part (before `@`) as the username.
Usernames must be unique across local and SSO accounts. A conflicting username
must be resolved before that SSO identity can sign in; identities are never merged
by username. SSO issuer and subject remain the authentication binding.

Personal names and provider tokens are not stored. Verified SSO claims are used
only during the callback; persistent membership records keep the required project
and role information. The schema is intended for a fresh database; historical
account data is not upgraded.

Sessions are checked against the database, so resets and bans take effect immediately.

## Test task lifecycle and cancellation

Guardrail tests are optional evidence, independent of Publish. Each submitted
run has an immutable run ID. In each Controller deployment, tests execute only
on the default pool's StatefulSet ordinal `-0` Runner. If that Runner is absent,
busy, or has not acknowledged the current model configuration, queued work waits;
it does not move to ordinal `-1` or another pool. This is a deployment-level
boundary, not a new per-user/project Runner assignment mechanism.

Use GuardCtl with the project's normal API credentials:

```bash
bin/guardctl project test --guardrail-id <guardrail-id> --url=https://guard.example.com
bin/guardctl project test-status --run-id <run-id> --url=https://guard.example.com
bin/guardctl project test-cancel --run-id <run-id> --url=https://guard.example.com
```

These commands are equivalent to the UI's test actions. Submit once and use the
returned run ID to inspect/cancel; do not submit another test to poll status.
The UI also offers **Stop test** in its progress view. The cancellation API is:

```text
POST /api/v1/test-runs/<run-id>/cancel
```

The operation is idempotent. It records a `cancelled` report and a durable stop
request, preventing queued dispatch and late progress/results from changing that
terminal state. For a running task, the Controller retries the stop command until
the Runner has cancelled and joined its local execution/cleanup and acknowledged
it. The report's cancelled state records intent, not proof that an offline Runner
has already stopped. Inspect the same run with `test-status`: its
`cancellation.requestedAt` records the request and `cancellation.acknowledgedAt`
is null until Runner cleanup is acknowledged. Further tests wait for outstanding
stop acknowledgements.
Already passed/failed reports are returned unchanged. Publication, versions and
traffic are unaffected. Controller and Runner must both be upgraded for this
protocol; do not use Runner restarts as an operator cancellation mechanism.
Remote model providers may continue work already submitted even after the local
request is cancelled.

The Runner applies a 30-minute deadline to each execution attempt. A deadline or
an unhandled execution error produces `failed`, not `cancelled`; ordinary case
assertion failures remain case results and do not automatically cancel the suite.
Model-call timeouts still apply independently. Stream loss interrupts local work;
the same run ID can be retried on ordinal 0, using bounded in-process result replay
when available. A process restart can re-execute an unfinished run.

Runner container logs emit content-free JSON lifecycle events at INFO level:
`validation.received`, `started`, `progress`, `case_started`, `case_completed`,
`action_error`, `case_error`, `case_cancelled`, `error`, `interrupted`,
`cancel_requested`, `cancelled`, `completed`, `replayed`, and `delivery_failed`
(all prefixed with `validation.`). Correlate by `run_id`, with `case_id` and
`policy_id` for case events. Failures include classifications, evaluator/model
identifiers and timing rather than request bodies, credentials or raw provider
responses. For example, in the local deployment:

```bash
kubectl -n tali logs runner-default-0 --since=30m | grep '<run-id>'
```

### Large test reports and the finalizing phase

`finalizing` means the cases have finished, not that a model is writing a report.
The Runner packs the exact case results and candidate Artifact in a worker thread,
then queues delivery before waiting for runtime teardown or cost-WAL writes.
Teardown and cost-record failures are logged independently; they cannot discard
an already completed report. A following test waits on the local execution lock
while teardown finishes instead of failing merely because teardown is still busy.

Upgraded Controller/Runner pairs negotiate gzip-compressed **protobuf** reports.
No cases, findings or traces are truncated. The 32 MiB gRPC frame budget remains
unchanged; the Controller validates the decoded size (at most 128 MiB), SHA-256
and both run/Runner identities before saving. It acknowledges only after the
report transaction commits. Old peers continue to use the original small-report
format; upgrade both planes for large reports.

The client no longer treats a five-minute total wait as report failure. It polls
the same ID until the server reports a terminal state; model/task execution
deadlines remain server-owned. Detailed report GETs negotiate HTTP compression
and use a separate two-minute client read budget. `guardctl project test-status`
reads a lightweight summary by default; add `--detail` to download all evidence:

```bash
bin/guardctl project test-status --run-id <run-id> --detail --url=https://guard.example.com > report.json
```

For delivery diagnostics, follow `validation.report_packing` →
`validation.report_queued` → `validation.report_saved` by run ID. The queued event
includes raw and wire byte counts; `report_saved` confirms Controller persistence.
`validation.cleanup_started`, `cleanup_slow`, `cleanup_completed`, `cleanup_error`
and `cost_record_error` (all prefixed with `validation.`) describe independent
post-execution work and do not by themselves mean the report failed.

Completed cancelled reports retain one entry per immutable-version bucket (and
one in unversioned history), separately from the Passed/Failed retention budget.
The pending stop request survives report pruning until it is acknowledged.

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

When **Protection Capabilities → Topic Control → Validate** fails, Runner emits
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

The chart starts with one Default Runner replica, readiness-gated Service
endpoints, and a drain window. A synchronized Runner can continue with
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

## Runtime telemetry quarantine runbook

When a retained Runner event cannot fit the Controller upload contract even
after emit-level splitting, the Runner telemetry WAL neither drops it nor
blocks later evidence. It moves the raw event out of `runtime-events.wal` into
`runtime-events.rejected.wal` (same state directory,
`/var/lib/tasklattice/guard-runner` in the chart) and increments
`guard_runner_telemetry_quarantined_events_total{reason}`. The
`TaskLatticeGuardTelemetryEventQuarantined` alert fires on any increase within
five minutes; treat it as evidence loss until the file is reconciled.

1. **Preserve before anything restarts.** The state volume is `emptyDir`, so a
   Pod replacement discards both WALs. Copy the file to a secure host, for
   example
   `kubectl cp <namespace>/<runner-pod>:/var/lib/tasklattice/guard-runner/runtime-events.rejected.wal ./rejected.wal`
   (repeat per Runner replica). The file holds one raw event JSON per line with
   protected payload metadata; handle it like production evidence.
2. **Inspect the reason.** `kubectl logs <runner-pod>` records the quarantined
   event `id` and the failure. Typical causes are an event whose
   `metadata.usage` carries more than 64 model calls (the Controller per-event
   work budget), an upload body over the byte budget, or a structure/depth
   limit. Verify the Runner runs a current image: emit-level splitting keeps
   every event at or below 64 model calls and ships the remaining calls as
   deterministic cost-only companions.
3. **Restore delivery.** Replay the lines against the Controller ingest API with
   a Runner credential. For a file that fits a single upload (the same bounds
   the Runner uses: at most 64 model calls per event and 256 per request, at
   most 1000 events, and the configured body budget), a request body of
   `{"events":[...]}` with `authorization: Bearer $GUARD_RUNNER_CONTROL_TOKEN`
   works; otherwise split the lines into several requests. Runtime event and
   cost identities are deterministic, so replaying events the Controller
   already holds is idempotent. Use the control token of the Pool that produced
   the events so Controller can check their allocation. A `202` receipt whose `accepted` equals the
   sent count means every event is durable; only then delete the local copy.
4. **Escalate a real overflow.** If a current Runner still quarantines an event,
   capture the image digest, the rejected event `id`, and its metadata shape.
   The quarantine file is bounded at 64 MiB; when the bound is reached the
   Runner stops quarantining and leaves the events in the main WAL, which trips
   the backlog alert. Do not hand-edit `runtime-events.wal`.


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
