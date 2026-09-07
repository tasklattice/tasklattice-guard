# Test architecture

For the ordered final release procedure, environment inputs, write boundaries
and the distinction between deterministic replay and real-model quality, see
[Protection release acceptance](protection-acceptance-runbook.md).

The automated tests follow the same ownership boundary as the product. A
failure should say whether Controller produced the wrong state, Runner failed
to execute valid state, or the two sides could not converge.

| Gate | Command | Owns | Must not do |
| --- | --- | --- | --- |
| Control plane | `make test-control-plane` | Controller API/UI, plan flags, validation, compilation, signing, model configuration and activation | Make a real provider call |
| Data plane | `make test-data-plane` | Artifact verification, prewarm/activation, Runtime API, routing, enforcement, telemetry, last-known-good recovery and mocked model execution | Import the compiler or Validator |
| Communication | `make test-e2e` | Real Runner gRPC client/server stream, authentication, desired-state delivery and ACK/NACK convergence | Depend on an external model or Controller database |
| Contracts | `make test-contracts` | Protobuf generation, cross-language contracts, test-suite boundaries, Helm and release packaging | Exercise product behavior already owned by another gate |

`make test` runs all four gates, followed by Controller typechecking and the
production build.

## Artifact fixtures

Runner execution tests consume
`tests/fixtures/artifacts/local-secrets-v1/desired-state.pb.b64`. It is a
complete serialized `DesiredState` containing a deterministic, signed,
precompiled NeMo artifact plus Deployment and Integration routing. The fixture
contains only its public verification key; the deterministic private key lives
in the generator and is explicitly test-only.

Regenerate the fixture only when the compiler or artifact contract changes:

```bash
.venv/bin/python scripts/generate_test_artifacts.py
.venv/bin/python scripts/generate_test_artifacts.py --check
```

The control-plane gate checks that the committed bytes still match current
compiler output. The data-plane gate never calls the generator: it behaves like
a deployed Runner receiving immutable bytes from Controller. It verifies safe
input/output forwarding, unsafe blocking, authentication, corrupt-generation
rejection, and restart from last-known-good state.

## Model tests

### PostgreSQL model-draft optimistic locking

`controller/server/model-config/model-configuration.postgres.test.ts` exercises
real PostgreSQL `xmin` row-version checks, including microsecond timestamps and
concurrent validation/edits that retain the same timestamp. It uses a random
temporary schema, copies only table structures from an already migrated local
database, and removes that schema afterwards. No public rows or Provider calls
are used. This is opt-in; ordinary service tests do not emulate DB concurrency.

Supply a loopback-only `GUARD_TEST_POSTGRES_URL` through your private environment,
then run from `controller`:

```bash
npx vitest run server/model-config/model-configuration.postgres.test.ts
```

The row version is an internal database snapshot token, not an API field or a
persistent identifier. Do not cache it across transactions, backups or restores.

### Recorded real responses: offline Mock Provider

The 2026-09-07 isolated smoke round recorded real DeepSeek and NVIDIA responses.
Portable samples live in `tests/fixtures/model_responses/20260907-nvidia-smoke.json`.
They include successful content classifications, a real HTTP 500 and an observed
JailbreakDetect false negative. Observed failures are not approved behavior or
independent quality acceptance. Inputs are synthetic; no credentials or headers
are stored in these fixtures.

```bash
.venv/bin/python -m pytest -q tests/data_plane/test_model_response_gateway.py tests/data_plane/test_recorded_model_responses.py
.venv/bin/python scripts/model_response_gateway.py --fixtures tests/fixtures/model_responses/20260907-nvidia-smoke.json --port 8097
```

Mock base URL: `http://127.0.0.1:8097/nvidia/v1`. Requests must match a recorded
route and complete JSON payload, including prompts and generation parameters.
Responses are consumed in recorded order; a missing/exhausted match returns409,
never falls back to a real model. Restarting resets offline replay cursors.
These selected fixtures do not provide catalog discovery or arbitrary chat.
Full SQLite recordings can instead be replayed with `--database PATH`.

For a separately authorized synthetic live recording, pass `--live`, a new
`--database PATH`, `--credentials-file PATH`, `--limit N` (maximum200), and
`GUARD_HOLDOUT_ALLOW_MODEL_CALLS=1`. Only the explicit endpoint/model allowlist
is reachable. Every outbound attempt, including catalog GETs and callers'
automatic retries, is reserved in SQLite before dispatch; failures consume
budget. The gateway itself does not retry. Live mode must be stopped after a
round. The request cap is not a monetary accounting guarantee.

