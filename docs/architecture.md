# Guard Controller and Guard Runner

Architecture checked against the repository on 2026-09-14.

## Components and ownership

TaskLattice Guard has two application component types:

| Component | Owns | Source |
| --- | --- | --- |
| **Guard Controller** | React/TanStack UI, Hono management API, Better Auth identity, PostgreSQL state, publication, reconciliation, audit, runtime logs, capacity recommendations | `controller/` |
| **Guard Runner** | FastAPI runtime API, local Endpoint authentication, routing, NVIDIA NeMo Guardrails compilation/evaluation, artifact activation, telemetry export | `runner/` |

`GuardRails 0` is the mandatory compiler-capable Runner pool, identified
internally as `default`. It is a Runner role. NeMo code lives in
`runner/toolkit/`; Controller does not load NeMo, and Runner receives no
Controller database credentials. PostgreSQL, Redis, and observability backends
are supporting dependencies.

## Deployment topology

The chart runs one Controller and at least two GuardRails 0 Runners. Every
Runner pool is a StatefulSet with stable ordinal identities. A stable Runtime
Service balances across ready replicas with `sessionAffinity: None`; a private
headless Service provides StatefulSet identity. Upstreams use the Runtime
Service, not individual Pod names.

```text
AI Gateway / LiteLLM / AI App -> Runtime Service -> Guard Runner -> NeMo / models
                                                       |
                                                       +-> Redis call/stream state

Operator / API client -> Guard Controller -> PostgreSQL
                              ^      |
                              |      +-> Runner internal HTTP API (Playground)
                              |
                       Runner-initiated gRPC stream
                       + separate HTTP telemetry/credential requests
```

Production Endpoint checks bypass Controller and PostgreSQL. Playground is an
explicit exception: Controller orchestrates model calls and invokes Runner
checks, including isolated draft previews and path tests.

The baseline provides data-plane rolling-update availability using two Runner
replicas, readiness checks, `minReadySeconds: 5`, a `minAvailable: 1` PDB, and a
drain window. It does not provide complete infrastructure HA: Controller is a
single replica, the chart does not enforce placement across failure domains,
and development PostgreSQL/Redis are single replicas. Production HA requires
appropriate scheduling, spare capacity, and HA dependencies.

Already synchronized Runners can serve their last-known-good generation during
a temporary Controller outage. Management, publication, reconciliation, and
telemetry ingest depend on Controller availability. Runner state uses an
`emptyDir` in the chart; local recovery data does not survive Pod replacement.
See the [deployment guide](../charts/tali-guard/README.md) for configuration.

## Resources and routing

| Resource | Responsibility |
| --- | --- |
| Policy | Versioned Rules, actions, parameters, and test cases |
| Guardrail | Ordered Policy composition, draft validation, immutable compiled versions |
| Router | Ordered Routes selecting weighted, fixed Guardrail versions in a published Revision |
| Endpoint | Runtime integration configuration, credentials, and explicit Router binding |
| Provider / Model / Guardrail Catalog | Provider connectivity, physical model callability, and validated Rail assignment respectively |

Policies and Rules execute in configured order. Rejection stops execution;
transformations change the content seen by subsequent Rules. Guardrail identity
has no separate business-purpose field; natural-language/document input helps
author Policies rather than becoming an implicit runtime prompt.

A Router Revision contains ordered matching Routes with exactly one enabled,
unconditional fallback last. Each Route distributes traffic using integer
weights totaling 10,000 basis points. Publishing resolves draft version choices
to immutable Guardrail versions and artifacts. Assignment uses versioned HMAC
hashing of call identity, Router revision, and Route ID; retained call context
pins the selection for subsequent checks.

Router publication checks the reviewed draft, uses an idempotency key, stores a
new immutable Revision, and advances desired generation. `activeRevision` is
Controller's desired revision; Runner acknowledgements determine deployment
status. Activating another Guardrail version does not rewrite versions pinned in
published Router Revisions.

The routing contract is defined in
[routing.proto](../proto/tasklattice/guard/control/v1/routing.proto). See
[revision lifecycles](revision-lifecycle.md) for rollback and deletion, and
[API conventions](api-contract.md) for management API semantics. Controller
serves its generated OpenAPI contract at `/api/openapi.json` and reference UI at
`/api/docs`.

