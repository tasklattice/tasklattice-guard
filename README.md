# TaskLattice Guard

TaskLattice Guard is split into exactly two application components:

- **Guard Controller** — a TypeScript full-stack service (React, TanStack,
  Hono, Better Auth, Drizzle, PostgreSQL) that owns users, permissions,
  Guardrails, Integrations, deployments, desired state, reconciliation, audit,
  telemetry ingest, and capacity evaluation.
- **Guard Runner** — a Python/FastAPI data plane powered by NVIDIA NeMo
  Guardrails. It receives signed immutable artifacts from Controller, prewarms
  them, atomically activates generations, authenticates Integration traffic,
  and returns protection decisions.

## Architecture and HA boundary

Traffic flows from left to right. The AI Gateway calls the stable Runtime
Service directly; Controller and PostgreSQL never enter the synchronous data
path.

```text
 External clients                      Kubernetes cluster
                                      ┌───────────────────────────────────────────────────────┐
 ┌──────────────────────┐             │ CONTROL PLANE              DATA PLANE                 │
 │ AI App / LiteLLM /   │             │                                                       │
 │ compatible AI GW     │             │ ┌──────────────────┐       ┌───────────────────────┐  │
 └──────────┬───────────┘             │ │ Guard Controller │◀─────▶│ Guard Runner          │  │
            │                         │ │ UI / API / Auth   │ gRPC  │ StatefulSet           │  │
            │                         │ │ Reconciliation    │ mTLS  │                       │  │
            │                         │ └─────────┬────────┘       │ tali-guard-runner-0   │  │
            │                         │           │                │ tali-guard-runner-1   │  │
            │                         │           ▼                └───────────┬───────────┘  │
            │                         │ ┌──────────────────┐                   │              │
            │                         │ │ PostgreSQL       │           ┌───────▼────────┐     │
            │                         │ │ desired state    │           │ Shared Redis   │     │
            │                         │ │ audit / metadata │           │ call_id context│     │
            │                         │ └──────────────────┘           └────────────────┘     │
            │                         │                                                       │
            └── input / output check ─┼────▶ Runtime Service :8091 ────────▶ Ready Runner     │
                                      │                                                       │
 ┌──────────────────────┐             │                                                       │
 │ Operators / Browser  │── HTTPS ────┼────▶ Guard Controller                               │
 └──────────────────────┘             │                                                       │
                                      └───────────────────────────────────────────────────────┘
```

The two call routes are deliberately separate:

- **Data plane:** `AI Gateway -> Runtime Service -> Ready Runner`. The Runner
  authenticates the Integration locally, resolves the Deployment, executes
  NVIDIA NeMo Guardrails, and returns the protection decision. Kubernetes can
  select either Ready replica; no Runner Pod name is exposed upstream.
- **Control plane:** `Browser -> Controller -> PostgreSQL`, plus the
  Runner-initiated gRPC/mTLS stream between Runner and Controller. Controller
  sends desired generations, signed artifacts, compile requests, and Validation
  requests. Runner returns registration, heartbeat/load summaries, compile and
  Validation results, and artifact ACK/NACK on that stream. Runtime Event
  telemetry uses a separate authenticated internal HTTP endpoint; Runner writes
  events to a local WAL and retries delivery outside the synchronous request
  path.

Redis belongs to the data-plane support path. It is not a general cache and
does not select a Runner. The Redis key is a SHA-256 digest of `call_id`, and
the value expires after five minutes. Its value contains the pinned
Plan/Deployment/Integration resolution plus up to 20 messages and the input
content blocks required by an output check, so it can contain protected
content. Production Redis must therefore be private, access controlled, and
encrypted in transit. This shared context lets input and output checks use the
same immutable Guardrail generation when Kubernetes sends them to different
replicas. PostgreSQL remains the authoritative control-plane store.