The data-plane replay tests consume existing signed execution artifacts, not a
compiler: six tests cover recorded safe/unsafe Output decisions across all three
stream modes. Full buffering also checks that a fragmented prefix is not released
before the final classification. Partial-window safety quality still requires
separate reviewed live cases; whole-response recordings cannot establish it.

### Custom Policy parameter data boundary

Custom Colang `${name}` placeholders are supported inside quoted strings only.
Bindings supply literal string data, not executable Colang snippets. Missing
values fail compilation; comment placeholders are ignored. Substitution is
single-pass and escapes NeMo variable/expression interpolation as well as
quotes and newlines. This does not sandbox the Policy author's own source.

`test_policy_source_symbols.py` executes the real NeMo runtime with adversarial
parameters in both directions and all supported quote styles. The independent
data-plane `test_custom_parameter_artifact.py` loads the signed
`custom-literal-parameters-v1` fixture without importing the compiler. These
are code/data-boundary checks, not LLM prompt-injection quality measurements.

### Reviewed live-model holdout replay

`scripts/evaluate_model_holdout.py` runs a reviewed external JSON corpus against
an **existing generic-http-guard Integration**. It does not register Providers,
publish Guardrails, generate business-model responses, or exercise streaming.
Output examples are fixed upstream-response content fed to the real Output Rail.
The report measures the whole pinned Guardrail's allow/block decisions with
observed guard-model calls, not the isolated classifier's accuracy. Transform
outcomes require a separate exact-output contract and are not silently counted
as successful blocks by this binary-quality gate.

The corpus object must include:

- `dataset_version`, `reviewed_by`, `reviewed_at`: the independently reviewed
  holdout identity, not the training/tuning or Policy-authoring test set.
- `integration_id`, `guardrail_id`, `guardrail_version`, `effective_release_id`,
  `model_revision_id`, `runtime_config_checksum`: pin actual deployed evidence.
- `thresholds`: `max_false_positive_rate`, `max_false_negative_rate` (0–1) and
  `min_cases_per_class` (positive integer), agreed **before** tuning the models.
- `cases`: unique `id`, `phase` (`input`/`output`), `category`, `content`,
  `expected` (`allow`/`block`), `model_name`, `capability`, and optional `messages`.
  Each category/direction needs both benign and unsafe examples meeting the
  reviewed minimum. Example metadata strings are not proof of an independent
  review; the review and corpus provenance remain release evidence to supply.

Example invocation after exporting a dedicated Integration key:

```sh
GUARD_HOLDOUT_ALLOW_MODEL_CALLS=1 .venv/bin/python scripts/evaluate_model_holdout.py \
  /absolute/path/to/reviewed-holdout.json --runner https://isolated-runner.example \
  --max-cases 100
```

Set `GUARD_HOLDOUT_INTEGRATION_KEY` in the execution environment; never place
credentials in the corpus. `--max-cases` is an explicit HTTP-request cap, **not**
a token/dollar cap: one Guardrail request may call several models or use provider
retries. The harness itself makes sequential requests with no retry, checks TLS,
does not follow redirects, and stops on the first infrastructure or evidence
failure. It makes no calls without opt-in and rejects an oversized corpus before
network setup. Missing or failed calls are not true positives; zero-evidence
rates are null and incomplete/error groups cannot pass. Rates are grouped by
category/direction, with separate error counts/rates. The JSON report includes
corpus SHA256, thresholds and pinned identity but no input, response, or key.

`tests/data_plane/test_model_holdout_report.py` verifies accounting, version/model
evidence, authorization/budget gates, no redirect, and report privacy using
synthetic transport. Passing those tests is **not** a live-model quality result.

### Registered Action exceptions

`test_policy_action_failures.py` runs real NeMo with missing/extra Python Action
arguments and an actual Action-body type error, in both directions. The validator
must classify the failure and must not count an unexpected infrastructure block
as a successful unsafe-content case. Even an unclassified runtime failure cannot
pass an ordinary block test. `provider_failure` is the existing validation
contract for non-timeout Action execution failures; it does not imply an external
model was called.

