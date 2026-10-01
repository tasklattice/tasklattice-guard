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
                                                       +-> Redis call context

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

### Policy source packages

Policy authoring uses one directory per Policy and one YAML file per Rule.
The `policy.yaml` manifest explicitly owns Rule order, tests, resources and
optional documentation. Built-in and custom packages use the same schema,
coverage checks and detector adapter registry. See the [authoring guide](../policies/README.md)
for the directory contract and commands.

`scripts/policy_sources.py` resolves package-local resources and compiles the
sources into the shared JSON catalog. Runtime requests never parse source
YAML. Controller pins local Policy definitions and resolved parameters into
the Guardrail plan; Runner uses that snapshot instead of looking up mutable
catalog definitions during execution. Existing native model capabilities
continue through their registered platform adapters.

Package regression runs the actual Controller plan builder and NeMo runtime.
Rule-scoped cases isolate selected Rules; Policy-scoped cases preserve the
complete sequence. Assertions include decisions, exact transformed text and
ordered Rule matches. CI checks generated catalog drift and runs local cases;
model-dependent cases are explicitly `not_run` until tested in a configured
model environment. Custom package transfer uses directory import or a ZIP
containing declared files, file hashes and detector dependencies. Import does
not publish or activate a Guardrail.

### Runtime resources

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

Runner initiates a long-lived gRPC stream authenticated with a Runner token.
Production defaults to mutual TLS; explicitly disabling `security.controlTls.enabled`
selects plaintext gRPC without changing Token authentication or artifact signing.
It registers first, then sends heartbeats, load,
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

Detector results use one contract across local evaluators, model adapters,
NeMo Actions, traces, and the control protocol:

| `verdict` | Meaning |
| --- | --- |
| `matched` | The detector found its configured target condition. |
| `not_matched` | The detector completed and did not find that condition. |
| `unknown` | The detector could not establish whether the condition holds, for example because context or proof is insufficient. |
| `error` | The detector failed to execute correctly, including invalid configuration, timeouts, and malformed provider responses. |

A target is the violation being detected: PII presence or a topic-boundary
violation, for example. An allowed topic therefore yields `not_matched`.
`not_matched` does not certify overall safety. Detection is independent of the
Policy's `allow`, `block`, or `transform` decision; the same match can lead to
any of these actions. Existing escalation and failure policies resolve
`unknown` and `error` without relabeling them as a match.

Provider-native labels such as `safe`, `unsafe`, and `controversial` remain in
provider parsing and evidence, and are normalized at the evaluator boundary.
Grounding claim support and formal proof results retain their domain-specific
values; inconclusive claims or proofs produce `unknown` unless a violation is
established. A malformed response produces `error` rather than `unknown`.

This is a breaking detector contract. Upgrade Controller and Runners together
and recompile/republish existing Guardrail artifacts with compiler v25 or later.
Stored JSON traces and external consumers using the old detector labels need
migration; runtime parsing does not accept the old labels as aliases.

## Effective releases and streaming

### Native output engine

Compiler v26 enables NeMo 0.24's public `stream_async(generator=...)` for
unconditional, non-transforming Content Safety output rules using required,
fail-closed modules and an incremental delivery mode. It emits direct Action
rails in Policy order, `parallel: false`, and `stream_first: false`. Actions
return NeMo `RailOutcome`; their metadata retains the existing Policy evidence.
Every complete-response `NeMoRuntime.evaluate()` output call becomes a one-item
source for `NeMoRuntime.protect_output()`. Configurations compiled for native
streaming therefore also use its direct rail dispatch for complete checks,
avoiding Colang 1's per-rail event limit for larger output Policy collections.

`NeMoRuntime.protect_output(request, source, ready=..., emit=..., observe=...)`
is the single output execution boundary for all published configurations.
It acquires the pinned NeMo instance once, then announces the compiled delivery
contract through `ready`. Native configurations delegate windowing, overlap and
ordered rail dispatch to NeMo. Other configurations collect the bounded source
and invoke NeMo's complete evaluation once, preserving transformations and
programmable flows. The Service handles routing and release assignment without
choosing a delivery mode, accumulating output, or scheduling Policy checks.

Both modes share source limits, deadline, cancellation, safe error handling and
the `guardrail.output` span. All NeMo API paths reuse the same request context,
model-observation scope and concurrency admission lifecycle. No additional
event queue or producer task is introduced inside the engine.
`emit` and `observe` are awaited async callbacks; only `emit` supplies approved
text. `observe` supplies each check's `ProtectionDecision`, including failed
checks. NeMo diagnostic JSON is never forwarded as model content. Valid model
text that happens to look like an error JSON object remains deliverable.

The default window is 200 iterator items with 50 retained items. For external
generators these are **frames, not characters or tokenizer tokens**. The overlap
must be positive and smaller than the window: in pinned NeMo 0.24 a zero overlap
retains the buffer because of its `[-context_size:]` slice. The adapter does not
patch that implementation. NeMo may check the retained tail again at EOF, even
when it has no new content to release. These are overlapping-window checks,
not accumulated-prefix checks; previously delivered content cannot be recalled.
Model clients should yield incremental deltas without pre-buffering large
batches. Full-response guarantees still require `full_buffered`.

The result distinguishes `completed` from `blocked`. Evaluation, upstream or
delivery failure raises `OutputStreamEvaluationError`; it never permits raw-output
fallback. Block, error and cancellation close the source and release admission.
The source must end only on confirmed normal upstream completion and raise on
truncation. Defaults cap a stream at 300 seconds, one million characters and
100,000 frames. Input checks, Endpoint authorization and route resolution remain
the caller's responsibility. Transforming, conditional, arbitrary Colang and
full-buffered policies use this same entry with complete-response delivery.
The lower-level native streaming adapter is limited to the configurations the
compiler explicitly enables; it does not act as a second general executor.
The existing NeMo public API calls remain encapsulated behind this boundary;
no NeMo fork or private streaming implementation is patched.