## Control protocol

Runner initiates a long-lived gRPC stream authenticated with a Runner token and,
in production, mutual TLS. It registers first, then sends heartbeats, load,
compile/validation results, and ACK/NACK messages. Controller sends desired
state, compile/validation requests, and drain commands.

[Proto contracts](../proto/tasklattice/guard/control/v1/) are authoritative for
this gRPC channel:

| Files | Contract |
| --- | --- |
| `runner_control.proto` | Stream envelopes, registration, load, desired state |
| `runtime.proto`, `artifact.proto` | Guardrail Plans, compilation, signed artifacts |
| `routing.proto`, `endpoint.proto` | Router Revisions, traffic selection, credential verifiers |
| `model.proto` | Model runtimes, Rail bindings, model configuration, capability validation |
| `evaluation.proto`, `validation.proto` | Evaluation evidence and validation runs |
| `common.proto`, `enforcement_action.proto` | Shared enums and enforcement semantics |

Business envelopes use typed messages. Compiled NeMo YAML/Colang remain opaque
text, and fields such as `CapabilityValidationCase.output_content` explicitly
carry JSON-encoded diagnostic evidence. Proto does not define every HTTP
exchange between the components: runtime-event batches and model-credential
resolution use separate authenticated Controller HTTP endpoints; Playground
also uses Runner HTTP APIs.

Generated bindings live in `runner/generated/` and
`controller/server/generated/control-protocol/`, with domain conversion in the
protocol boundary codecs. Enforcement-action helpers are also generated from
Proto. Contract comments document field semantics, absence, units, and ranges.
Run `make proto-generate` after changes and `make proto-check` to detect stale
outputs. Management OpenAPI has separate `openapi:generate` and `openapi:check`
scripts in `controller/`.

## Publication and model execution

1. Controller validates the current Guardrail draft and builds a canonical Plan.
   The browser does not submit raw NeMo YAML or Colang for publication.
2. A healthy GuardRails 0 Runner compiles the Plan with the pinned NeMo toolkit.
3. Controller verifies the returned checksum, signs the artifact with Ed25519,
   stores it, marks the version `ready`, and advances desired state as applicable.
4. Target Runners verify checksums/signatures, stage and prewarm the complete
   desired state, then atomically activate it. NACK preserves the previous state.

A version's `ready` build status does not imply Runner deployment convergence.
PostgreSQL is authoritative; the stream accelerates convergence.

Provider connectivity, model callability, and Rail validation are separate
checks. Guardrail Catalog revisions assign models to stable bindings such as
`content_safety.input` and `content_safety.output`. Input and Output execute
today; Retrieval, Dialog, and Execution are reserved Rail types. DeepSeek
Providers are control-plane-only. The active data-plane projection includes
only models referenced by its bindings; credentials are resolved separately and
are not embedded in artifacts or desired-state snapshots.

Capability validation compiles and exercises a candidate binding through the
actual NeMo runtime, using a short-lived, candidate-scoped credential lease.
Evidence belongs to that binding and its contracts. It neither activates the
candidate nor certifies comprehensive model quality; grounding and formal
reasoning also require Policy-specific sources or references.

NeMo executes versioned Evaluation Contracts through local evaluators and
`GuardEvaluateAction@1.0.0`. Evaluator profiles define compatible contracts,
prompts/parsers, and transport; model clients perform I/O. Fallback is limited to
compatible contracts. Artifacts pin behavior and dependencies, while active
bindings select physical models. Semantic PII results without trustworthy span
offsets redact the complete evaluated content block.

## Effective releases and streaming

Each call pins an effective release derived from desired generation, signed
artifact checksums, and model configuration. Old materialized runtimes remain
leased until their calls drain. A replica unable to serve the pinned release
fails closed; shared Redis does not replicate historical model clients or
guarantee uninterrupted calls across cold rollouts.