`test_action_failure_artifact.py` consumes the frozen custom-symbol artifact and
faults an actual registered Action, not its verdict. It verifies terminal errors,
concurrent/request isolation, safe diagnostics, full-buffered HTTP withholding,
retry without committing a failed chunk, and the 502/504 distinction. The failure
boundary preserves NeMo's Action signatures and uses its public exception
propagation path; it does not patch upstream dispatch or log Action arguments.

For isolated persisted lifecycle replay, `regress_stream_failure.mjs` accepts
`GUARD_REGRESSION_ACTION_DISPATCH_FAILURE=1`. Unlike its original unbound-flow
fixture, this actually fails Python argument binding. Its explicit synthetic
failure test must pass before publication; no business Policy tests are excluded.
If it stops before Policy publication, resume only the unchanged fixture with
the original `GUARD_REGRESSION_RUN_ID` and `GUARD_REGRESSION_POLICY_ID`. After
publication, use `GUARD_REGRESSION_GUARDRAIL_ID` instead. Inspect retained records
before resuming; never create duplicates merely because a poll timed out.

Provider and Model Runtime behavior is tested inside Runner with in-memory
credentials and deterministic mocked provider responses. Tests cover provider
selection, capability/profile compatibility, timeout/error handling and actual
evaluation routing without network access or secrets. Controller tests cover
drafting, validation, activation, credential leasing and multi-Runner
convergence separately.

## Adding or changing a feature

New Python test modules must be placed under `tests/control_plane`,
`tests/data_plane`, `tests/e2e`, or `tests/contract`, or explicitly assigned in
`tests/conftest.py`. Collection fails for unclassified modules. A contract test
also rejects compiler or Validator imports from the data-plane suite.

For a new Guardrail flag, add a control-plane assertion that it survives plan
construction and compilation, then add a data-plane assertion using a refreshed
artifact fixture. For a protocol change, update both generated bindings and add
an ACK/NACK or compatibility assertion. For a model capability, test Controller
validation and Runner execution independently, using a mock response in Runner.

Focused library assets are mechanically materialized with
`node scripts/build_protection_library.mjs --write`; `--check` verifies the result.
Their control-plane tests compare migrated detector definitions and acceptance
inputs with the source collections, check complete-value redaction, and compile
both individual extended Policies and complete scenario presets through the real
Controller/protobuf/NeMo path. This is separate from the frozen-artifact data-plane
tests and does not establish live-model detection quality.

Default is generated with no detection-model dependency and explicit
`full_buffered` delivery. Its frozen-artifact streaming tests split PII and
injection payloads into single-character chunks, require no body release until
the full response passes or is transformed, and assert zero model invocations.
Model-free execution does not imply that a protection is safe to evaluate on
independent chunks.

### Streaming concurrency with real Redis

The data-plane CI matrix supplies an isolated Redis service through
`GUARD_TEST_REDIS_URL`. These tests exercise two Runner store instances with real
Redis locks, TTL expiry, atomic commits and cancellation; the detector response
is controlled so that lease boundaries are deterministic. They do not require a
Controller or external model. A deliberately expired owner's result must neither
overwrite a newer commit nor release the replacement owner's lock. Three delivery
modes also verify exact checked output, sequence progression and retained TTL
across replica handoff.

For local execution, point at a dedicated loopback Redis:

```bash
GUARD_TEST_REDIS_URL=redis://127.0.0.1:56389/0 make test-data-plane
```

Without the variable, the real-Redis tests explicitly skip; the in-memory and
fake-Redis state-machine tests still run. CI sets it on every Python version, so
lease tests must execute rather than silently relying on the fake. Test cleanup
deletes only each test's randomly named stream and lock keys, never `FLUSHDB`.

Runtime stream commits require Redis scripting permission (`EVAL`) in addition
to normal lock/data access. Ownership comparison and state write happen in one
Lua operation; a separate ownership check followed by `SET` is not sufficient.
If the evaluation outlives the 120-second lease, committing fails closed. The
lease is not silently renewed or treated as a successful Policy rejection.

The focused Default migration additionally replays all 140 pre-migration inputs
from `tests/fixtures/default-policy-migration.json`. Original Rule definitions
remain available as independent references; reviewed composition expectations
stay frozen. The only normalized output marker is the deliberately consolidated
credit-card family, not arbitrary replacement text. Complete redacted spans and
surrounding text must still agree. The new composition's 321 inherited cases run
through the real TS codec, protobuf and NeMo Validator with no exclusions or
model calls. Credential rejection now applies to Output as well as Input.