### WebSocket delivery protocol

Runner exposes `/runtime/v1/endpoints/{id}/guardrails/output-stream` as a WebSocket.
One connection pins the call context, release and model revision, supplies the
source generator to NeMo and forwards approved deltas. The old per-chunk HTTP
state machine and Redis output-buffer/lock storage have been removed.

The `start → ready → delta/ack → end → completed|blocked|error` protocol separates
input credits from approved delivery. Eight outstanding frames bound Relay's
lookahead while NeMo checks. The socket reader continues listening for disconnects
during model calls, cancelling execution and freeing admission on disconnect.
Relay serves normal SSE to clients and closes the model iterator on block, error
or cancellation. It verifies upstream completion before sending `end`.

Requested incremental modes use NeMo window buffering. Full-response policies
collect the complete source and run the same NeMo evaluation path once, preserving
transformations. Client delivery always uses the approved output events.

Redis still shares Input/Output call context (default TTL 300 seconds), including
release identity, up to 20 messages and input blocks. These can contain protected
content; production Redis requires private access and appropriate protection.
An output connection cannot resume on another replica. If its pinned release is
unavailable, the call fails closed. Release leases keep existing runtimes alive
while calls drain; Redis does not replicate model clients or native iterators.

See [the protocol](gateway-integration.md#6-streaming-output-guard),
[native engine tests](../tests/control_plane/test_native_output_stream.py),
[network tests](../tests/data_plane/test_stream_safety_network.py) and
[actual Relay SSE tests](../tests/e2e/test_relay_stream_delivery.py).

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
  OrbStack credentials are `admin` / `Password`; production requires a strong
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

Contextual Grounding and Automated Reasoning independently require a verified,
active `contextual_grounding.output` or `automated_reasoning.output` assignment.
Creation and draft editing disable unavailable checks and their configuration,
while allowing existing bindings to be removed. Preset and document proposals
cannot bypass this requirement, and unavailable bindings block preview/save.
A control-plane model or connection-only probe is not capability evidence.
Grounding additionally needs query/source content; reasoning needs a versioned
formal policy and a compatible reasoning service, not a generic chat endpoint.

### Guardrail Profiles

A Profile is a preconfigured starting template, distinct from a Guardrail draft
and from an evaluator/model profile. `guardrail_profile` stores its category,
default flag, enabled state, display order, and versioned definition, including
ordered Policy/version references, Rails and parameter values. Migration 0013
seeds defaults for General, Banking, Securities, Internet support and Singapore
finance. Its partial unique index allows one enabled default per category.
Seeds run once through the migration journal; runtime startup never replaces
operator changes. Add new defaults through a migration, not a request-time seed.

`GET /api/v1/guardrail-profiles` reads enabled records from PostgreSQL on each
request and expands their pinned Policy references. The legacy
`/api/v1/policy-catalog/protection-presets` route remains a database-backed alias.
Both require authenticated Policies read access. Profile application copies
bindings into the draft; later Profile changes do not rewrite existing Guardrails.
The UI initially loads the General default and lists all Profiles in one dropdown,
with the name followed by industry/use-case and default tags. It preserves
explicit append/replace/cancel/undo behavior.
Choosing blank is respected. Runtime model availability gates still apply to
all selected bindings, including those inherited from a Profile.

### Unified Rule detector contract

Policy source packages use one Rule contract: stages, a versioned detector reference with parameters, and post-match handling. The compiled Rule retains `detector.ref` and `detector.version`; the former `form` enum and Policy `forms` aggregate are removed. Catalog/API discovery exposes `detectors` instead. Internal `implementation.execution` routes local checks, platform capabilities, and existing programmable Flows; it is not another author-facing Rule type. Local content filtering dispatches on the resolved detector and uses common Rule ordering, effect application, and rejection handling. Unknown local detectors raise an error instead of silently passing. Registered adapters own NeMo bindings, while source packages cannot supply executable code.

Pattern detection uses `text/regex` with optional candidate validators (`date`, `weighted_checksum`, `luhn`). Business-specific identifier formats, date offsets, alphabets, weights, and check-character maps live in the Policy Rule. Controller snapshots retain the validated configuration, and Runner applies every configured check to both literal and normalized number candidates before recording a match. Country-specific detector entries and dispatch branches are removed; adding a format supported by these algorithms needs Rule data and regression cases, not another runtime detector.

### Rule detection and Gateway directives

A Policy is a collection of Rules plus metadata, resources and tests. Each Rule is the smallest business-processing unit and owns its stages, detector configuration, risk level and on-match directive. LocalDetector accepts only technical DetectorInput and returns evidence/spans; the Policy executor separately attaches Rule identity, pinned risk and handling requirements. Detection must not branch on a handling action. Runner may compute a replacement view for subsequent checks, but Gateway/application enforcement remains authoritative for the actual model request and delivery.

Local category heuristics and competitor vocabulary are now source-owned text/conditions predicates. Code structure and execution-request detection are separate Rules. Parameterized phrase entries materialize into ordinary keyword Rules before plan publication; concrete IDs, actions and risk levels are included in immutable snapshots. No phrase-sequence detector interprets actions.

Model classification references share model/classifier with explicit compatible profiles. Grounding and formal verification retain distinct contracts. Existing platform-native execution adapters remain; this change does not claim that custom source packages can register model-backed Rules yet.