Every pool with multiple replicas requires Redis. Call context is keyed by a
SHA-256 digest of `call_id`, with a default five-minute TTL. It includes routing
and release identity, up to 20 messages, and input content blocks. Stream state
also retains output buffers, sequence, and completion state with an idle TTL.
These values can contain protected content and are JSON, not application-level
encrypted payloads. Production Redis needs private access, authentication, and
transport encryption.

The output-stream API accepts ordered chunks; it does not proxy upstream
text generation or serve SSE. Callers must retain `call_id` and `stream_id`,
submit increasing sequences serially, await each response, forward only
`released_text`, and send `final=true` on completion. They must cancel upstream
generation on `terminate=true` or transport failure. Lost responses must not
cause speculative text delivery or sequence advancement.

`full_buffered` checks the complete response. Incremental modes release checked
text with bounded buffering; they cannot recall text released before later
context changes a verdict. Policies requiring complete-response checks force
the effective mode to full buffering. The API reports requested/effective modes,
fallback reason, and effective release. LiteLLM pre/post callbacks or a successful
connectivity check alone do not prove incremental stream protection.

## State ownership and lifecycles

[Controller lifecycle vocabulary](../controller/shared/lifecycle.ts) owns
Guardrail, version, validation, Endpoint, and Runner states.
[Router rollout logic](../controller/shared/router-lifecycle.ts) separately owns
Router deployment projections. Values on the gRPC wire are defined in Proto.

| State axis | Meaning |
| --- | --- |
| Guardrail resource | `draft` or `active`; `disabled` is terminal after soft deletion |
| Guardrail version | `compiling` -> `ready` or `failed`; compilation does not interrupt an already active version |
| Validation run | `queued` -> `running` -> `passed` or `failed`; a fast result may complete directly from `queued` |
| Endpoint | Reversible `active` / `disabled` until terminal soft deletion |
| Runner | `syncing` / `offline` reflect convergence/connectivity; synchronized Runners report `ready`, `busy`, or `saturated` pressure |
| Router rollout | `unpublished`, `distributing`, `active`, or `failed`, derived from publication, generation, fresh Runner ACKs, and errors |

UI readiness (`needs_validation`, `ready`, `protected`), empty validation history
(`not_run`), and Endpoint setup progress are derived views, not writable resource
lifecycles. Router rollout can return from `active` to `distributing` when Runner
heartbeats expire or replicas fall behind.

Guardrail and Endpoint soft deletion checks recent traffic and telemetry
freshness. Recent traffic requires explicit second confirmation and the exact
resource name; the API records a reason and preserves versions, artifacts, and
audit/runtime evidence. Historical version deletion is a separate operation
with reference, convergence, and in-flight retention checks. Router rollback
publishes a new Revision; Guardrail rollback activates an existing ready version.
See [revision lifecycles](revision-lifecycle.md) for the exact constraints.

## Identity, secrets, and retained data

- Better Auth owns human identity, sessions, passwords, and roles. Local
  OrbStack credentials are `admin` / `admin`; production requires a strong
  bootstrap Secret. Bootstrap creates a missing identity without resetting an
  existing password.
- Management API clients can use personal Access Tokens with module permissions,
  expiry, and revocation. Effective permissions are bounded by the user's current
  role. These tokens are separate from Endpoint credentials and Runner tokens.
  See [Access Tokens](account-access-tokens.md).
- Endpoint credentials are shown once; Controller stores SHA-256 verifiers and
  projects them to Runners for local authentication. Controller holds the artifact
  signing private key; Runners receive the verification public key.
- Runtime events contain bounded metadata by default. When the Guardrail logging
  level qualifies and an encryption key is configured, Runner encrypts captured
  before/after content with AES-GCM before writing the WAL or exporting it.
  The same encrypted payload includes the HTTP request received at the Runner:
  method, target, HTTP version, ordered headers (including duplicates), and the
  complete body bytes. Authentication header values are replaced with
  `[REDACTED]` before encryption. Controller exposes this envelope only on
  administrator detail reads with `includeContent=true`; lists and ordinary
  detail reads exclude it in SQL, before allocating a body in Controller.
  Opening an Item loads metadata and Trace only. Expanding a content panel or
  clicking download fetches that checkpoint's body on demand; closing the panel's
  sheet aborts pending reads and releases its content. Previews are bounded to
  64 KiB with limits on JSON tokens and nesting; downloads remain complete.
  The console displays only the body, formatting and highlighting valid JSON
  without changing numeric precision. HTTP downloads retain the captured body
  bytes and headers. Older records without an HTTP envelope offer retained-text
  downloads only; missing headers and original bodies cannot be reconstructed.