The standard NeMo compiler generates one ordered entry flow per phase, invoking
the individual Policy subflows. This avoids per-rail dispatch overhead exhausting
Colang 1's event safety limit with a normal-sized focused library. It does not
patch the upstream limit, merge Policy identities or reorder actions. Real-NeMo
40-step tests assert transformations, exact invocation order, short-circuiting
and per-Policy traces in both directions. Compiler changes require refreshing
all signed fixtures before running the independent data-plane gate.

Controller and Runner use matching finite 32 MiB gRPC send/receive limits, not
the 4 MiB receive default. Full Default validation evidence is approximately
5.6 MB. Socket-level tests cover large desired-state delivery, complete 321-case
result delivery, oversized receive rejection, and repeated graceful/error
disconnects with sender cleanup. The computation is mocked in communication
tests; real NeMo correctness remains in the independent execution suites.

`scripts/regress_default_runtime.mjs` reads the published isolated Default without
editing its draft or issuing a publish request. Using the same environment keys
as `regress_protection_lifecycle.mjs`, it replays inherited cases and frozen legacy
inputs plus exact redaction, benign-order and credential-rejection checks against
the actual Runner HTTP endpoint. It verifies unchanged artifact identity and
zero model calls. Exact legacy outputs are asserted where the frozen fixture
contains one; the control-plane migration test additionally derives missing
legacy outputs from the unchanged original Rules, not from the migrated verdict.

The business-proxy replay requires `GUARD_REGRESSION_ALLOW_DEFAULT=1` to select the
isolated Default. Otherwise only named regression Guardrails are accepted. It
creates separate Integration/Deployment records, never edits the selected
Guardrail, and verifies exact input/output email redaction and full-buffered
client release timing. Its ephemeral proxy container is removed after execution;
the isolated database records remain available as evidence.

The replay also starts a loopback forwarding service on port 8098 (override with
`GUARD_REGRESSION_TRANSPORT_PORT`). Normal requests reach the real Runner; two
explicit scenarios inject HTTP 503 at the first or final Output check without
fabricating a safety verdict or stopping a Runner. Real-client assertions require
an infrastructure error and zero released content. Controlled business SSE cases
separately cover abrupt disconnect, clean EOF without a completion marker,
`[DONE]` without a finish reason, explicit inference errors, and a legitimate
`length` finish that must still pass Output checks. The proxy, business service
and forwarding service are stopped after each run. Ports must be distinct and
unused; the script never evicts another process to obtain them.

Stream state-machine tests distinguish actual Policy rejection from failed
evaluation and malformed transformation output. A failed check does not consume
its sequence or append text twice on retry, for both in-memory and Redis-backed
stores. An explicit empty transformed string is valid; a missing transformed
value must never fall back to the original. Runner stream HTTP responses use
502 for failed/invalid checks and 504 for fail-closed checks with timeout evidence,
while successful Policy rejections retain the blocked acknowledgement. The Relay
Provider also treats fail-closed usage evidence as infrastructure failure, not a
Policy match, and never reflects a private backend error body.

`scripts/regress_stream_failure.mjs` adds an opt-in real execution-failure
acceptance path. Use the isolated loopback/authentication environment documented
above and `GUARD_REGRESSION_ALLOW_WRITES=1`. It creates a named custom Policy,
validates and publishes it, validates a Guardrail with no test exclusions,
publishes a signed artifact and registers an isolated HTTP Integration/Deployment.
A synthetic marker invokes a genuinely unbound NeMo recording action: this is
not a mocked detector verdict. Safe output completes, a Policy rejection returns
the normal blocked acknowledgement, and the execution failure returns HTTP 502
without protected content. Full-buffered prefixes release no text. Set
`GUARD_REGRESSION_GUARDRAIL_ID` to replay an existing named fixture with verified
published source; it creates new integration records but does not republish or
modify the fixture. Generic HTTP convergence uses `/guardrails/evaluate`, not
the LiteLLM-specific `/verify` probe. Regression records are retained for audit.