The chart provides rolling-update availability and single-Pod fault tolerance
with two stable StatefulSet replicas, readiness-gated Runtime Service
endpoints, a `minAvailable: 1` PDB, `minReadySeconds: 5`, and a drain window. A
synchronized Runner keeps serving its last-known-good generation during a
temporary Controller outage, and an invalid artifact is rejected without
replacing the active generation.

This is not complete infrastructure HA: the chart does not currently spread
Runner Pods across nodes or failure domains, and the PDB protects only against
voluntary disruptions. Production HA also requires failure-domain scheduling,
enough spare cluster capacity, and externally managed HA PostgreSQL and Redis.
The development PostgreSQL and Redis are single-replica dependencies.

The current chart also runs one Controller replica. Controller isolation keeps
already synchronized Runners serving during a Controller outage, but the
management UI/API, publishing, reconciliation, and telemetry ingest remain
unavailable until Controller returns.

## Guardrail lifecycle

The authoritative state vocabulary, lifecycle diagrams, and derived UI status
rules are documented in [State ownership and lifecycles](docs/architecture.md#state-ownership-and-lifecycles).

1. An administrator creates a product-level Guardrail draft in Controller.
2. Controller converts selected protections into a canonical immutable plan.
3. Publishing requires a healthy GuardRails 0 Runner.
4. GuardRails 0 compiles the plan with the NeMo toolkit and returns an
   artifact candidate.
5. Controller recomputes its checksum, signs it with Ed25519, stores the
   immutable artifact, and advances desired generation.
6. Target Runner pools verify checksum and signature, prewarm all referenced
   artifacts, then atomically switch generation. NACK preserves the previous
   generation.

The browser never authors raw NeMo YAML or Colang.

## Identity and security

- Human authentication, sessions, password hashing, password changes, roles,
  and account administration are delegated to **Better Auth** in Controller.
- The OrbStack/local baseline login is username `admin` and password `admin`.
  Controller maps that username to the internal Better Auth identity
  `admin@tasklattice.local`; these local-only credentials must not be used in
  production.
- Production has no default credentials. Its bootstrap administrator is created
  through Better Auth from a strong deployment Secret, with a default minimum
  password length of 12.
- Bootstrap is idempotent: it creates a missing administrator but never resets
  an existing administrator's password during Controller startup. Passwords
  changed through Better Auth therefore survive restarts and upgrades.
- Runner control uses a Runner token plus mutual TLS in production.
- Artifacts use Controller-held Ed25519 private signing keys; Runners receive
  only the public key.
- Integration credentials are shown once. Controller stores a SHA-256 verifier
  and Runners authenticate locally.
- Runtime Events contain metadata by default. When a Guardrail logging level
  qualifies for content capture, Runner encrypts the request/model content
  before writing its WAL or sending it to Controller; PostgreSQL stores the
  resulting ciphertext rather than plaintext.

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
[observability/README.md](observability/README.md)
for installation, metric semantics, alert budgets, and the unavoidable upstream
bypass-denominator boundary.

If any Runner pool has more than one replica, Redis is required for shared
input/output call-version pinning.

## Local development

Requirements: Python 3.13, uv, Node.js 24, npm, PostgreSQL, and OpenSSL.

```bash
make sync
openssl genpkey -algorithm ED25519 -out /tmp/guard-private.pem
openssl pkey -in /tmp/guard-private.pem -pubout -out /tmp/guard-public.pem
```

Create `.env` from [`.env.example`](.env.example), create the PostgreSQL
database, then run Controller and Runner in separate terminals:

```bash
make controller-dev
make runner-run
```

Controller runs database migrations and idempotently creates the bootstrap
administrator through Better Auth. With the example local configuration, sign
in as `admin` / `admin`; the corresponding internal Better Auth email is
`admin@tasklattice.local`. The test suite is split into independent control
plane, data plane, Controller/Runner communication, and contract gates; see
[Test architecture](docs/testing.md). Run all automated checks with:

```bash
make test
```

Controller/Runner messages are defined once under
`proto/tasklattice/guard/control/v1/`. After changing a protocol file, regenerate
the checked-in Python and TypeScript bindings and verify them with:

```bash
make proto-generate
make proto-check
```

The protocol contains typed business messages rather than JSON documents. See
[`docs/architecture.md`](docs/architecture.md#control-protocol) for contract
ownership and extension rules.

## Kubernetes deployment

The Default Guardrail composes 18 complete, existing local Policies and requires
no model configuration. It includes `Baseline PII Protection`, `Pattern Matching`,
and the local abuse, harm, bias,
and prompt-injection Policies. Each Policy retains all of its Rules, actions,
input/output scope, and Test Cases; Default owns its Policy order, local Rule
order, and reviewed composition expectations, not a separate Rule allowlist.
Policy identities and versions remain in the
compiled bindings and inherited tests for inspection in the Guardrail console.

`Advanced PII Protection (Australia)` remains available in the Policy Library,
but is not bound to Default: 45 of its 47 detectors overlap with Pattern
Matching. Baseline PII retains credential rejection and spaced Australian tax
IDs that would otherwise be lost by using Pattern Matching alone. This is a
Guardrail-local change only; no template Rules, actions, ordering, or Test Cases
are modified, and no inherited tests are explicitly excluded.

The complete `Pattern Matching` Policy covers passport formats, identity and
financial identifiers, contact information, credentials, and addresses on input
and output. Its existing IP, URL, business-identifier, and protected-class-word
redactions also apply; Default does not silently narrow the Policy. These are
local format/context checks, not exhaustive or semantic PII detection.

On Controller startup, an uncustomized Default is reconciled against the bundled
Policy catalog and recompiled if its bindings change, including Policy versions
or Rule membership. User-customized Defaults are preserved. Publishing a custom
Policy does not currently hot-update existing Guardrails.

Guardrails execute Policy bindings in list order. A binding's optional `ruleOrder`
lists stable Rule IDs to execute first; unlisted Rules retain their pinned template
order afterward. Duplicate/unknown IDs are rejected. `enabledRuleIds` controls
membership independently. Redaction changes the text seen by subsequent Rules;
rejection stops subsequent execution. Rule action overrides take precedence over
Policy overrides, then the template action. Compilation preserves that order
across local, model-backed, and programmable Policies instead of sorting actions
by severity or running independent copies of the original text in parallel.

The bundled acceptance tests retain their original expectations and source Rule
identity. A binding's optional `testCaseOverrides`, keyed by inherited source Case
ID, supplies a reviewed Guardrail composition expectation: source Policy version,
reason, final decision, expected Policy/Rule matches, and exact complete output
(required for transformations). A stale version, disabled expected Rule, missing
review, or unsafe-to-allow override is rejected. Overrides are frozen in each
Validation request/result; original expectations remain inspectable. No override
is inferred from an observed runtime result. Editing the draft invalidates the
previous Validation/release gate.

For catalog `1.95.0`, Default retains all 140 inherited cases and passes all 140
without model calls or excluded tests. Its explicit order checks credentials and
complete identifiers before broad phone/number patterns. It preserves ordinary
phone redaction instead of changing phone Rules to rejection. Control-plane tests
separately verify original Rule contracts, compilation/order and composition
assertions. Data-plane tests load the signed `default-local-v1` artifact without
compiling it, then exercise input/output callbacks, complete redaction, benign
forwarding, and rejection.

The self-contained OrbStack profile builds both images and upgrades or installs Controller,
two GuardRails 0 Runners, development PostgreSQL and Redis, bootstrap identity,
artifact signing, and control-channel mTLS with:

```bash
make helm-install
```

This single command upgrades an existing release or installs a missing one, then
waits for workload readiness. It does not uninstall the release or clear data.

Use `make helm-install-debug` for the same OrbStack deployment with the
`values-debug.yaml` overlay and all performance diagnostics enabled.

The Helm install command does not read model configuration or credentials from
`.env` and does not create Provider Secrets. Register models, credentials, and
capability assignments after deployment through the Controller UI.

**Settings → Models** registers inventory and tests each selected model with an
actual request. Its call status, timestamp, latency, and failure reason are stored
separately from capability validation. **Test call** retries only that health check;
it does not assign scenarios, validate detector behavior, or activate a configuration.
**Settings → Capabilities** owns scenario assignments and detection validation.
Existing models without call-test evidence show **Not checked**, even if an older
capability probe passed. Use **Test call** to establish their current callability.

### Dedicated JailbreakDetect or a chat-based judge

`nvidia/nemoguard-jailbreak-detect` is an additional implementation of the existing
`tali.guard.jailbreak.v1` capability, alongside an OpenAI-compatible chat judge and
Qwen3Guard. It does not add a new scenario, modify Policies, or recompile Guardrail
artifacts when the selected detector changes.

- **NVIDIA hosted:** use the existing NVIDIA NIM Provider
  (`https://integrate.api.nvidia.com/v1`). Discovery includes JailbreakDetect as a
  supported endpoint candidate even when it is absent from the chat catalog.
  Registration makes an actual call; a catalog entry does not prove availability.
  Only this exact public NVIDIA origin is mapped to the official security API.
- **Self-hosted NIM:** register a Provider using its full
  `https://your-nim-host/v1/classify` URL. Discovery checks that classifier directly;
  a Chat Completions or `/models` endpoint is not required. Custom gateway prefixes
  remain intact and never redirect to NVIDIA's public service.
- Register the model in **Models**, then select it for **Jailbreak detection** in
  **Capabilities**, validate, and activate. The protocol is inferred for the
  canonical model ID; deployment aliases can use the existing protocol settings.
  Any chat model that supports OpenAI-compatible Chat Completions can instead use
  the `tali.openai-compatible-jailbreak.v1` profile and must return `SAFE` or
  `JAILBREAK` for the supplied classification prompt.

The dedicated client sends raw user input as `{"input":"..."}` and strictly
checks the native `jailbreak` boolean and finite `[-1, 1]` `score`. It uses the
service's boolean decision, not an invented local threshold. It does not send
chat prompts, model IDs, or generation parameters. **Models → Test call** checks
the response envelope only; **Capabilities → Validate** runs both benign and
jailbreak smoke samples. These samples do not constitute a comprehensive accuracy
benchmark. Classification errors remain errors and follow the Guardrail's failure
policy; they never become a safe verdict. This detector is input-only.

Tests are separated by architectural ownership: Controller tests cover registration,
endpoint routing, validation, and assignment; Runner tests load the frozen signed
`jailbreak-v1` artifact and exercise both detectors through the real runtime API
without importing the compiler or contacting external model services. Both sides
also test Provider-scoped self-signed TLS behavior.

Protocol references: [NVIDIA hosted classification API](https://docs.api.nvidia.com/nim/reference/nvidia-nemoguard-jailbreak-detect-infer)
and [self-hosted NIM request/response examples](https://docs.nvidia.com/nim/nemoguard-jailbreakdetect/latest/getting-started.html).

For a trusted Provider using a private CA or self-signed HTTPS certificate,
enable **Skip TLS certificate verification** under **Settings → Providers**.
The switch appears below the HTTPS Base URL during registration; saved Providers
have a **TLS settings** action. It defaults to off and applies only to that
Provider's discovery, capability validation, and Control Plane/Data Plane model
requests. Enabling it skips certificate-chain and hostname checks, not HTTPS
encryption. Changes are persisted and sent to active Runners; test affected models
again in Models and revalidate their scenarios in Capabilities because previous
connection and validation evidence is cleared.
This does not change Controller–Runner mTLS or other Providers' verification.

**Settings → Models** registers inventory and tests each selected model with an
actual request. Its call status, timestamp, latency, and failure reason are stored
separately from capability validation. **Test call** retries only that health check;
it does not assign scenarios, validate detector behavior, or activate a configuration.
**Settings → Guardrail Catalog** owns business-category detector assignments and validation.
Existing models without call-test evidence show **Not checked**, even if an older
capability probe passed. Use **Test call** to establish their current callability.

### Dedicated JailbreakDetect or a chat-based judge

`nvidia/nemoguard-jailbreak-detect` is an additional implementation of the existing
`tali.guard.jailbreak.v1` capability, alongside an OpenAI-compatible chat judge and
Qwen3Guard. It does not add a new scenario, modify Policies, or recompile Guardrail
artifacts when the selected detector changes.

- **NVIDIA hosted:** use the existing NVIDIA NIM Provider
  (`https://integrate.api.nvidia.com/v1`). Discovery includes JailbreakDetect as a
  supported endpoint candidate even when it is absent from the chat catalog.
  Registration makes an actual call; a catalog entry does not prove availability.
  Only this exact public NVIDIA origin is mapped to the official security API.
- **Self-hosted NIM:** register a Provider using its full
  `https://your-nim-host/v1/classify` URL. Discovery checks that classifier directly;
  a Chat Completions or `/models` endpoint is not required. Custom gateway prefixes
  remain intact and never redirect to NVIDIA's public service.
- Register the model in **Models**, then select it for **Jailbreak detection** in
  **Guardrail Catalog**, validate, and activate. The protocol is inferred for the
  canonical model ID; deployment aliases can use the existing protocol settings.
  Any chat model that supports OpenAI-compatible Chat Completions can instead use
  the `tali.openai-compatible-jailbreak.v1` profile and must return `SAFE` or
  `JAILBREAK` for the supplied classification prompt.

The dedicated client sends raw user input as `{"input":"..."}` and strictly
checks the native `jailbreak` boolean and finite `[-1, 1]` `score`. It uses the
service's boolean decision, not an invented local threshold. It does not send
chat prompts, model IDs, or generation parameters. **Models → Test call** checks
the response envelope only; **Guardrail Catalog → Validate detector** runs both benign and
jailbreak smoke samples. These samples do not constitute a comprehensive accuracy
benchmark. Classification errors remain errors and follow the Guardrail's failure
policy; they never become a safe verdict. This detector is input-only.

Tests are separated by architectural ownership: Controller tests cover registration,
endpoint routing, validation, and assignment; Runner tests load the frozen signed
`jailbreak-v1` artifact and exercise both detectors through the real runtime API
without importing the compiler or contacting external model services. Both sides
also test Provider-scoped self-signed TLS behavior.

Protocol references: [NVIDIA hosted classification API](https://docs.api.nvidia.com/nim/reference/nvidia-nemoguard-jailbreak-detect-infer)
and [self-hosted NIM request/response examples](https://docs.nvidia.com/nim/nemoguard-jailbreakdetect/latest/getting-started.html).

For a trusted Provider using a private CA or self-signed HTTPS certificate,
enable **Skip TLS certificate verification** under **Settings → Providers**.
The switch appears below the HTTPS Base URL during registration; saved Providers
have a **TLS settings** action. It defaults to off and applies only to that
Provider's discovery, capability validation, and Control Plane/Data Plane model
requests. Enabling it skips certificate-chain and hostname checks, not HTTPS
encryption. Changes are persisted and sent to active Runners; test affected models
again in Models and revalidate their detectors in Guardrail Catalog because previous
connection and validation evidence is cleared.
This does not change Controller–Runner mTLS or other Providers' verification.

Production keeps PostgreSQL and secrets externally managed. Image definitions,
dependency contracts, direct Helm commands, and the production, Debug, and
development profiles are in
[charts/tali-guard/README.md](charts/tali-guard/README.md),
[values.yaml](charts/tali-guard/values.yaml),
[values-debug.yaml](charts/tali-guard/values-debug.yaml), and
[values-dev.yaml](charts/tali-guard/values-dev.yaml).

Runtime endpoints are exposed by each Runner pool Service. The Controller
Ingress exposes only the management UI/API; Integration runtime traffic does
not traverse Controller. Playground requests are the exception: Controller
orchestrates their model call and invokes Runner's internal Guardrail endpoint.