- Runtime logs and routing events are batched from the local Runner WAL to
  Controller over authenticated HTTP outside the synchronous protection path.
  Redis call/stream content has the separate retention boundary described above.

## Capacity and verification

Runner heartbeats report load, resource pressure, latency, error/timeout deltas,
compile load, applied generation, and the observation interval. Controller
aggregates interval-correct RPS, weighted errors, worst-Runner latency, headroom,
and queue-aware replica recommendations. Scaling remains the responsibility of
Kubernetes/Helm or an external autoscaler.

Metrics distinguish policy decisions from technical failures and expose control
convergence and telemetry freshness. See the
[observability contract](../observability/README.md) for metrics and alerts.

Architecture acceptance covers chart topology/Redis/mTLS constraints, independent
component builds, signed artifact verification and atomic activation, direct
Runner traffic, pinned call/stream behavior, authenticated telemetry with encrypted
content capture, and deletion evidence retention. Run the relevant Controller,
Runner, protocol, and Helm checks through the repository's Makefile and package
scripts; this document is not a test-results ledger.


## Topic Control boundaries

Topic Control drafts carry `allowedTopics`, `restrictedTopics`, and
`topicControlMode` (`strict` or `permissive`). New drafts and intent analyses
default to permissive mode. Existing drafts without a mode
remain strict. A denied task takes precedence over an allowed task. Strict mode
requires every substantive requested task to fit the allow-list; permissive mode
allows unmatched tasks after denied-topic checks. Other safety Policies and
fail-closed handling of model errors remain in effect.

The authoring UI uses one intent description with placeholder examples for the
business purpose, allowed tasks, prohibited behavior, and exceptions. The configured
control-plane AI returns editable `allowed_topics` and `restricted_topics` lists;
the user-selected mode is preserved, and applying the proposal is explicit.
Document analysis extracts both lists from source evidence. Draft editing,
candidate previews, immutable plans and both NeMo topic execution paths preserve
the same configuration. New modes always request semantic judgment; merely
mentioning an allowed phrase cannot skip denied-topic evaluation. Existing
immutable artifacts marked `topic_mode=allowlist` retain their legacy behavior
until a new version is published. Semantic classification is probabilistic;
Policy validation includes mode-aware unmatched-topic and denied-topic cases.


Intent and document authoring use at least a 60-second model timeout, or the
configured model timeout when longer, because structured proposals take longer
than short connection probes. Timeout failures return HTTP 504; upstream HTTP,
transport, response decoding, and proposal validation failures return HTTP 502
with a distinct `stage`. Administrator responses include provider/model,
endpoint, a diagnostic ID, elapsed time, upstream status/request ID when
available, and redacted response/validation evidence. The UI preserves the
message and displays expandable diagnostic details. Server logs retain only
correlation and timing metadata, never prompt/document or response content.
A socket disconnect before TLS establishment is retried once within the same
request deadline. Certificate errors, provider HTTP failures, timeouts, and
response validation failures are not retried automatically.


Guardrail creation checks the active `topic_control.input` assignment on the
Configure protections step. Missing, unverified, failed or inactive assignments
keep Topic Control visible with a setup explanation, but disable model-dependent
Policy selection and topic boundary authoring. Local keyword Policies remain
selectable. Preset selections are preserved and removable; unavailable topic
bindings block candidate preview and creation. Both intent and document authoring
entry points are hidden until the runtime capability is ready. The five protection
sections are Safety & attacks, Data & privacy, Business rules, Topic Control and
Correctness checks. Classification follows policy purpose; model readiness is a
separate state. Local keyword rules remain under Business rules. Availability refreshes while the
wizard is open; the control-plane authoring model is not runtime capability evidence.