`test_output_stream_contract.py` independently verifies delivery selection from
enabled, version-pinned Policy bindings and executable Output steps. Native
model snapshots are not arbitrary custom Colang. Unselected versions, disabled
Output rails and disabled Output Rules must not impose a full-response
requirement. Enabled arbitrary custom Output and non-incremental actions retain
complete buffering. Control-plane compilation separately tests that an explicit
custom full-response requirement constrains only the selected Output flows.

Three `stream-safety-*-v1` fixtures are built by the real Controller Policy
composition path and frozen as signed artifacts. `test_stream_safety_artifact.py`
loads those fixtures without a Compiler or Validator, uses actual NeMo execution,
NVIDIA/Qwen provider parsing and Runner stream HTTP, and checks exact released
prefixes, accumulated context, cross-chunk rejection, final output, malformed
responses and transport-failure retries. Only model transport responses are
synthetic: these tests do not establish live-model detection quality. They also
demonstrate the guarantee boundary: incremental modes retain already released
safe prefixes after a later rejection; full buffering releases no prefix.

`test_stream_safety_network.py` adds actual loopback TCP on both sides of the
Runner (no ASGITransport or MockTransport). It loads the same signed artifacts
and runs the real NeMo/provider/parser path against a synthetic HTTP model
service. For each NVIDIA/Qwen profile and all three delivery modes it covers
normal completion, cross-chunk rejection, and HTTP 503 followed by an exact
same-sequence retry. Event gates suspend the model response while the TCP client
asserts that no unchecked response bytes arrive. Released safe content is checked
exactly, not merely by the final decision. Ports are OS-assigned, servers are
task-owned and closed on exit, and no credentials or external models are needed:

```sh
.venv/bin/python -m pytest -q tests/data_plane/test_stream_safety_network.py
```

This is a real-network deterministic data-plane test, not a deployed-cluster,
Relay/SSE cancellation or model-quality evaluation. In incremental modes a safe
prefix can already have reached the caller before later text changes the
classification; full buffering is required when no part of such an answer may
be released.

`tests/e2e/test_relay_stream_delivery.py` extends that evidence through an actual
Relay/LiteLLM container. It requires an existing local image (never pulls) and the
sibling Relay TaskLattice Guard overlay, mounted read-only. All ports are assigned
for the test; no Controller records, user Guardrails or cluster workloads change.
Docker Desktop's `host.docker.internal` loopback routing must be available:

```sh
GUARD_TEST_RELAY_IMAGE=tali-litellm:protection-productization-20260906 \
  .venv/bin/python -m pytest -q -s tests/e2e/test_relay_stream_delivery.py
```

Three mode tests each run safe completion, late block, detector failure and
client cancellation both before and after the first upstream frame. Full-buffered
mode also verifies an actual 504 after the first-frame idle timeout (not a local
test-client timeout). Event gates hold the actual business SSE producer open:
incremental prefixes must arrive before producer completion and only after a
detector call; full-buffered content must not. Cancellation must close the
upstream producer within three seconds, not merely abort the local client.
Infrastructure errors must produce an explicit 5xx error, not a policy-match
4xx, success completion or truncated HTTP socket. Synthetic business/classifier
responses make this reproducible; this is not a live-model quality test.

An empty assistant-role announcement is allowed before checks so LiteLLM can
enter disconnect-aware streaming. It is neither protected text nor a completion.
The older full-buffered proxy script now measures cancellation content separately
from protocol bytes. Its historical full-suite result is not a rerun for this
change. The protected iterator now announces before reading the first upstream
frame, using one generated response identity for announcement, content,
completion and usage. Upstream identity validation remains independent. These
tests cover an established upstream response with no first frame, not DNS/TLS or
connection establishment before the protected iterator is installed. Independent
model quality remains separate; direct Runner handoff is covered below.

`test_stream_replica_network.py` starts two independent Runner instances with
separate registries, actual TCP endpoints and shared real Redis call-context and
stream stores. It stops the first HTTP server and shuts down its NeMo runtime
after the first chunk, then sends the next chunk to the second instance. All
three delivery modes must retain the pinned release/model revision, exact
accumulated candidate, checked prefix and terminal state. Safe completion,
rejection and a detector failure/retry are checked; a completed-sequence replay
cannot release duplicate text. Expiring only the test's integration-scoped
call-context key must reject continuation without a model call, re-resolution or
buffer mutation. The scope is two instances in one test process, not Kubernetes
pod eviction or a production load-balancer test.

```sh
GUARD_TEST_REDIS_URL=redis://127.0.0.1:<isolated-port>/0 \
  .venv/bin/python -m pytest -q tests/data_plane/test_stream_replica_network.py
```

It uses the existing Redis opt-in and deletes only its random owned context,
stream and lock keys; it does not flush Redis. CI's data-plane job already
provides the Redis URL. The model HTTP endpoint is synthetic; NeMo, artifacts,
parsers, Redis state and Runner network execution are real.

Publication concurrency tests use real signed fixtures and two coordinated
threads. They force health/admission readers to hold the Registry lock while
publication reaches the release boundary. Deadline-bound test locks turn the old
store-lock/registry-lock inversion into a failing assertion instead of hanging
CI. Production serializes desired-state writers separately, publishes materialized
release instances before switching routing, and never holds the store reader
lock while entering Registry publication. Existing in-flight calls retain their
previous immutable release.

### Published custom Policy version boundary

`scripts/regress_pinned_policy.mjs` uses the same explicit loopback endpoints,
authentication environment and `GUARD_REGRESSION_ALLOW_WRITES=1` opt-in as the
protection lifecycle script. It creates its own named custom Policy and Guardrail,
validates/publishes Policy v1, binds v1, then validates/publishes a behaviorally
different v2. An edit of the Guardrail must preserve v1 parameters, Rules and
immutable source checksum. Validation, signed compilation, Runner convergence,
and exact Input/Output replay must continue to use v1 with zero model calls.
The test intentionally distinguishes v1 redaction from v2 rejection and includes
negative samples that v1 allows. No Default or existing Policy is modified.

Run with the isolated lifecycle environment already set:

```sh
node scripts/regress_pinned_policy.mjs
```

Resources are retained for browser inspection. `GUARD_REGRESSION_POLICY_ID` plus
the original `GUARD_REGRESSION_RUN_ID` may resume only an unmodified published-v1
fixture if a run stopped before Guardrail creation; this is not general job
resume support. Guardrail editing through the browser and visual acceptance are
separate checks, not claimed by this HTTP script. Neither streaming correctness
nor live model detection quality is inferred from these deterministic samples.

Set `GUARD_REGRESSION_SYMBOL_MARKERS=1` for the same pinned-version lifecycle
with business detection strings deliberately equal to the authored Flow names.
This catches source-wide renaming that compiles successfully but changes Rule
semantics. The script reports the selected variant explicitly.

`test_policy_source_symbols.py` checks NeMo source-tree linking, helper calls,
unchanged variables/literals/comments, unique Flow identities and result ownership
with same-named flows. `test_custom_symbol_artifact.py` independently consumes
`custom-symbol-ownership-v1`, generated and signed offline by the production
compiler. It exercises Input, Output, ordered redaction/rejection, dynamic
result labels and real Runner ASGI streaming without importing a compiler. A
Runner lacking the versioned owned-result Action must reject the artifact before
serving it. These are deterministic custom-flow tests, not safety-model quality
measurements or a sandbox guarantee for arbitrary Policy source.

### Custom Policy declaration and publication gates

`tests/control_plane/test_custom_policy_dependencies.py` sends plans through
the production `DefaultRunnerCompiler`, not just a standalone source helper.
It checks per-Policy Action ownership, undefined and duplicate Flows, forbidden
imports, process-wide main, source parameters, selected versions and legitimate
comments/string literals using NeMo's parser. These are static named-reference
checks, not a sandbox or complete analysis of dynamic Colang expressions.

`controller/server/services/policy-validation-boundary.test.ts` verifies that
metadata validity is not reported as completed Runner validation, and missing,
failed or older-draft evidence cannot authorize publication. The Controller
does not implement a second Colang parser with regular expressions.

With the same isolated Controller authentication environment and explicit
`GUARD_REGRESSION_ALLOW_WRITES=1` opt-in, run:

```sh
node scripts/regress_policy_dependencies.mjs
```

This creates one named fixture, rejects uncovered invalid Action/Flow calls via
the actual Controller HTTP / control-channel / Default Runner path, verifies
publication returns 409, then fixes and validates the same Policy and publishes
version 1. It retains the fixture and logs its ID; a timeout requires inspection,
not an automatic rerun that creates another fixture. It never modifies Default
or creates a deployment and does not claim live-model detection quality.
