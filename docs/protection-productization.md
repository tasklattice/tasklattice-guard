# Input / Output protection productization

Status: core implementation and scoped deployed regression verified; full
acceptance remains open. This is the acceptance contract for the approved work.
The [current requirement-by-requirement audit](protection-completion-audit.zh-CN.md)
identifies the remaining C1 (dynamic custom dependencies), U1 (consolidated
desktop gate), and Q1 (independent reviewed model quality) evidence gaps.

Latest C1 increment: dynamic lifecycle-event `flow_id` targets now use the same
Policy-owned symbol mapping as ordinary Flow calls. Expressions are evaluated
before their event statement; native regex listeners are preserved. Compiler v21
and 19 refreshed signed test bundles passed freshness; the Python gate passed 1,268 tests
with 22 environment-gated skips. Both main tali Runners use dev digest
`sha256:2e83d2053a0de942ae356df1e7c8678d8bf2c0b30074cf8d4d7328feca2bae4a`.
Each deployed Runner passed six Input/Output helper checks; original Default
483/483 passed with no model calls and unchanged release identities. Arbitrary
event-object dispatch and dynamic dependency completeness remain a C1 evidence
gap; this is not a general sandbox or all-listener-timings claim.

Latest scoped acceptance: [expanded tali round](tali-expanded-acceptance-20260908.zh-CN.md)
completed at 73 NVIDIA / 13 DeepSeek calls, excluding Topic and Jailbreak:
48/48 development Input/Output cases, 11/11 three-mode real streaming cases,
real Controller artifact publication and main Runner routing, and Default 483/483.
The subsequent completion audit fixed preset previews incorrectly claiming
Policies were already selected (see the final entry below). The latest Policy
Studio fix rejects validation results from an earlier edit or editor session;
10 focused tests and a real desktop stale-result/revalidation path passed.
Controller/UI gate: 787 passed / 13 environment-gated skips; typecheck/build passed.
Current Controller `dev` digest is
`sha256:932b199e37badb18afcb2412fafb8930996f5c5a1fe7ca909a27d7e43a0544f1`.
Latest UI increment separates confirmed Policy publication from a failing detail
refresh. Read-only recovery cannot issue a second publication; late reads cannot
navigate a new editor session. Related 28 tests, type/build and a real desktop
publish-once/read-failure/keyboard-recovery path passed on `index-Dyfqjo53.js`.
The subsequent revision-pinned, idempotent publication fix also passed a real
committed-response-loss/retry path with exactly one version and publication audit.
See the [desktop matrix](protection-desktop-acceptance-matrix.zh-CN.md) for current
scope: the latest UI run has 280 passed / 1 failed, due to the old legacy-collection
assertion conflicting with another user-owned task's Policy filter redesign.
Do not restore that old UI or treat an earlier green gate as current evidence.
The subsequent focus correction explicitly connects new/import/edit openers to
the existing EntitySheet return-focus contract. Four focused files passed 23
tests; typecheck/build and real desktop Escape/Close/Cancel/Enter paths passed.
Import and nested-edit focus are component-tested, not new live-browser evidence.
This closes the observed new-Policy focus loss, not the complete U1 matrix.
No additional real model calls were made.
Latest Action-catalog correction distinguishes failed/paused/empty responses,
adds explicit retry, and preserves selections and cached rows. Four related
files passed 27 tests; typechecks and the final image production build passed.
The deployed desktop showed an injected 503, then recovered the real registry
without losing the two selected versions or form edits. The fixture forwarded
only reads and is stopped. Offline/empty/background-refresh cases have component
evidence, not additional live-browser evidence; the broader U1 gate stays open.
Earlier stage snapshots below do not override these later verified results.

Latest current-worktree gate (2026-09-08 completion audit): `make test` exited 0
with **1,973 passed / 35 environment-gated skips**: contracts55, Python control
plane681, Controller/UI779, data plane453, communication5. Typechecks, production
builds, signed-fixture/protobuf checks and Helm checks passed. This invocation
did not enable PostgreSQL/Redis/Relay/cluster options; their separate earlier
evidence remains below. No new model call, image build or deployment occurred.

Previous full local engineering gate (2026-09-08, 15:42): `make test` completed with
**1,958 passed and 35 environment-gated skips**. All 35 optional items were also
verified in this round: 13 PostgreSQL and 18 Redis cases using `tali` services,
one Helm lifecycle case confined to test-owned resources in existing `tali`, and
three baked Relay `dev` streaming replays. The Helm test was subsequently scoped
to an explicit existing namespace and its full 13-case file passed again; those
12 repeated local CLI cases are not added to the distinct total. Typechecks,
fixture/protobuf checks, Helm render/lint and production builds passed.
For prior deployment history, the
Controller was upgraded in the main OrbStack `tali` namespace (Helm revision 35).
The limited real round passed 16/16 content-safety development cases and 3/3
real business-model streaming cases; desktop committed-save/response-loss manual
recovery was verified. NVIDIA usage was 32/40 and DeepSeek 3/3, with no automatic
retry. Pure content-safety main activation was rejected because an existing
published artifact requires Jailbreak; the data-plane checks therefore used a
same-image temporary Runner inside `tali`, not a successful main activation.
See [current release status](protection-release-status.zh-CN.md) and
[tali acceptance](tali-acceptance-20260908.zh-CN.md) for current evidence. Older
isolated-environment snapshots below remain historical, not deployment advice.
Future cluster verification is `tali` only. Mobile is explicitly excluded.
The subsequent activation/ACK concurrency fix is deployed in `tali` (initially
Helm revision 36, now revision 37 with Controller `dev`). Real PostgreSQL lock/race
tests passed 13/13, related service/channel/HTTP tests 102/102 and production
build passed. Existing model and Guardrail release identities did not change.
These activation tests are now included in the current engineering evidence.
The latest Controller `dev` also includes permission-loss and Policy-catalog
refill recovery in the desktop wizard: 195 related tests passed, a delayed-catalog
browser path preserved 17 Policies/38 Rules, and the deployed digest is
`sha256:38d3df3e93a017366d1b38246d90ef685d1cb9b1d4fa45b03a40c1861f9a90f5`.
The subsequent saved-draft Policy-order editor is deployed with the same `dev`
tag at digest `sha256:28492e15023f184b2d7a8720782264457763dfd9b8f68d700ca9b5ef31012c53`.
Its 28 targeted tests, typecheck and build passed; the read-only desktop audit
verified moving Policies and restoring their order without saving. This targeted
addition is not a fresh full-suite run or a server-persistence UI acceptance.
Subsequent desktop evidence verified actual Policy reorder/save/reload in `tali`
and retired the temporary unpublished draft. The boundary keyboard-focus fix is
now deployed as Controller `dev` at
`sha256:192216c50612f06e9549b0b6015372d7c00181f41abd7246f61d5abdb6a13e7e`;
47 targeted tests, typecheck/build and real desktop first/last-row keyboard checks
passed. Default remains unchanged; the temporary draft retirement advanced the
Controller generation to 20, with both Runners converged.
Use only `dev` for local project image tags; historical tags below are evidence,
not instructions for future builds. Record digests to identify tested bytes.
This is not full production or independent live-model quality acceptance.

## Objective and boundaries

Business users create one Guardrail from an optional scenario, see the entire
optional protection map, inspect and tune versioned Policies, validate, publish,
and observe real Input / Output / streaming enforcement. Include representative
banking, securities, and internet-company presets, plus a common local baseline
and a Singapore financial reference collection. A scenario composes Policies;
it is neither a new executable policy layer nor a copy of anonymous Rules.

The eight business directories are content safety, privacy and sensitive data,
business topics, specified content filters, attacks and abuse, code and
application injection, business and industry rules, and answer reliability.
Implementation/provider names are not wizard steps. Streaming is a delivery
contract, not a separate protection category. Retrieval, Dialog, and actual tool
authorization remain explicitly outside this release's completion claim.

## Non-negotiable behavior

- Single canonical capability facts: supported direction, actions, dependencies,
  required context, and incremental vs complete-response semantics.
- Scenario baseline protection is explicit and deselectable. Shared Policy IDs
  are deduplicated. Applying a preset never silently overwrites local choices.
- Name is sufficient identity; do not reintroduce Guardrail business purpose.
- Policy order and Rule order are authoritative. Reject terminates the chain;
  redact passes modified content onward; bypass does not globally allow traffic.
- Local overrides and test exclusions belong to the Guardrail, not its source
  Policy. Exclusions are reported with reasons, not used to disguise failures.
- New Policy versions produce a new validated release, not mutation of signed
  artifacts. No silent fallback to unchecked traffic on required-check failure.
- Unconfigured optional capabilities do not make the local baseline unusable.
- The generated Default Guardrail is model-independent. A catalog change that
  introduces a model dependency or an unverified programmable flow is rejected.
  Its PII transformations explicitly request complete-response buffering.
- Financial reference controls describe bounded text checks, not certification,
  statutory compliance, lending fairness, human approval, or tool permissions.
- Business-model responses and documents are untrusted data. Only approved or
  transformed output reaches consumers; downstream agents re-check their input.

## Stages and evidence ledger

| Stage | Deliverable / benefit | Required evidence | Status |
| --- | --- | --- | --- |
| 0 | Freeze baseline and scope | Existing test result, dirty-worktree inventory, runtime version | Complete |
| 1 | Capability and protection-directory contracts | Exhaustive metadata validation; invalid direction/action/dependency tests; cross-language agreement | Shared metadata, direction checks, TS/Python parity, declared dependencies and selected-only manifests verified; arbitrary dynamic-flow completeness remains C1 |
| 2 | Focused Policy Library | Split mixed responsibilities, merge duplicates, positive/negative/edge/CN+EN fixtures and supported-direction tests | Focused library and configurable phrases implemented; 54 current / 15 explicitly legacy collections; Default 32 ordinary Policy bindings verified by 483 deployed checks. Legacy presence is not a claim of automatic draft migration |
| 3 | Common, banking, securities, internet and Singapore presets | Real Policy references; stable expansion/order/deduplication; no-model and missing-parameter tests | Five presets passed real HTTP lifecycle and 599 deployed case replays; UI banking draft saved and verified |
| 4 | Compilation and release lifecycle | UI configuration equals compiled plan; overrides/order survive; signing/distribution/ACK/revision assertions | Core lifecycle verified, including actual saved/reloaded Policy order, signed publication/main routing and 13 real PostgreSQL CAS/ACK race cases. This does not close C1 or unexercised UI paths |
| 5 | Runtime and safe streaming | Frozen artifacts, real execution, transforms, early termination, split payloads, limits and fault recovery | Five signed presets, 599 adapter cases, 272 whole/split Output checks, 18 Redis/TCP lease/handoff cases and baked Relay three-mode replay verified; real three-mode round 11/11 including cancellation/faults |
| 6 | Guided creation, library, health | Full optional stepper, preset preview, tuning and dependency states; desktop browser evidence | Core desktop implementation verified, including permission/catalog recovery and preview versus Apply; consolidated whole-desktop release evidence remains U1 |
| 7 | Deployed fixed-response replay | Real UI/API/database/Controller/Runner/adapter plus controllable upstream; actual final-client bytes and detector calls | Deployed preset/lifecycle and proxy replay completed; expanded tali round compares final bytes and uses real detectors for controlled unsafe streaming. Mock transport/fault evidence remains explicitly separate from semantic quality |
| 8 | Live-model regression and handoff | Actual API calls, per-class quality report, image/artifact/model version evidence and deliberate gaps | Expanded round closed at NVIDIA73/DeepSeek13, Safety48/48 and streaming11/11; recordings and cleanup complete. Independent reviewed corpus/threshold acceptance remains Q1. Topic/JailbreakDetect excluded, not passed |

Stages may share small implementation changes, but no stage is complete merely
because a unit test passes. Tests are added with each feature, not after UI work.
Preserve all pre-existing worktree changes; no commit or external publication is
implied by this implementation task.

## Design contract

Audience: business application owners and platform administrators. Page type:
guided workflow inside the existing product console. Mode: release_gate.
Primary job: choose useful protection without understanding model protocols or
Colang. Desktop uses a stable full protection stepper and focused work area;
mobile support and mobile acceptance are excluded by user instruction. Reuse existing
components/tokens. Per-step states: not enabled, selected, missing parameters,
dependency unavailable; none of these imply runtime validation success.

The final review shows actual Input and Output coverage, ordered execution,
streaming restrictions, unresolved requirements, and test scope. Save draft is
distinct from validate/publish. Missing configuration explains disabled actions.
Browser gates cover default, pending, empty, error, recovery, keyboard focus,
desktop overflow and actual visible feedback. Release UI scoring uses
Intent 20%, IA 20%, Craft 15%, Domain trust 25%, Interaction 15%, Visual 5%;
target >= 8/10 with no blocking correctness/accessibility/path failures.

## Regression layers

1. Control plane: mock external AI, real drafting, composition, validation,
   compilation and publication contracts. Keep `make test-control-plane`.
2. Data plane: precompiled signed fixtures; never compile or invoke Validator.
   Mock upstream transport only when testing adapters/parsers/faults. Keep
   `make test-data-plane` and test-suite boundary checks.
3. Communication/contracts: keep `make test-e2e`, `make test-contracts` and
   `make test`. Current E2E is control-channel convergence, not business E2E.
4. Cluster replay: controllable business-model HTTP/stream responses, real
   production adapter and detectors. Do not mock the safety verdict. All payloads
   are synthetic; no dangerous commands execute and no real data is exfiltrated.
5. Live models: real generation and guard models; record which side refused.
   A business model refusal alone cannot prove Output enforcement.

### Mandatory end-to-end assertions

- Safe input/output is forwarded unchanged unless configured transformation says
  otherwise. Input reject means zero business-model calls. Input redaction means
  the model receives only the transformed request.
- Safe input plus unsafe upstream response proves Output rejection/redaction by
  inspecting what the final consumer actually receives.
- Ordering, local overrides, disabling, repeated preset application and version
  changes match the reviewed configuration, including the artifact checksum.
- No-model baseline produces zero model invocations. Missing/failed required
  detector reports infrastructure error and does not masquerade as a safe verdict.
- Streams test split payloads, start/middle/end violations, bounded buffering,
  cancellation, duplicates, retries, out-of-order chunks and interrupted streams.
  Complete-response checks do not release prefixes; incremental checks do not
  promise to recall already released text or whole-response equivalence.
- Restart and corrupt-generation tests retain last-known-good behavior. Verify
  active revision, routing, authentication and privacy-safe telemetry.
- Deterministic engineering contracts must all pass. Semantic-quality evaluation
  uses a separate holdout corpus; record false positives/negatives by category,
  model/configuration and sample counts. Freeze a reviewed threshold before
  tuning; do not claim 100% attack prevention or certification.

## Baseline (2026-09-06)

- Runtime dependency: `nemoguardrails[tracing]==0.24.0`.
- Existing uncommitted purpose-removal and observability/API changes are present
  and preserved. Root untracked `node_modules/` is not task output.
- `make test` passed before implementation: 401 Vitest tests across 89 files;
  Python contracts 51 passed / 1 skipped, control plane 77 passed, data plane
  143 passed, communication E2E 3 passed. Typecheck, production build, protobuf
  checks and Helm lint/render passed. Existing bundle/dependency warnings remain.

## Foundation verification (2026-09-06)

- Python contracts: 53 passed / 1 skipped. Python control plane: 283 passed,
  including each of the five expanded presets compiled and validated by real
  NeMo with zero external model calls. No generated-test exclusions were used.
- Frontend/control Vitest: 415 passed in 92 files. Data plane: 143 passed.
  Communication E2E: 3 passed. Typecheck and production build passed.
- Composition exposed overlapping early rejects. The authored preset order now
  places specific self-harm/violence checks before generic toxic phrases. The
  prompt-injection collection is split into prompt, SQL and code Policies.
  Independent rule tests and overlapping scenario tests are both retained.
- These results are engineering evidence, not live deployment, semantic attack
  coverage, regulatory compliance or a claim that the complete UI is finished.

## Lifecycle and isolated deployment verification (2026-09-06)

- Complete `make test` passed after native override and Default bootstrap fixes:
  contracts 54 passed / 1 skipped; Python control plane 291 passed; Vitest 452
  passed in 96 files; data plane 143 passed; communication E2E 3 passed;
  typecheck/build/protobuf/Helm/fixture freshness passed.
- Subsequent snapshot/race tests: Vitest 457 passed in 96 files and typecheck
  passed. Five frozen preset fixtures passed freshness checks. Ten independent
  data-plane tests replay 599 reviewed cases through the real LiteLLM callback
  and compare 272 Output cases against two-chunk streaming. All passed, with no
  Controller/Compiler/Validator in the data-plane tests.
- Native catalog Rule action overrides now affect the executable; local PII
  pass/redact/reject and continued later-Policy evaluation have real NeMo tests.
- Company Policy required topic configuration is visible in its own wizard step,
  with a blocking explanation until filled; verified in the preview browser.
- Default bootstrap now runs actual inherited validation before compiling.
  Failures remain visible, do not auto-retry forever, and retain a previous active
  version. An isolated real Runner passed all 140 Default tests and activated
  validated draft revision 7. Normalized comparison prevents spurious revisions
  on restart. This is the existing broad baseline, not yet the focused migration.
- Publish compares the current executable wire contract/runtime profile with the
  durable request actually validated. Artifact acceptance checks executable plan
  equality and a passed validation. Guardrail row locking prevents a late older
  compile from overriding a newer publish/rollback; the artifact remains ready
  for an explicit later selection.

### Real HTTP lifecycle replay

`scripts/regress_protection_lifecycle.mjs` ran twice successfully on isolated
127.0.0.1 Controller 8093 / Runner 8094 / tmpfs PostgreSQL 55439. It creates only
named regression Guardrails, never edits Default or existing user drafts. Both
runs used the five real presets, zero exclusions and zero model invocations.
The second run includes the validated-snapshot and late-result protections.

| Preset | Policy count | Cases | Second published version | Applied generation |
| --- | ---: | ---: | --- | ---: |
| Common baseline | 16 | 91 | 20260906-035835.873Z | 8 |
| Banking | 17 | 103 | 20260906-035855.423Z | 9 |
| Securities | 18 | 115 | 20260906-035919.687Z | 10 |
| Internet support | 20 | 151 | 20260906-035948.755Z | 11 |
| Singapore finance | 20 | 139 | 20260906-040037.466Z | 12 |

The script checks exact saved Policy order/version/overrides, passed validation,
compiled Policy order, signature/checksum presence, active revision, Runner
verified/prewarmed generation, and actual deployed Input/Output verdicts.
It does not claim to cover final business-proxy bytes or live-model quality.

Run against explicitly isolated servers with environment variables:
`GUARD_REGRESSION_ALLOW_WRITES=1`, `GUARD_REGRESSION_CONTROLLER_URL`,
`GUARD_REGRESSION_RUNNER_URL`, `GUARD_REGRESSION_ORIGIN`,
`GUARD_REGRESSION_EMAIL`, `GUARD_REGRESSION_PASSWORD`,
`GUARD_REGRESSION_RUNNER_TOKEN`, and optional `GUARD_REGRESSION_RUN_ID`.
Then run `node scripts/regress_protection_lifecycle.mjs`. Reusing the same run ID
resumes its named drafts without modifying another draft or hiding failures.

### Initial business proxy replay — two real streaming failures

`scripts/regress_business_proxy.mjs` starts an ephemeral real Relay/LiteLLM
container and an HTTP business-model stub, registering a fresh isolated
Integration/Deployment against an already published regression Guardrail.
It exercises the proxy's own pre/post-call handling and checks actual client
response bytes, including streaming; it never mocks a safety verdict.
Use the same controller/auth environment plus `GUARD_REGRESSION_GUARDRAIL_ID`.
It removes its own temporary container/upstream after the run, retaining the
isolated Integration/Deployment as evidence. No existing cluster resources are
modified. The proxy image used is
`sha256:e2676c00235fb99ec54327f4c2d76c78120a7ce3bb7b042f6bbdfda245212cb9`.

Initial real startup exposed wrong exported LiteLLM configuration: guardrails
must be top-level and Relay's branded hook requires a credential reference with
`credential_info`, not an inline API key. Exported setup and the regression
configuration were corrected to match the actual Relay hook/loader.

With the corrected configuration, all five non-streaming cases passed:
safe forwarding; Input rejection with zero business-model calls; Input PII
redaction before the model; model-generated instruction injection rejection;
model-generated contact PII redaction. The first three also passed for streaming.
The two Output streaming cases failed: the client received the complete injected
instruction before an error event, and received the unredacted email address.
The fixed business HTTP model deliberately produced these payloads; the proxy,
Guard adapter and NeMo execution were real. Failed cases remain strict tests.

Root cause confirmed in the actual image's
`litellm/proxy/guardrails/guardrail_hooks/unified_guardrail/unified_guardrail.py`,
`async_post_call_streaming_iterator_hook`: default sampling is every five chunks;
intermediate chunks are yielded before final validation. Even the checked-chunk
path yields an original copied chunk rather than the transformed one.
`streaming_end_of_stream_only` explicitly yields unchecked chunks; it is not a
safe buffering switch. Merely changing sampling to 1 cannot make complete-response
PII redaction or split-injection checks correct.

The required fix was a TaskLattice-scoped Relay streaming adapter that buffers
before release for complete-response contracts, applies the actual checked or
transformed result, and fails closed on errors/limits. At this initial stage,
cross-repository authorization was pending and no Relay source or running user
cluster was modified. The user subsequently authorized changes specifically to
Relay's TaskLattice Guard Provider; the results below supersede that blocker.

### TaskLattice Relay stream fix and replay (2026-09-06)

- Added a concrete TaskLattice-only streaming hook, using Guard's authenticated
  ordered `/guardrails/output-stream` endpoint with native LiteLLM metadata.
  Runner accepts `protocol=litellm` only on the matching Integration adapter.
  Only approved `released_text` is emitted; raw/logprob/provider-specific content
  cannot bypass the checked response. Other LiteLLM Providers are unchanged.
- Stream callbacks pin sequence, release, model revision and delivery mode.
  Full-response checks withhold every prefix. Limits, idle/callback timeouts,
  cancellation and upstream closure are explicit. Protected streaming fails
  closed; an explicit fail-open configuration is rejected rather than silently
  forwarding unchecked text. Non-streaming policy settings are unchanged.
- A new fault replay exposed a third defect: LiteLLM synthesizes `stop` on an
  unfinished upstream. Its Router fallback wrapper does not maintain inherited
  finish fields, so simply checking that wrapper also rejects valid streams.
  The TaskLattice helper verifies the active inner source while the terminal
  frame is yielded. This is a narrowly version-pinned integration with the
  Router generator, not a global Router patch; unknown layouts fail closed.
- The image build runs 17 adapter tests against actual LiteLLM 1.87, including
  real CustomStreamWrapper/Router normal, synthetic-EOF and fallback paths,
  checked transformations, invalid acknowledgements, pinned-version changes,
  limits, cancellation, cleanup and privacy-safe Guard logging. These tests mock
  Guard HTTP and are explicitly separate from the deployed replay below.

Final deployed replay: **15/15 passed** against real Controller/Runner/NeMo and a
real Relay proxy. Only the business-model HTTP/SSE response was fixed. The five
non-streaming cases and ten streaming cases cover safe forwarding, zero upstream
calls after Input rejection, Input/Output PII redaction, model-output instruction
injection, long buffers, early/late attacks, cross-buffer PII, and upstream
interruption. Policy-block cases must have a Policy rejection, not a 5xx; the
broken upstream correctly returned 502 with zero client content. Successful
full-buffered streams released text only after upstream completion. This proves
the tested complete-response path, not live-model quality or all incremental
model-backed streaming configurations.

Evidence identifiers:

- Regression proxy image:
  `sha256:2b942a5661d9fa46561aa65562f6f12686a521f79794eab3cce03e714fcbbdfb`.
- Guardrail `ed3eee48-25b0-4bbd-abb9-00ec2a89da53`, banking preset version
  `20260906-035855.423Z`.
- Isolated Integration `ed103de9-c885-483d-bf92-d1b598a00001`, Deployment
  `ba876e22-d86d-4a87-96ea-3b1ca6b071d8`.

Build the regression image using `tests/fixtures/business-replay/Dockerfile` from
this repository and the sibling Relay repository as Docker's build context.
Set `GUARD_REGRESSION_PROXY_IMAGE` when running the replay script. This layered
image updates the Provider runtime, not Relay's dashboard; runtime schema and
credential-reference verification passed. Full dashboard/source verification
does not pass against that pre-existing base UI and is not claimed here. A full
Relay image build/UI release gate remains necessary before deployment.

Fresh `make test` passed: contracts 54 passed / 1 skipped; Python control plane
291 passed; Controller/UI Vitest 457 passed in 96 files; data plane 155 passed;
communication E2E 3 passed; fixture/protobuf/Helm checks, typecheck and production
build passed. Existing NeMo deprecation and frontend bundle-size warnings remain.
The user's cluster and dev image tag were not changed. Replay proxy containers
and upstreams were cleaned up; isolated Integration/Deployment evidence remains.

### Published-health evidence and failure recovery (2026-09-06)

Health now derives its coverage and model dependencies from the active artifact,
not the mutable draft or the Default name. It resolves the ready release and
artifact ownership/version/signing metadata, requires an enabled catch-all route
and at least one configured check, and exposes Input/Output check counts and
executing Policy count. Unknown custom-flow dependencies remain explicitly
unknown; arbitrary programmable actions are never presumed model-free.

Serving capacity requires a fresh heartbeat and the current applied generation,
even before the offline sweeper changes a persisted `ready` row. Stale and
old-generation instances cannot increase serving capacity. Required model
bindings are matched by actual Input/Output binding ID against the activated
model configuration. Optional absent models do not break a model-free release.
Model assignments now say **Configured**, not **Ready**: Health does not issue a
live inference probe. A failed newer draft is shown separately and cannot change
the coverage or readiness evidence of an already published release.

Verification:

- Full Controller/UI suite: **485 tests in 98 files passed**, with typecheck and
  production UI/server build. Three subsequent edge-case tests cover custom
  flows represented by local product steps and stale saturation/error pressure;
  the final focused suite passed **48 tests in 6 files**, plus fresh typecheck.
- Real isolated HTTP snapshot: Default version `20260906-034004.633Z`, source
  draft revision 7, generation 34, **18 executing Policies / 18 Input checks /
  16 Output checks**, no model dependency, one serving Runner. These are plan
  check counts, not a claim of detector accuracy or individual Rule counts.
- Actual fault test paused only the isolated preview Runner on port 8094. After
  heartbeat expiry, `/api/v1/system/status` returned **503**, basic protection
  `unavailable`, serving count **0**; the rendered page turned red with the same
  evidence. The bounded test resumed the Runner in a cleanup handler, verified
  **200 / ready / 1 serving**, and the browser confirmed recovery. The user's
  cluster and deployment/model configuration were not changed.
- Fresh desktop (1440 × 1000) and narrow (390 × 844) browser observations and
  screenshots are in the task evidence. DOM checks found no page-wide horizontal
  overflow; Health refresh and all three local navigation actions have 44 px
  targets. Refresh, Default inspection, mobile navigation dismissal and runtime
  failure/recovery were exercised. No browser warnings/errors were captured.

Focused Health evaluation (release-gate scope, not the whole wizard/product):

| Dimension | Subcheck evidence (0–2) | Score |
| --- | --- | --- |
| Intent | Availability 2; published scope 2 | 10 |
| Information architecture | Stable primary status 2; separated configuration/draft evidence 2 | 10 |
| Craft | Existing primitives 2; wrapping/targets 2; full-page capture legibility 1 (viewport captures used for detailed review) | 8.33 |
| Domain trust | Artifact scope 2; heartbeat/generation 2; model status semantics 2; custom dependency introspection 1 (explicitly unknown) | 8.75 |
| Interaction | Refresh 2; real Runner failure/recovery 2; navigation/mobile 2; other error states 1 (component/HTTP tests, not all live provider states) | 8.75 |
| Visual fit | Existing product typography 2; consistent layout/tokens 2 | 10 |

Weighted score **9.25/10**, above the frozen 8/10 threshold; no blocker in the
verified Health path. Decision: **pass** for this focused change. No earlier
numeric baseline was recorded, so no numeric improvement is claimed. Canonical
custom dependency introspection and the full product UI/live-model release gates
remain separate unfinished work, not hidden behind this score.

### Extended identifier families and Default delivery contract (2026-09-06)

The source inventory exposed a migration gap: replacing Pattern Matching with
the small contact/passport starter Policies would drop government IDs, regional
phone/address formats and other disclosure checks. Added nine ordinary versioned
Policies for government/institutional identifiers, international passport
formats, regional contacts, regional bank accounts, travel identifiers, network
addresses, sensitive-attribute terms, risk-related terms, and Australian tax/health
identifiers. Each declares Input and Output, local execution, complete-response
delivery and explicit limits. Broad numeric, public URL and demographic-word
filters are opt-in; they do not silently join banking/securities/internet presets.

All original matching/action definitions are retained in the source collections.
The extended families consolidate four subsumed passport formats, retaining every
original acceptance input against its complete-value detector. Contextual TFN and
institutional-ID checks precede broader numeric patterns. A Brazilian overlap
sample still executes, plus a distinct landline-only acceptance case. Tests assert
source-rule equivalence, exhaustive ownership (including reviewed aliases), source
case preservation in both directions and exact whole-field redaction. They do not
merely accept any transform or discard conflicting cases.

Default's generated configuration now explicitly requests `full_buffered`, the
mode that its local PII rules already required at runtime. Its catalog construction
rejects external-model dependencies and unverified custom flows. The signed frozen
Default fixture was regenerated; no source Policy, user Guardrail configuration or
deployed user cluster was rewritten by this change. Default's 18-Policy composition
has **not yet** been switched to the new families: the complete ordered composition
and reviewed local expectations still need migration and regression.

“Check before release” is the timing guarantee, not a promise of incremental
generation. Incremental checks may release previously checked prefixes; later
context cannot recall them. Complete-response checks withhold all body text until
the full response is checked/transformed. A streaming request using Default can
therefore have streaming transport without incremental body delivery. Model-free
does not imply chunk-safe.

Focused verification: 407 focused-library/contract tests, 290 Controller server
tests and typecheck passed. The expanded control-plane regression compiles and
validates each of the nine new single-Policy drafts through the actual
TS/protobuf/Python/NeMo path, alongside the five unchanged industry presets.
Four new data-plane cases read the frozen Default artifact and feed single-character
chunks through real NeMo evaluation, checking zero premature release and zero
model calls. The expanded composition and streaming files passed 29 tests.

Final fresh `make test` passed: Python contracts **54 passed / 1 skipped**,
control plane **503 passed**, data plane **159 passed**, communication E2E
**3 passed**, Controller/UI **491 tests in 98 files passed**; deterministic
fixture/protobuf checks, Helm lint/render, typecheck and production build passed.
Existing NeMo deprecation, Node local-storage and frontend bundle-size warnings
remain. `git diff --check` passed. This proves the checked-in runtime/contract
paths, not a new deployed 1:1 replay, new browser release gate or live-model
quality evaluation.

### Focused Default migration and deployed control-channel recovery (2026-09-06)

Default now binds 32 ordinary focused/local Policies instead of the previous 18
Policy composition. It inherits all 321 cases without exclusions or Rule action
changes; 62 explicit Guardrail-local expectations document ordered overlap.
The original mixed catalog collections and their source Rules remain unchanged.
Credential rejection now applies to both Input and Output. The old composition's
140 frozen synthetic inputs still pass, with complete redaction comparisons and
only the reviewed generic credit-card marker normalization.

Real NeMo testing exposed the Colang 1 300-event guard with many independent
top-level rails. Compiler `tasklattice-nemo-config-v15-ordered-standard-rails`
uses one ordered entry flow per direction, invoking individually named Policy
subflows. It retains Policy identity, Rule order, redaction chaining and early
termination without changing NeMo's limit. Actual 40-step Input/Output tests and
all nine refreshed signed fixtures passed.

The isolated deployed run then exposed gRPC's default 4 MiB receive limit: the
complete validation result was approximately 5.6 MB. Both endpoints now use a
finite symmetric 32 MiB budget. The Runner owns/cancels its sending task so that
closed RPCs do not leave an iterator blocked on a stale queue. New real-socket
tests verify large messages in both directions, unmodified 321-case evidence,
oversized receive rejection, and cleanup on graceful/error reconnects. Messages
above 32 MiB are not supported by this change; segmented transfer and the broader
oversize-job recovery matrix are not claimed complete.

The existing durable validation task
`validation-d869d637-3c8b-4c4c-9dee-abf4b4b71c46` retried successfully with **321/321**
passing results. No replacement validation request was created. Default draft 9
published as `20260906-061551.290Z`, artifact
`218e466e-526d-4a78-a1d3-ad7343f51532`, signed checksum
`9eec9680f8f3bc77fe628fbd0629f9672df8ea0d43e920f3a09dd6bf560a3f5c`.
After restarting the isolated Runner with the corrected client, generation 36
was ready, connected and synchronized with all active versions prewarmed.

`scripts/regress_default_runtime.mjs` then passed **483 deployed checks**: 321
inherited cases, 140 frozen old inputs and 22 explicit benign/redaction/credential
checks. All calls used the same active version and runtime config checksum
`121b2b9ec515a40d2332d2dd2248ed30e4188cd5f3c7b27b109e7c60bab6e866`, with zero model
calls and no fail-closed infrastructure errors. 123 cases asserted exact output;
benign samples asserted the complete ordered Policy trace in both directions.
This is actual artifact execution, not yet final-proxy/streaming evidence.

Fresh `make test` passed: contracts **55 passed / 1 skipped**, Python control
plane **510 passed**, data plane **161 passed**, communication **4 passed**,
Controller/UI **495 tests in 99 files passed**, plus typecheck/build/protobuf/
fixture/Helm checks. A subsequent communication test adds the server-abort
variant of the large-result cleanup test. No user cluster, dev image tag,
source credentials, source Policy Rules, or Git history were modified.

### Concurrent publication deadlock and full Relay image (2026-09-06)

Concurrent deployed preset publication and Default proxy replay exposed a real
Runner deadlock, not a network or policy rejection. The native process sample
showed the event-loop thread blocked acquiring an RLock. Source inspection and
two deterministic tests reproduced the inverse acquisition order: publication
held the ArtifactStore lock and waited for Registry, while readiness/admission
held Registry and waited for ArtifactStore. Both new tests failed against the
old implementation and passed after the fix.

Desired-state writers now serialize with a dedicated apply lock. Materialized
release instances are published before the store atomically exposes their routing
identity; no Registry call is made under the store reader lock. Existing calls
retain their prior release. The blocked isolated Runner was stopped after this
diagnosis, restored its saved state and converged to generation 41. No user
cluster process was restarted. The initial proxy replay failed on infrastructure
timeouts and is not counted as passing security evidence.

The complete Relay Dockerfile (not the earlier runtime-only test image) built
successfully, including overlay verification, 17 Provider tests, Next.js build,
static routes and non-root Prisma generation. Local regression image:
`tali-litellm:protection-productization-20260906`, digest
`sha256:a67344ef5ab3993a9e8b07b2691578a40365639b12add3299c161f7924d0007b`.
The user's `:dev` tag was not changed. Upstream dashboard npm audit reports 16
dependency advisories (2 low, 1 moderate, 10 high, 3 critical); this build does
not resolve or assess their exploitability. Broad Relay dependency changes are
outside the authorized TaskLattice Provider scope.

After the deadlock fix, the complete image passed the actual Default proxy suite:
**5 non-stream + 10 stream cases**, including zero upstream calls for Input
rejection, exact complete input/output email redaction, fixed upstream injection
at both early and late positions, boundary-split PII, full-buffered release timing,
and interrupted upstream returning infrastructure error with zero body disclosure.
The active Default artifact remained `218e466e-526d-4a78-a1d3-ad7343f51532`.
Only the business-model response is synthetic; these results do not establish
semantic detection quality for unseen attacks or live guard-model accuracy.

### Policy-owned configurable phrases (2026-09-06)

Removed the anonymous Guardrail-root `customContentRules` editing/API path.
Previously those rules were attached to the last local Policy, making ownership
depend on unrelated Policy order and leaving model-only drafts with no owner.
`configured-phrase-filter@1.0.0` is now an ordinary Policy with one configurable
Rule, `configured/phrases`. Its `phrase_entries` parameter is edited structurally
inside the normal Policy binding, without exposing JSON. It can be the only
Policy or coexist with model-backed Policies. Each entry is a literal phrase
and action, not a separate unversioned library Rule.

Entries execute in their configured order. Replacement continues with modified
text; rejection terminates. Existing Rule skip and action override apply to the
entire sequence. Default UI text is **Phrase actions**, not a misleading fixed
`reject`. Required-entry validation is shared by creation and draft editing;
clearing a phrase blocks Next/Save and explains the missing field. Adding,
removing and reordering entries preserves their stable IDs. Both directions are
supported; output requires complete-response buffering. No external model is
called. Arbitrary regex authoring is not part of this literal-phrase editor.

Each configured entry expands into an inherited acceptance test in every
selected direction, retaining the source Policy/version/Rule identity. Expected
actions come from the declared entry, not actual runtime results. Literal
`{{phrase_entries}}` remains literal in the test input. Ordered overlaps can
still fail acceptance and must be explicitly reviewed; no exclusions or
runtime-derived passing expectations were introduced.

This is intentionally breaking: the new HTTP schema rejects the old root field,
and a stored nonempty legacy root configuration raises a migration-required
error instead of silently losing protections. No automatic migration of those
old drafts is claimed. The old runtime helper remains for previously frozen
artifacts; new plans never emit `custom_rules_json`. Both regression scripts
were updated to stop sending the removed root field.

Real browser creation saved only the new Policy, followed by real validation,
compilation, signing and Runner distribution in the isolated preview stack:

- Guardrail `26cff9fe-de31-4c1a-8646-e2c1af379fe2`, draft revision 1.
- Validation `validation-3eb8419d-92da-4e70-b8bd-33ff12a1d508`: **4/4**, no exclusions,
  no external model calls.
- Version `20260906-074639.426Z`, artifact
  `4a7d8e6f-0d69-403b-82cd-53e1c2341f7a`, signed checksum
  `8b28bd60be64e066083d08e9d4003391d12cd4b8b667796756e47e0b5f182716`.
- Runner acknowledged generation **48**. Six direct deployed Input/Output calls
  to that exact version passed allow, exact `internal-name` → `public-name`
  transformation and confidential-phrase rejection. Findings retained the
  Policy/Rule identity. These direct calls do not prove final-proxy streaming.
- The new frozen signed artifact independently passed real NeMo Input/Output
  execution, Chinese and benign samples, ordered redaction, and a phrase split
  over stream chunks with no early release. It does not compile during the
  data-plane test.

`make test` passed: **55 contracts / 1 skipped**, **523 Python control-plane**,
**501 Controller/UI**, **164 data-plane**, **5 communication**, plus fixture,
protobuf, Helm, typecheck and production build. Subsequent literal-input and
edit-save fixes passed the focused **30 tests in 3 files** and a fresh production
build. Those two additional tests bring the source suite count to 503, but that
whole 503-test suite was not separately rerun. Existing dependency/bundle and
NeMo deprecation warnings remain.

Focused design evaluation: `release_gate`, product-console Policy parameter
editor, iteration 2. Evidence directory:
`/tmp/guard-phrase-ui-evidence.NJd0VR`. Final desktop/mobile screenshots are
`desktop-saved-editor-final.png`, `mobile-saved-editor-final.png` and
`mobile-required-error-final.png`; creation screenshots are also retained.
DOM checks found no horizontal overflow at 1440 or 390 px, no browser page
errors, named controls, and 44×44 entry-action targets. Keyboard Tab reached the
next enabled reorder control with visible focus. Actual create, reorder,
remove, save, reopen, validation and publication paths ran; empty-field failure
and recovery were rechecked after the edit-save fix. Cancel left the saved
configuration unchanged.

| Dimension | Subchecks (0–2 each) and evidence | Score |
| --- | --- | --- |
| Intent | Clear phrase task 2; named Policy ownership 2 | 10 |
| IA | Parameter grouping/order 2; desktop/mobile hierarchy 2; long explanatory copy density 1 | 8.33 |
| Craft | Existing components/tokens 2; entry targets 2; visible keyboard focus 2; cross-browser/contrast audit incomplete 1 | 8.75 |
| Domain trust | Stable source identity 2; entry vs Rule override 2; explicit buffering 2; validation separate from saving 2 | 10 |
| Interaction | Add/remove/reorder 2; empty recovery 2; save/reopen 2; keyboard 2; provider/network failure path not part of this focused run 1 | 9 |
| Visual | Existing product typography 2; restrained parameter grouping 2 | 10 |

With the frozen weights above: **9.33/10**, no blocker in this focused path;
decision **pass** against ≥8. There was no numeric pre-change baseline, so a
numeric delta is not claimed. This does not complete the wider wizard release
gate: legacy edit-page topic fields, real model-dependency health and broader
runtime status wording remain separate work. No user cluster, Relay image,
Default configuration, or Git history was changed by this slice.

### Selected dependencies and truthful failure guidance (2026-09-06)

The creation directory, final review, saved Draft & release view and edit sheet
now share one model-dependency summary. It reads the actual model-configuration
API. Requirements come from canonical Policy metadata, enabled Rules and selected
Input/Output directions, deduplicating shared bindings. Business categories do
not introduce dependencies: local banking/baseline Policies make no model-settings
request, and unselected optional capabilities do not appear. Custom dependencies
without a known contract are explicitly unknown, never called model-free.

The summary distinguishes missing assignment, missing Rail validation, failed
validation, validated-but-not-activated, activation in progress and an active
assignment. A generic model-call probe is not accepted as NeMo Rail evidence.
An active assignment remains visible when a newer configuration draft fails;
unactivated draft choices do not replace active evidence. Report timestamps are
labeled as report timestamps, not per-model probe times or real-time health.
The summary does not claim that an activated assignment proves a validated
Guardrail, current serving convergence, or detector accuracy.

Draft saving remains possible before models are configured. Setup opens in a
separate tab, preserving the in-progress wizard. Failed status reads show unknown
with retry rather than stale success or invented missing bindings. Read/retry
does not trigger provider/model validation or external inference.

Also fixed two downstream information losses:

- Metrics retain the platform's actual reason codes. The runtime alert now says
  **Platform needs attention** and reports capacity/convergence causes instead
  of claiming every degraded status means a missing capability. Existing
  fail-closed, latency and integration anomaly priorities remain unchanged.
- Validation mapping preserves the Controller's failure reason. The release
  workflow displays that reason and provides the Validation Run link on failure.
  It no longer generically recommends excluding tests after a configuration
  failure or frames a job that never executed as a detector-quality score.

Real isolated browser evidence is in `/tmp/guard-dependency-ui.vxECIH`:
`desktop-missing.png`, `mobile-review.png`, `mobile-read-error.png`,
`mobile-edit-dependencies.png`, `runtime-platform-reasons.png` and
`validation-failure-final.png`. At 1440 and 390 px there was no horizontal
overflow or page error. The configuration link is 44 px high; its new-tab
navigation preserved the open wizard. Unchecking Responses immediately removed
only the Output dependency. A browser-only injected HTTP 503 exercised unknown
and Retry states; removing that interception restored real API reads without
losing selection. No server/provider state was changed by the injected fault.

Browser-created Guardrail `b766e0b4-fa7a-4d1b-9418-ae677b7b1849` retained draft
revision 1, only `builtin-content-safety` Input, and no active version. Actual
Validation Run `validation-d6184eb8-34e1-4af1-a3d9-4c5b127d5b5a` failed with
`No Evaluator Binding is available for: content_safety -> tali.guard.content-safety.v1.`
It recorded no executed cases and did not expose Publish. This is the expected
negative regression, not a successful detection test. Real platform status was
degraded solely for `runner_capacity_below_desired`; the runtime page displayed
exactly that cause. No Default or model configuration was changed.

Final full Controller/UI run: **517 tests in 102 files passed**, plus fresh UI
and server production builds/typecheck. One additional mapping test was added
after that run and verified separately. The first run of the new loading test
timed out because its test hook returned the mock function; the hook was fixed
to return void, and subsequent full runs passed. Python/Relay/runtime code did
not change in this slice, so their previous evidence is retained, not claimed
as freshly rerun. Live activated/activating-model branches are unit-tested with
explicit snapshots, not represented as new live-provider health evidence.

Focused `release_gate` evaluation, iteration 1, same frozen weights and ≥8 gate:
Intent (selected task 2, draft/serving distinction 2) 10; IA (direction grouping 2,
responsive layout 2, repeated explanatory copy 1) 8.33; Craft (existing components
2, touch/link sizes 2, broader contrast/browser audit 1) 8.33; Domain trust
(assignment/validation separation 2, actual failure reasons 2, unknown/stale
states 2) 10; Interaction (draft/setup path 2, read-error recovery 2, live activation
branch not exercised 1) 8.33; Visual (existing typography 2, restrained hierarchy
2) 10. Weighted **9.17/10**, decision **pass** for this focused read-only guidance,
no focused blocker. No numeric baseline delta is claimed. The whole wizard and
full live-model lifecycle are still subject to their broader outstanding gates.

### Streaming cancellation and idle-expiry regression (2026-09-06)

The preceding implementation turn was progress (dependency guidance and truthful
validation failures). This slice extends the remaining streaming fault matrix;
it does not redefine the full product goal around the existing passing baseline.

A deterministic new test reproduced an in-memory session race: a slow evaluator
crossing the idle TTL could be removed by another request's pruning, allowing a
duplicate sequence to evaluate in a second session. Before the fix the test saw
`["once", "once"]` instead of one evaluation. Session acquisition now pins both
the evaluator and queued callers, and expiry skips pinned sessions. Cancellation
releases that pin, including cancellation while waiting for the session lock.
Capacity cannot be reclaimed by discarding an in-flight check; expired idle
sessions remain reclaimable. This changes no NeMo flow, Policy order, decision
aggregation, or published artifact.

New cancellation tests run all three delivery modes against memory and the
existing fake-Redis serialization adapter. After an initial successful chunk,
cancelling the next evaluation and retrying the same sequence preserves context,
does not duplicate text, and does not re-release an already approved prefix.
These are state-machine/cancellation tests, **not real Redis lock/lease tests or
model-accuracy evidence**. The focused streaming suite passes **23 tests**.
The final fresh data-plane suite passes **172 tests** (584 other-plane tests
deselected); only existing upstream NeMo deprecation warnings remain. Script
syntax validation and `git diff --check` also pass. No fresh Controller/UI suite
is claimed in this runtime-only slice.

`scripts/regress_business_proxy.mjs` now also aborts a real client request while
the upstream model is still generating and full-buffered output has not been
released. It observes the upstream HTTP socket, rather than mistaking a local
AbortError for proof of upstream cancellation. It requires zero client bytes,
closure before generation finishes, and closure within a bounded 3-second wait.

Fresh runs through the existing full Relay/LiteLLM image
`sha256:a67344ef5ab3993a9e8b07b2691578a40365639b12add3299c161f7924d0007b`
and isolated Runner passed **16/16 each**:

- Default version `20260906-061551.290Z`, artifact
  `218e466e-526d-4a78-a1d3-ad7343f51532`; cancellation closed the upstream socket
  after **2606 ms**, 102 of 200 planned chunks sent, **0 client bytes**.
  Regression Integration `2061a514-41c8-4968-8b44-f811ca44fe0c`, Deployment
  `67968076-c044-4e54-b6a8-3c289c3eaae2`.
- Banking version `20260906-035855.423Z`, artifact
  `ff8759ac-968a-470b-9e43-22cc07d54d65`; cancellation closed after **2635 ms**,
  103 of 200 planned chunks sent, **0 client bytes**.
  Regression Integration `d88f68e1-f00a-4ff2-b0d2-96f7ad00f7d1`, Deployment
  `cdd89d57-1742-4e84-837d-aa011ef6b44e`.

The roughly 2.6-second cancellation is measured, not described as instantaneous;
upstream work continues during that interval. Existing exact redaction, zero
upstream calls on Input rejection, early/late Output injection rejection,
cross-boundary PII, full-buffered timing and broken-upstream tests all passed
again. Only the business-model response is controlled. Runner/NeMo verdicts and
the proxy HTTP client path are real; this is not a live semantic-model benchmark.

Both published artifacts and their draft revisions stayed unchanged. Temporary
proxy containers were removed by the replay's cleanup; regression records remain
in the isolated preview database. No user cluster, provider credential or Git
history was changed. The preview Runner was not restarted for the idle-expiry
source change: its concurrency fix is freshly source-tested, not claimed to have
been deployed by these proxy runs. Real Redis lease expiry, the broader deployed
incremental matrix and live-model evaluation remain separate verification work.

### Real Redis stream lease fencing (2026-09-06)

The previous turn made concrete progress in in-memory expiry and actual proxy
cancellation. The corresponding distributed path now has separate real-Redis
evidence, rather than relying on the fake serialization adapter.

An isolated Redis 7.4 service and two independent Runner store instances
reproduced a stale-writer defect. While an evaluator was suspended, its real
Redis lock was forced to expire. A second replica completed and committed its
result. On resuming, the old replica overwrote that state, then raised a lock
release error. The pre-fix regression failed because committed `new owner` text
became `old owner`; merely raising on unlock did not protect stored stream state.

Stream commits now compare the current lock token and write state/idle TTL in one
Redis Lua operation. If ownership was lost, no state is written and no released
text is returned. Lock-release failure no longer masks this explicit stale-lease
failure; Redis's token-aware release still cannot unlock a replacement owner.
The same fenced commit is used when recording a maximum-size terminal state.
There is no separate check-then-write race, no unbounded lock renewal and no
change to NeMo's Policy/Rule order or detector verdicts. Operations require Redis
`EVAL` permission; an evaluation exceeding the existing 120-second lease fails
closed rather than being relabeled as a Policy match.

Six real-Redis tests cover stale-owner overwrite prevention, replacement-lock
preservation, cancellation with retry on another replica, and exact checked
output/sequence/TTL handoff in all three delivery modes. They use controlled
detector responses and actual Redis locking/expiry/commit commands. They are
distributed state-machine evidence, not a semantic-model benchmark, Redis
Cluster claim, or a new deployed HTTP/NeMo run.

Fresh verification with `GUARD_TEST_REDIS_URL=redis://127.0.0.1:56389/0`:
**178 data-plane tests passed**, no Redis skips; **55 contract tests passed,
1 existing skip**. The CI data-plane matrix now provisions Redis and sets that
variable on Python 3.11/3.12/3.13 so these tests execute there. YAML parsing and
`git diff --check` passed locally; remote CI and other Python versions were not
run in this slice. Local runs without Redis explicitly skip these six tests and
continue to run the fake/in-memory state-machine suite. `docs/testing.md` records
the invocation, scope, cleanup and scripting-permission requirement.

Only a newly created loopback test Redis was used, never the user's cluster
Redis. Tests delete their exact random stream/lock keys, not `FLUSHDB`; the
temporary service is removed after verification. Published Guardrails, Default,
provider configuration, Relay code and the user cluster were not changed.

### Focused Policy recommendations and untrusted catalog metadata (2026-09-06)

The preceding Redis turn made concrete implementation/test progress. This slice
returns to the creation lifecycle: document-based recommendations previously
received every Policy, including the retired mixed collections hidden from the
focused protection map. A new recommendation projection excludes those declared
legacy collections and unpublished custom Policies before requesting analysis.
It does not delete the source library or replace existing Guardrail bindings.

The model receives canonical protection directory, supported directions,
execution class, model dependencies, required context and limitations, instead
of guessing protection coverage from a name/description alone. Published custom
Policies without canonical metadata remain explicitly unknown, not model-free;
their full published-vs-draft metadata agreement is still part of the separate
custom-Policy lifecycle gap.

Names/descriptions of custom Policies previously entered the system prompt via
string concatenation. The catalog now travels as structured, untrusted JSON in
the user message alongside the document evidence. Static system instructions
require cited requirements, only current catalog IDs, no invented readiness or
regulatory compliance, and no unrelated optional protections. Both the concrete
analyzer and the HTTP boundary reject out-of-catalog recommendations; alternate
analyzer implementations cannot bypass the route's eligibility check. No silent
legacy-to-focused expansion or automatic draft mutation was introduced.

Tests load the real canonical Policy catalog to verify retired exclusions,
focused email coverage, dependency metadata and unknown custom dependencies.
Controlled model-response tests check that a malicious Policy description is
absent from the system message and that retired/invented IDs are rejected.
HTTP tests check accepted focused recommendations and rejected legacy/unknown
IDs. These tests establish transport/schema/allowlist boundaries, **not proof
that a real model resists every semantic prompt injection**.

The vibe-designing domain/evaluator declarations guided the distinction between
classification, readiness and unknown dependencies. Scope is a backend-only
recommendation-boundary repair: no page layout or visual assets changed. The
broader product-console `release_gate` decision remains **revise** pending fresh
end-to-end rendered document-apply/recovery evidence and the outstanding custom
Policy contracts; no fabricated visual score or new whole-UI pass is claimed.
Existing creation still requires explicit Apply before changing selections.

Fresh verification: **527 Controller/UI tests in 103 files passed**, typecheck,
UI/server production builds and `git diff --check` passed. The first focused run
caught an incorrectly guessed email Policy ID in the test; the assertion now
locates the canonical focused Policy by its actual email Rule. No live authoring
model was called, and no user cluster, published Default, provider credentials
or Git history was changed. Data-plane tests were not rerun in this backend-only
slice; their preceding real-Redis evidence remains separate.

### Published custom Policy catalog surface (2026-09-06)

The prior focused-recommendation turn made implementation/test progress. Follow-up
inspection found that custom catalog entries advertised the highest published
version while constructing their Rules, parameters, acceptance tests, directions
and delivery metadata from the **unpublished draft**. Recommendation filtering
alone could not correct that mismatch.

`programmablePolicyPayload` now selects the newest numeric published snapshot
independently of database row order and derives the selectable surface from it:
name, description, owner, published timestamp, Rails, Rule actions, parameters,
tests, category/Colang tags and delivery preference. No published versions means
the existing editable version-0 draft surface remains, still excluded from model
recommendations. The editor's `implementation_detail` intentionally retains the
current draft and draft metadata; its published snapshots are unchanged. Source
inspection confirms Policy Library Edit reads that detail, not the selectable
Rule surface. No migration or automatic change to a Guardrail binding occurs.

Four focused regression tests cover post-publication draft edits, numeric
version selection (10 vs 2) without mutating snapshots, unpublished draft
editability/selection exclusion, and recommendations using only published
coverage/directions while unknown custom dependencies remain unknown. This is a
Controller projection repair, not a new real-NeMo custom publish/execute run.

A further distinct issue is recorded rather than hidden by this fix: the current
binding editor looks up Policies by ID alone. An existing Guardrail pinned to an
**older** custom Policy version may therefore display the newest published Rule
surface. Runtime resolution already uses `policyId@policyVersion`; the editing
surface still needs equivalent pinned-version resolution. New selection now
matches its advertised version, but full custom lifecycle agreement is not yet
claimed.

Fresh checks: **531 Controller/UI tests in 104 files passed**, typecheck and both
production builds passed, `git diff --check` passed. Existing localStorage and
large-bundle warnings remain. No fresh browser, external model or data-plane
regression is claimed for this pure Controller projection change. No user
cluster, published Default, saved Policy record or Git history was modified.

### Pinned custom Policy metadata and inspection (2026-09-06)

The previous published-surface repair was implementation progress; this slice
fixes its separately recorded older-version binding gap. Custom catalog entries
now include immutable `published_versions` metadata surfaces without recursively
embedding editor state or duplicating raw source files. A shared exact
`policy_id@policy_version` resolver drives bound Rule editing, required-parameter
checks, direction/dependency and complete-response requirements, order labels,
and Guardrail bound-Policy details. New selections still choose the current
published catalog version. Existing bindings are not upgraded automatically.

An unavailable pinned version now blocks draft advancement/save and is visibly
removable in the binding editor; it never silently substitutes the newest Rules.
The Policy Library deep link retains the bound version and opens its read-only
inspector. Missing versions produce an above-results alert with recovery. Numeric
custom version query values are normalized after TanStack's JSON URL parser;
bare `version=1` remains version 1 rather than becoming an unversioned link.
Catalog-level editing still opens the editable draft outside a pinned inspector.

Verification: **539 Controller/UI tests in 106 files passed**, typecheck, UI/server
production builds and `git diff --check` passed. Added coverage includes exact
version/identity resolution, pinned Output requirements and required parameters,
missing-version removal, published snapshot projection, numeric version URLs,
and old/missing version inspectors. Existing localStorage and bundle-size
warnings remain. No new Python/data-plane or live-model result is claimed.

Fresh browser evidence: `/tmp/guard-pinned-policy-ui.ccaPkH/` contains settled
desktop (1440x1000) and mobile (390x844) inspector screenshots and mobile
missing-version recovery. Both widths had no document horizontal overflow;
Escape and Close cleared the inspector/query, missing-version Close recovered,
and no page errors occurred. The 44px inspector close targets were measured.
These checks used browser-only intercepted version fixtures appended to the
isolated preview's real catalog, not newly published custom Policy database
records. They therefore prove rendering/navigation but not a new real-NeMo
custom publish/execute lifecycle. The temporary browser was closed. No user
cluster, saved Policy, published Default, credentials or Git history changed.

Focused UI evaluation, same release-gate weights and threshold, iteration 1:
Intent (clear pinned inspection 2, real custom lifecycle evidence 1) 7.5;
IA (version-preserving route 2, first-screen mobile error recovery 2) 10;
Craft (existing inspector/alert primitives 2, full accessibility audit 1) 7.5;
Trust (exact-version and no-substitution behavior 2, persisted custom integration
evidence 1) 7.5; Interaction (desktop/mobile close and error recovery 2, full
persisted edit/publish path 1) 7.5; Visual (existing typography 2, readable settled
screenshots 2) 10. Weighted **8.125/10**; no baseline delta is claimed. Decision
**revise**, despite exceeding 8: the release gate still lacks a real persisted
custom old-version edit/publish/execute path, and the complete wizard gate is
not replaced by these browser fixtures. Next verification: create/publish two
custom Policy versions in the isolated stack, retain a version-1 Guardrail,
edit/validate/release it, and compare its actual artifact behavior with the
version-1 inspector and metadata (domain/evaluator declarations).

### Real pinned custom lifecycle and selector consistency (2026-09-06)

The preceding goal turn made version-resolution and test progress. This turn
replaced its synthetic-only acceptance gap with persisted isolated HTTP/NeMo
evidence and fixed one further UI mismatch discovered by that regression.

New opt-in script `scripts/regress_pinned_policy.mjs` creates one custom Policy
with real Colang 2 Input/Output flows, validates/publishes v1, binds a Guardrail
to v1, then validates/publishes behaviorally different v2. V1 transforms the
legacy marker to `[version-1]` and allows the current marker; v2 instead rejects
the current marker and allows the legacy marker. After v2 publication, a
Guardrail draft edit, inherited tests, source/checksum projection, signed
compilation, distribution and four actual Runner calls all retained v1.
Both Policy validations and Guardrail validation executed successfully, with
zero external model calls and no test exclusions. These are deterministic
version-boundary samples, not evidence of semantic detection quality.

The initial script run successfully published v1 but correctly received HTTP
422 when its Guardrail binding omitted explicit enabled Rule IDs. The script
was fixed to select both Rules, resumed the unchanged v1 fixture (no duplicate
Policy), and completed. This was a regression-driver issue, not a relaxation of
the product's rule-selection validation. Retained records:

- Policy `policy-02c8e9e2-a77d-434c-9e65-8d3cddd243ea`, versions 1 and 2.
- Policy validation runs `policy-validation-a2e1d7b5-cbbe-460b-aa04-f83546e879f9`
  and `policy-validation-97612234-16c4-457d-81f3-7fa87ea5cd4e`.
- Guardrail `43922a63-b72f-4985-bf69-08aaf07cbf7f`, first validation
  `validation-e60a7da8-249e-49e2-97cb-b80695bcc0f6`, first immutable release
  `20260906-090024.589Z`, artifact `8247207f-6c6f-4c1d-89b2-c6bd9991ca8d`.

The actual browser editor revealed that the selector's selected chip still used
the current catalog name (v2), while the bound card used v1. Selected options now
resolve their pinned metadata too; only a new selection after explicit removal
uses the newest published version. Missing selected versions use their exact
identity, never the latest name. Tests cover the chip and removal/reselection.

The browser then edited `legacy_label` to `reviewed legacy` and saved the real
Guardrail. Database/API readback showed draft revision 3 still bound to v1,
both original Rule IDs and both Rails. A subsequent real validation
`validation-56853e81-c4d9-4d78-bd82-dbe613afce2d` passed 4/4. Published release
`20260906-090517.886Z` produced signed artifact
`f23427c0-d439-489c-a4c4-ebe78d2df9ef`, checksum
`7b9296ae618292d3678e8b940522653b85d4d101acec3c2d22dad36b457e0958`.
Runner reached generation 54 and all four exact Input/Output checks passed
again with zero model calls. No changes were made to Default, existing business
Policies, model credentials, Deployments, the user cluster or Git history.

Fresh unmocked browser screenshots in `/tmp/guard-real-pinned-ui.uAEXBm/` cover
desktop/mobile editor chips and pinned inspectors. The Guardrail's actual
Inspect link retained version 1, showed only v1 Rules, and Close cleared the
inspector. Neither width had document horizontal overflow; no page errors were
observed. The browser was closed; isolated regression records remain for audit.
The generic unknown-custom-dependency notice remains truthful and is not
silently converted into a model-free declaration by these local test flows.

Fresh full checks: **540 Controller/UI tests in 106 files passed**, typecheck,
UI/server production build, script syntax check and `git diff --check` passed.
The first new selector test needed keyboard opening after removal rather than
an already-focused input; it and the full suite then passed. Existing bundle and
localStorage warnings remain. No new broad Python or streaming suite run is
claimed for this UI/script slice.

Focused pinned-version UI gate, iteration 2, same subchecks/weights and ≥8
threshold as above: Intent 10 (2/2), IA 10 (2/2), Craft 7.5 (2/1; broader
accessibility audit remains outside this focused check), Trust 10 (2/2),
Interaction 10 (2/2), Visual 10 (2/2). Weighted **9.625/10**, +1.5 against the
preceding best 8.125. Decision **pass** for pinned-version editing/inspection
and its persisted publication/execution boundary; the prior synthetic-path
blocker is removed. This is not a pass for the entire creation wizard, custom
dependency classification, streaming fault matrix or live model effectiveness.

### Business preset wizard acceptance and mobile controls (2026-09-06)

The preceding goal turn was progress (real pinned custom lifecycle and selector
repair). This turn follows the accepted business-user creation path rather than
repeating the custom version slice. The existing eight optional directories and
11-step workflow were exercised against the actual isolated catalog and
Controller on desktop (1440x1000) and mobile (390x844).

Three Guardrails were saved through the real UI, then their persisted binding
arrays were compared exactly with the API preset expansion (including order,
versions, selected Rules, directions and overrides):

| Scenario | UI-created Guardrail | Policies | Real validation |
| --- | --- | --- | --- |
| Banking | `a73fe44b-9031-4495-b5f5-86d54430f90d` | 17 | `validation-c810bba8-18ad-4a11-8b27-9815c919f67a`, 103/103 |
| Securities | `ec29637c-7332-4aaf-abca-17ce1c59af17` | 18 | `validation-80dd182c-4756-4a42-9236-72a539e889cd`, 115/115 |
| Internet | `5864e57b-2a63-4c74-b6ab-ffa62a0e3ecc` | 20 | `validation-4d77b207-e8b9-4262-88c9-9f409f13b2f1`, 151/151 |

Securities was applied twice without duplicate bindings. For Internet, the
Rendered content injection Policy was deliberately moved one position earlier,
then the preset was applied again: exact readback preserved that manual order,
and all 151 composition tests still passed. All three runs used real Runner
validation, zero model invocations, zero excluded cases and no runtime failures.
They remain drafts with `activeVersion: null`; no publication, Deployment or
traffic change was implicitly triggered by creation or validation.

The banking map visibly included credentials, payment data, contextual passport
and contact identifiers, harmful/abusive content patterns and prompt manipulation.
Topic restrictions and semantic-model checks were not silently enabled. Selecting
the optional Model Content Safety Policy displayed separate actual unassigned
Input/Output dependencies without claiming validation success. Unconfigured AI
authoring showed its manual-policy alternative. Complete-response-required
Policies forced and explained full-buffered delivery in both review and saved
configuration. These local patterns are not semantic-model quality guarantees.

A one-request browser-injected HTTP 503 tested candidate-preview failure: Create
draft stayed disabled, the error was visible, retry succeeded against the real
Controller, and selected Policies were retained. No safety verdict, successful
preview, saved configuration or validation response was mocked. The same error
path was rerun after the visual changes below without creating another record.

Fresh screenshots exposed two focused craft defects: mobile step indicators
were vertically staggered by wrapped titles, and Apply/ordering/retry controls
used smaller default targets. The horizontal step navigation now top-aligns
items, and preset disclosure/application, ordering/removal and preview retry
targets are at least 44px. Browser measurements confirmed the first four step
indicators shared the same top and the Apply/Move/Retry targets were 44px.

Evidence directory: `/tmp/guard-wizard-acceptance.WiCCOW/`. Final images include
`internet-start-mobile.png`, `internet-review-mobile.png`,
`preview-error-mobile-final.png` and `missing-model-mobile.png`; desktop banking
review/delivery and the pre-fix mobile baseline are retained separately. No
document horizontal overflow or page errors were observed. The isolated browser
was closed. The three new regression drafts remain auditable; existing Default,
business Policies, model credentials, the user's cluster and Git history were
not changed. Broad data-plane/live-model/streaming suites were not rerun in this
UI-focused slice; the 369 real draft-validation cases are not counted as a new
business-proxy or deployed streaming replay.

Fresh checks after the UI changes: **540 Controller/UI tests in 106 files passed**,
typecheck, UI/server production builds and `git diff --check` passed. Existing
bundle/localStorage warnings remain. Focused wizard preset gate, same frozen
weights and ≥8 threshold: Intent (business baseline 2, optional map 2) 10;
IA (full map 2, mobile navigation 2, dense long lists 1) 8.33; Craft (aligned
steps 2, affected touch targets 2, broad contrast audit 1) 8.33; Trust (exact
saved binding identity 2, no-model evidence 2, draft/release separation 2) 10;
Interaction (three real saves 2, retry/preserved choices 2, exhaustive keyboard
and permission matrix 1) 8.33; Visual (existing components 2, readable final
screenshots 2) 10. Weighted **9.17/10**, decision **pass** for the representative
business-preset creation path; no numeric cross-slice baseline delta is claimed.
Remaining whole-product gates below are not waived by this focused acceptance.

### Published custom dependency facts (2026-09-06)

The preceding plan-only turn was no progress toward implementation. This turn
completed the pending custom metadata slice using fresh worktree inspection and
tests. Published custom Policy surfaces now project the author's existing
category into a business directory and preserve declared evaluation contracts.
The projection uses each immutable published snapshot, including older pinned
versions; unpublished recategorization cannot change an existing binding.

The shared contract resolver now supplies both selected-direction wizard
requirements and published-plan health requirements. Known custom model
requirements remain visible alongside the unknown-dependency warning, rather
than being hidden by it. Tests run the actual Controller plan builder and compare
its resulting health requirements with selected frontend bindings independently
for Input and Output. Unknown contracts, unsupported directions and arbitrary
custom flows are never inferred to be model-independent. Empty declarations do
not prove completeness; caller context is not guessed from a model name.
Recommendation facts expose known model requirements and explicitly report
`dependencies_complete: false` for custom code.

A related setup-report defect was fixed: custom Policies with no declared
dependencies (or with every declared dependency available) now report
`unknown`, not `ready`. Known missing dependencies still report `blocked`.
`dependenciesComplete` makes the distinction explicit. This does not invalidate
an otherwise valid empty model configuration or make optional custom Policies
block the model-free baseline. Both the pure projection and actual configuration
service report are covered; the latter uses the existing repository/Provider
test doubles, not a real database validation request.

Fresh authenticated, read-only HTTP evidence from the isolated Controller
confirmed `policy-02c8e9e2-a77d-434c-9e65-8d3cddd243ea` returns published v1 and
v2 with custom execution, content-safety directory, explicit empty declared
contracts, complete-response streaming and the dependency limitations. No
Policy, Guardrail, model credential, published release or user cluster was
changed by this readback (only an isolated authentication session was created).
No live model call or data-plane execution is claimed by this metadata check.

The first full run caught a frontend crash when direction metadata was missing
in a Rule fixture. Local Policies no longer inspect irrelevant model directions;
incomplete model Rule metadata now yields unknown instead of throwing or
inventing a binding, with regression coverage. Final fresh verification:
**549 Controller/UI tests in 107 files passed**, typecheck passed, UI/server
production builds passed, and `git diff --check` passed. Existing bundle and
localStorage warnings remain. No new browser visual score or broad runtime
regression is claimed. This slice establishes known-dependency consistency, not
complete static dependency analysis of arbitrary Colang or full custom-authoring
UI acceptance.

### Streaming completion and failed-check boundaries (2026-09-06)

The previous goal turn made verified progress on custom dependency facts. This
turn extended the real business-proxy fault matrix and repaired newly identified
stream failure semantics rather than repeating the wizard acceptance slice.

`regress_business_proxy.mjs` now checks clean EOF without a model finish marker,
`[DONE]` without a finish reason, an explicit SSE inference error, and a legitimate
`length` completion that must still be checked/redacted. It also starts an
isolated loopback forwarding layer and injects HTTP 503 specifically at the
first and final Output check. All normal calls reach the actual Runner. These
are transport failures, not mocked safety verdicts. Assertions distinguish
infrastructure errors (5xx) from actual Policy rejection and inspect exact
client-visible content, upstream calls and full-buffer release timing.

Source review found two failure-contract defects. A fail-closed evaluation was
previously indistinguishable from a successful Policy rejection in the stream
acknowledgement; a transform decision with no output could fall back to the raw
candidate. The shared in-memory/Redis transition now rejects failed checks and
invalid transformations explicitly, without consuming the sequence or duplicating
text on retry. Empty-string transformations remain valid. A transformation that
would rewrite an already released prefix now reports an execution error rather
than inventing a Policy match. Runner maps failed/invalid checks to HTTP 502 and
fail-closed timeout evidence to 504. Relay's authorized TaskLattice Provider
additionally rejects fail-closed evidence as infrastructure failure and withholds
private error bodies.

Fresh state-machine and Runner ASGI tests exercise both storage implementations,
all three delivery modes, retry after failure, invalid/missing transformations,
explicit empty output, HTTP/LiteLLM failure status and actual Policy rejection.
These failure-injection tests use controlled evaluator responses; they prove
engineering contracts, not semantic-model quality. Final full data-plane gate:
**212 passed, zero skipped**, including the six real-Redis tests. Contracts:
**55 passed, one existing skip**; protobuf freshness, Helm lint/render and both
repositories' `git diff --check` passed. Existing NeMo deprecation warnings remain.
No Controller UI changes or fresh browser visual gate are claimed in this slice.

The scoped Relay regression image overlays only the TaskLattice Provider onto
the previously verified pinned full Relay image; **18 adapter tests passed** in
the build. Its image ID is
`sha256:c705ba2b530863e54146a7f85b4f27d6383182a1810214c3ac91b83761a4e0b3`.
The user's mutable `ghcr.io/tasklattice/tali-litellm:dev` tag was not replaced.
An initial build attempted to use a raw local image ID in `FROM`; Docker treated
it as a repository and failed. A new task-only base tag pointing to the verified
local image resolved that build invocation; no runtime restart was inferred from
the failure.

Actual client replay with the updated Provider image:

| Guardrail | Unchanged release / artifact | Replay | Integration / Deployment |
| --- | --- | --- | --- |
| Default | `20260906-061551.290Z` / `218e466e-526d-4a78-a1d3-ad7343f51532` | 22/22 | `1cbd8d8e-94dd-4353-a96d-5aae78fdece6` / `bb9d7f98-47d5-4a5a-9251-978d1773c569` |
| Banking `ed3eee48-25b0-4bbd-abb9-00ec2a89da53` | `20260906-035855.423Z` / `ff8759ac-968a-470b-9e43-22cc07d54d65` | 22/22 | `f8d16143-e850-4ef5-a1a2-aa852748247f` / `59135d1b-6aff-4120-8858-a9f7493135c5` |

Both first/final-check outage cases observed one injected failure, a 502 and zero
released client characters. Cancellation emitted zero client bytes and closed
upstream generation in 2622ms (Default) / 2645ms (Banking), within the existing
3-second gate. The preliminary pre-adapter-change Default run passed 20/20 and
left integration `190e19df-802c-46ef-a79f-81838c85f974`, deployment
`17b2192e-48f3-4ce1-80bb-ad5e6ac7341b`; it is not counted as new Provider evidence.

The live isolated Runner process was not restarted in this slice, so the new
Runner error-mapping implementation is verified by the fresh source/ASGI tests,
not by a claimed updated live Runner image. The real proxy runs establish
transport-failure handling against the existing isolated Runner and the new
Provider. No Guardrail draft, Policy, model credential, active artifact, user
cluster or Git history was changed. Ephemeral proxy containers and forwarding
servers were removed; dedicated Redis container `guard-stream-fault-redis-20260906`
was stopped and auto-removed. Isolated regression records and task-only images
remain available for audit. Live model effectiveness, updated-Runner deployment
verification, broader incremental-mode/restart faults and full UI gates remain.

### Updated isolated Runner and real execution-failure acceptance (2026-09-06)

The previous slice's updated-Runner deployment-evidence gap was subsequently
closed against task-owned Controller 8093 / Runner 8094, not the user's cluster.
The old Runner PID 36860 was gracefully stopped, and PID 50542 started the then
current source with the same isolated state and public key. Readiness recovered
generation 60 with all three active releases prewarmed. Ordinary restart
recovery is proven; this is not a corrupt-state or mid-stream crash claim.

After restart, `regress_default_runtime.mjs` completed 483 actual checks, including
321 inherited and 140 legacy cases, with 123 exact-output assertions and zero
model invocations. Default revision 9, release `20260906-061551.290Z` and artifact
`218e466e-526d-4a78-a1d3-ad7343f51532` were unchanged.

The new `regress_stream_failure.mjs` fixture follows real Policy validation,
publication, Guardrail validation, signing, distribution and stream HTTP.
An intentionally unbound recording call in custom Colang produces a genuine
NeMo execution error for a synthetic marker; no safety verdict is mocked.
Policy `policy-2dbfcac6-29d3-48b0-9290-3d6d9d27b8e5` v1 and Guardrail
`31c57ae4-ffea-4f87-b85b-b1fdd9b39f80` passed validation
`validation-4fe043ee-7bf2-42fb-ac79-47613fb081bc` (3/3, zero exclusions/model
calls). Release `20260906-094950.349Z` uses signed artifact
`9623d244-e0fe-4640-adbc-67d06da8e1b3`, checksum
`e9ecd43216133d44c4486442a1620363dd7707971d58136a92d335ae968beca6`.
The completed replay used Integration `0d5e347a-d34d-4aaa-9d93-70267a456edc`
and Deployment `d17fb020-70c2-4718-a89c-4ba58d1c5ee5`. It distinguished safe
completion (200), a successful Policy rejection (200 blocked), and a detector
execution failure (502); all first buffered chunks released zero characters.
The first driver run incorrectly used the LiteLLM `/verify` endpoint for a generic
HTTP Integration and received 409. That known test process was explicitly stopped;
the corrected driver reused the published fixture. It was not restarted merely
because an observation timed out, and no failure case was excluded.

The updated Runner also passed 22/22 actual client proxy checks for each of the
unchanged securities and internet presets with scoped Relay Provider image
`sha256:c705ba2b530863e54146a7f85b4f27d6383182a1810214c3ac91b83761a4e0b3`:

| Preset | Guardrail / Artifact | Integration / Deployment |
| --- | --- | --- |
| Securities | `770ffd9a-ac0d-4e99-bbf3-3d509ba88802` / `132e324b-2492-4c1d-bb31-fa6cd7ceb07d` | `7047f0d6-a8ec-4137-9133-fa562629ff50` / `5b7a6b96-c736-4af5-a5b2-79be16f82bd3` |
| Internet | `38b158b2-fe22-4d1e-8844-0d6e564182e8` / `b58682d9-df4f-4ab2-8d94-d47824efc318` | `ced8c6f5-c77b-4847-8701-87535b5937e5` / `6ec62cc2-2324-4da9-bc79-c1f8571fa31c` |

Both first/final Guard transport-failure cases returned 502 with zero released
client characters. Cancellation closed the upstream in 2599ms and 2550ms,
respectively, within the existing 3-second gate, with zero client bytes. Proxy
containers and forwarding servers were cleaned up. Final readiness was generation
69 with six active/prewarmed releases. Isolated regression records remain; no
user Policy, credentials, cluster deployment or Git history was changed.

### Enabled-policy streaming contract and frozen model artifacts (2026-09-06)

Source inspection found two selection-boundary defects. Runtime delivery
inspection treated every version snapshot's Output rail as arbitrary custom
Colang, even for native built-ins or unselected Output rules/versions. Compiler
inspection imposed a custom Policy's full-buffered requirement even when only
its Input flow was selected. New regression tests first reproduced 16 runtime
and four compiler failures; both implementations now inspect enabled execution.
Native model steps can retain incremental delivery, while selected custom Output,
PII/transforming/local pattern steps, unknown steps and explicit complete-response
requirements retain buffering. This does not claim that every existing model
configuration was affected: the current focused model Policy builder emits
native steps directly without a Policy source snapshot.

Added 35 pure data-plane delivery-contract cases and six independent Compiler
selection cases. Three new deterministic signed fixtures are generated by the
actual Controller builder for `builtin-content-safety` Output, one per requested
delivery mode. Twenty-four Runner-only tests load these artifacts and exercise
actual NeMo, NVIDIA Safety Guard v3 / Qwen3Guard provider parsing, and Runner
stream ASGI HTTP. They verify exact released prefixes, accumulated candidate
context across chunks, safe completion, Policy rejection, backend failure,
malformed model responses and retry of the same failed final sequence without
duplicated text. Model HTTP responses are synthetic; no live-model quality or
real-network incremental proxy coverage is inferred from these tests.

Fresh gates after the changes:

- Python control plane: **529 passed**.
- Data plane: **271 passed, zero skipped**, including six real Redis tests using
  a dedicated loopback container (stopped and auto-removed after completion).
- Contracts: **55 passed, one existing skip**. Control-channel E2E: **5 passed**.
- Deterministic signed-artifact freshness and both repositories' diff checks
  passed. Existing NeMo deprecation warnings remain. No fresh frontend/browser
  gate is claimed for this runtime/compiler slice.

The task-owned isolated Runner was then gracefully restarted from PID 50542 to
PID 52248 with the same public key and retained state. It recovered generation
69 with six active/prewarmed releases. The existing signed stream-failure fixture
passed its three real HTTP cases again (200 safe, 200 Policy blocked, 502 NeMo
execution error), using new isolated Integration
`64404ff1-30f8-4752-bf04-f58977868983` / Deployment
`04b427be-85f2-4216-889d-32bc949dff29`. The unchanged Default release again passed
**483 real HTTP checks**, including **123 exact-output checks**, at generation
71 with **zero model invocations**. User-facing cluster ports 38081/38082,
existing business Policies, Default draft/release and Git history were untouched.

## Custom Policy business-directory authoring acceptance (2026-09-06)

Policy Studio now offers the same eight business directories as the protection
map, replacing its separate nine-category technical selector. The explicit
`protection_directory` belongs to the draft and immutable version snapshot and
survives export/import. Published-version projection never reads a newer draft's
directory. Existing snapshots without the field retain their category-derived
directory. Directory selection changes navigation metadata, not executable flows,
model dependencies or the completeness of a custom implementation's contract.
Changing it invalidates the draft's previous validation before publication.

The focused UI work reused existing Select, field and review components. Browser
inspection also exposed labels that incorporated textarea contents after typing;
explicit label/control association now keeps their accessible names stable.
Four component cases cover eight options, validation invalidation, save failure
and retry, and stable field naming. Schema/projection and transfer tests cover
every directory, rejected invalid metadata, round trips and version isolation.
The full Controller/UI suite passed **568 tests across 108 files**; production UI
and server builds and both repositories' diff checks passed. Existing bundle-size
warnings remain. No new Python-wide run is claimed for this metadata/UI slice.

In the task-owned isolated UI on 8092, a real authoring flow created Policy
`policy-884c2149-be77-4327-b6a1-9df4d9b27736`, version `1`, checksum
`a669a978899f9782d35e6d1f22398c87457d80cb7581f1bedc3bac37de224712`.
Its synthetic marker Input flow passed both actual NeMo cases (safe and block).
A scoped browser network abort before the create request reached the server
verified failed-save recovery without losing the selected directory or source;
retry then saved and published successfully. Inspection, re-editing and Library
filtering preserved Code & application injection; Words & content filters
excluded this Policy. This fixture is not a production detector or a deployed
Guardrail. No existing Policy, Default release or user cluster was changed.

Fresh screenshots were inspected at 1440x1000 and 390x844. The mobile directory
menu exposes all eight options with 44px rows and no document horizontal
overflow. Keyboard navigation and Escape preserve the original selection.
Evidence: `/tmp/guard-policy-directory-mKzaOr/` (directory options, publication
review and published-directory filter). The failed-save screenshot alone does
not show the error banner; failure/recovery assertions and the successful retry
provide that evidence. No uncaught browser page errors were recorded.

Focused Design I/O gate, retaining the established weights: intent 9/10 (20%),
information architecture 9/10 (20%), craft 8/10 (15%), trust 9/10 (25%), interaction
8/10 (15%), visual 8/10 (5%); weighted **8.65/10**. Two revisions: directory
integration, then the observed accessible-label correction. This passes only
the directory-authoring scope, not the entire advanced Policy Studio or full UI
permission/offline matrix. Remaining observation: custom-flow test reasons can
still use generic customer-data wording unrelated to the author's marker; this
is not evidence of a different runtime decision or certified detection quality.

## Authoritative custom Policy source gate (2026-09-06)

The existing Python `validate_policy` method had no production caller. Direct
Default Runner compilation therefore accepted statically undefined Flows,
undeclared Actions and duplicate/process-wide Flow declarations. Eleven new
negative cases reproduced this missing gate (two positive cases passed).
Compilation now validates each selected custom version independently, including
parameter-expanded author source. NeMo's own Colang 2 parser supplies Flow,
import and Action references; comments, literal strings, nested statements and
calls without parentheses no longer depend on ad-hoc regex interpretation.
Existing executable namespacing/substitution order is retained. Unselected
source is not compiled, and one Policy cannot borrow another's Action declaration.

The first real HTTP attempt exposed a second issue: Controller regex checks
rejected a valid comment containing `await MissingAction()`. Those duplicate
source checks were removed; schema, registered Action metadata, binding graph
and reviewed-test coverage remain Controller responsibilities. Source semantics
are checked by the mandatory Default Runner. The legacy metadata `/validate`
response no longer claims `valid: true` without a passed validation for the
current draft; it reports metadata validity, run status and remaining validation
requirement separately. Publication still rejects missing, failed and stale
evidence. Saving an incomplete draft does not authorize execution or publication.

Fresh evidence:

- **18** production-entry compiler declaration cases and **10** Controller
  evidence/publication cases. The final focused compiler/artifact run passed
  **35** tests, including deterministic signed-artifact freshness.
- Full Python control-plane suite: **535 passed**. Controller/UI suite:
  **578 passed in 109 files**; production UI/server builds passed.
- Data plane, contracts and control-channel E2E combined: **195 passed, one
  skipped** (172 data-plane, 18 contract, five E2E passes). The skip is the
  opt-in `GUARD_HELM_TEST_CONTEXT` cluster lifecycle test. Six Redis tests used
  a dedicated loopback container, stopped and auto-removed afterward.
  Counts here are from this turn's actual collection/execution, not previous
  ledger totals. Existing NeMo deprecation and frontend bundle warnings remain.
- Real `regress_policy_dependencies.mjs` rejected both uncovered invalid branches,
  denied publication, recovered the same fixture and published Policy
  `policy-630a8f7d-2189-482f-952f-b0f3a72343a2@1`, checksum
  `937a0655a10502fcb4dce080f96ad2925a601c485b57eb602b2a80497784d3d6`.
- A fresh pinned-version lifecycle created Policy
  `policy-e95a6f3a-0042-4c6d-a381-7efeae03540e`, published v1/v2 and proved
  Guardrail `dc51ae4e-b130-4e49-be34-6088874f8d62` still executed v1 after editing.
  Artifact `8abe87c0-20a3-4ee3-83ef-a567d3bd7893` checksum
  `0fe3bb00b421912e13c745d2d34d1c58849409c1937439785f9785c308bca7dd`
  passed four exact Input/Output cases with zero model calls.
- The unchanged Default artifact again passed **483 real HTTP checks**,
  **123 exact outputs**, zero model calls. Task-owned Runner 8094 was restarted
  from PID 52248 to 55694, recovered generation 71 and six prewarmed releases
  before the new regression release. No user cluster or Git-history mutation.

This closes statically named source-reference enforcement, not all arbitrary
custom dependency analysis. Dynamic expressions/event dispatch, complete
model/prompt/context dependency enforcement and fully symbol-aware source
namespacing remain outside this gate. No new UI visual or live-model-quality
claim is made by these compiler/backend tests.

## Source-preserving linking and Policy-owned results (2026-09-06)

Whole-source Flow renaming changed string literals and local variables as well
as executable symbols. A real NeMo test with Flow `check` and business match
`$text == "check"` reproduced false allows on both Input and Output. Additional
failures demonstrated changed multiword helper text and name collisions for
distinct Policy IDs that normalize to the same identifier. Five negative cases
failed before the fix; safe-content cases remained passing.

Compiler `tasklattice-nemo-config-v16-policy-symbol-ownership` now uses source
ranges from the pinned NeMo grammar to rewrite Flow definitions and statically
named Flow references only. Business strings, comments, variables, member names
and expression text are retained. Parameters are expanded before linking so the
validated author source is what gets linked. Generated Flow identities include
an exact-identity digest, avoiding normalization collisions. NeMo's pre-parsing
expansion is shared, rather than approximating its syntax with another parser.

RecordPolicy calls are lowered to the internal, versioned
`GuardRecordOwnedPolicyAction@1.0.0`, with compiler-owned Policy ID/version.
The authored `flow_name` may remain a literal or computed value; result lookup
is scoped to that Policy/version/direction. Authors cannot replace the compiler's
identity arguments. Named classic and named simple argument syntax execute
through real NeMo. Positional arguments, which NeMo's Python Action dispatcher
does not bind to this method's named parameters, now fail compilation explicitly.
Generic custom findings no longer inaccurately claim customer-data detection.

The new Action is pinned in the dependency manifest, so an older Runner without
this implementation rejects prewarm instead of claiming compatibility. Existing
unscoped immutable artifacts remain readable when their result identity is
unambiguous. This is not permission to dynamically dispatch arbitrary internal
events or an assertion that Policy authors are sandboxed.

Fresh acceptance:

- 15 source-linking/real-NeMo control-plane cases plus nine independent signed
  artifact data-plane cases, including same-name Policy ordering, both directions,
  complete-response streaming and missing executor support.
- Combined Python gates: **754 passed, one opt-in cluster test skipped**
  (550 control-plane, 181 data-plane, 18 contract and five E2E passes). Real Redis
  used a dedicated loopback container, then stopped and auto-removed. Generated
  artifacts were refreshed for compiler v16 and deterministic freshness checked.
  Existing NeMo deprecation warnings remain; no fresh frontend visual gate is
  claimed by this compiler/runtime slice.
- Real HTTP pinned-version regression with `GUARD_REGRESSION_SYMBOL_MARKERS=1`
  passed: Policy `policy-ffe6d8ba-bb94-43c0-a37f-f0548ed3d3b9` published v1/v2;
  Guardrail `fffa3a61-b525-47a1-acdc-33966e80684f` retained v1 behavior.
  Version `20260906-110703.118Z`, artifact
  `a78f4cc5-864f-488f-a780-cafee745b553`, checksum
  `b3bb6e31c13fa8491e2489334f1049b869642094ee0c6ec22b9ff81bdba2e606`.
  Four exact replay cases passed with zero model invocations.
- Task-owned Runner 8094 restarted from PID 55694 to 58131 and recovered six
  active releases at generation 72 before the new release. The unchanged Default
  again passed **483 real HTTP checks**, **123 exact outputs**, zero model calls.
  No user cluster, existing business Policy or Git-history mutation.

Static symbol linking and result ownership are now verified. Dynamic event-based
Flow dispatch, arbitrary source dependency completeness and live-model detection
quality are not established by these checks and remain separately tracked.

## Registered Action failure boundary (2026-09-06)

Six real-NeMo negative tests reproduced a fail-open defect in both Input and
Output: missing/extra Python Action arguments and a body TypeError were converted
by NeMo dispatch into events, after which the generated resolver returned allow.
The upstream dispatcher also logged raw Action arguments on those exceptions.

All product-registered Actions now retain their original inspection signature
behind a request-scoped failure boundary. Sanitized exceptions use NeMo's public
propagation family, not an upstream dispatcher patch. The failure remains sticky,
later Actions do not execute, and concurrent/subsequent requests stay independent.
Raw arguments and exception messages are not included in the safe diagnostic.
Timeout metadata remains a timeout (HTTP 504), while other execution errors give
HTTP 502 on the streaming boundary. No failed chunk is committed or released.

Real persisted validation exposed an additional observability gap: the generic
runtime failure lacked its Action trace and therefore had no classified failure.
Action identity/error telemetry is now retained. Validator additionally rejects
unclassified fail-closed results as ordinary Policy-match evidence. The existing
`provider_failure` validation value includes local non-timeout Action failures;
it does not imply an external model invocation.

Evidence:

- Final combined Python gates passed **773 cases, one opt-in Helm/cluster test
  skipped**, in 107 seconds. This includes Action telemetry, Validator assertions
  and the timeout-metadata expansion (also 34 focused passes). Existing NeMo
  deprecation warnings remain. The dedicated loopback Redis container was stopped
  and auto-removed after the terminal result.
- Real HTTP `regress_stream_failure.mjs` with
  `GUARD_REGRESSION_ACTION_DISPATCH_FAILURE=1` passed safe, unsafe and actual
  argument-dispatch-failure cases in full Output and buffered stream paths.
  It resumed the same unchanged unpublished fixture after the telemetry fix,
  rather than creating another Policy or weakening expected results.
  Policy `policy-6b84a2e3-5b0c-4b04-baa5-622b36282892@1`, Guardrail
  `8307ec8d-3a0f-4a4b-922a-7d1a1d4e953f`, version
  `20260906-112611.821Z`, artifact `8efe6984-3c30-4b10-ae78-043aeacb8c0f`,
  checksum `4bbf2fde413c0d4c82189a723575f3814e50f66f082684a36754b16637eea5b1`.
- Default again passed 483 deployed checks, 123 exact outputs, zero model calls;
  draft 9, version `20260906-061551.290Z` and its artifact remain unchanged.
- No user-cluster writes, Git commit, or new frontend-completion claim. These
  tests do not prove arbitrary dynamic Flow/event sandboxing or live-model quality.
- The final task-owned Runner on 8094 is ready, Controller-connected and
  synchronized at generation 76 with all seven active releases prewarmed.

The product is in end-to-end regression and defect convergence, not final
acceptance. Following the user's quota constraint, status updates must identify
the current stage, completed batch and remaining acceptance work; do not repeat
broad audits without a concrete change or unresolved gate requiring them.

## Strict custom Policy recording values (2026-09-06)

A bounded follow-up reproduced ten Input/Output failures: a string `"false"`
or integer `1` was treated as a safe verdict, and null verdict/text or numeric
replacement values were not rejected as invalid execution results. Custom Policy
recording now checks a real boolean verdict, string text, optional string
replacement and nonempty Flow identity before recording findings or mutations.
Malformed values use the registered-Action failure boundary, not a safe default.
Boolean `False` and an empty-string redaction remain valid and tested.

The five affected test modules passed **64 cases** in 6.66 seconds, including
real NeMo in both directions and malformed-value injection at the actual Action
behind frozen signed data-plane artifacts. Full-buffered HTTP still withholds
the response on failure, including retries. No compiler is imported in these
data-plane tests. `git diff --check` passed. To respect the quota constraint, no
full-suite rerun, Runner restart, live deployment or external model call was
performed for this follow-up. The previous 773-test result is historical evidence,
not a claim that the full suite was rerun for this exact patch.

Overall stage remains end-to-end regression/defect convergence; the open release
gates below are unchanged.

## Budget-gated holdout evaluation entry (2026-09-06)

There was no independent quality-evaluation entry alongside the fixed lifecycle
replay scripts. `scripts/evaluate_model_holdout.py` now reads an externally
reviewed corpus and uses an existing deployed generic-HTTP Integration. It pins
Guardrail/configuration/release/model revision evidence and requires a successful
call trace for the expected model/capability/direction. Full Guardrail decision
quality is reported, not isolated-model accuracy or business-generation quality.

False positives, false negatives, errors and incomplete groups remain separate;
an execution-failure block cannot pass as a detection. No classifier threshold
or corpus has been invented and accepted on behalf of the user. Reviewed
thresholds, sufficient benign/unsafe samples per category/direction, opt-in and
an explicit request cap are required. The cap is not a dollar/token limit, since
a Guardrail request can invoke several models. The harness stops on missing
evidence, configuration drift or service failure, verifies TLS and refuses
redirects; reports omit request/response content and credentials.

**26 focused harness tests passed** in 0.05 seconds; CLI help and whitespace
checks passed. All test transport is synthetic and explicitly not safety-quality
evidence. No external model call, full-suite rerun, deployment or Git commit was
performed. Actual independent holdout review, threshold approval, real execution,
streaming acceptance and final operational handoff remain open.

## Delivery selector accessible explanation (2026-09-06)

Source inspection confirmed that the wizard already distinguishes checked
incremental release from complete buffering and derives forced full buffering
from selected output Policies. The disabled selector did not programmatically
reference its explanation. Its description is now associated using
`aria-describedby`, announces changes politely, and includes the exact Policy
names/reason for forced buffering for assistive technology. The existing visible
Policy list and execution behavior are unchanged. The older component-test mock
label claiming immediate unchecked release now matches "Check each chunk".

The two affected component suites passed **12 tests**; the UI TypeScript check,
Vite production build and server TypeScript build passed. Existing large-bundle
warning remains. No model calls, deployment or full runtime regression occurred.

Design I/O disposition: focused product-console release gate, existing weights
20/20/15/25/15/5 and threshold 8 unchanged; **stop_budget**, not pass. The IAB
loaded the isolated Guardrails page, but its returned control documentation was
insufficient for the planned interaction; the independent Playwright import also
failed with an export-resolution error. Fresh desktop/mobile selector screenshots
and browser keyboard checks were not obtained. Component assertions are not a
substitute for those checks, so visual dimensions remain unscored and the broader
UI release gate stays open. Do not use this entry as a completed browser audit.

## Delivery selector browser acceptance (2026-09-06)

Stage remains end-to-end acceptance and defect convergence. The previous goal
turn restated the plan rather than completing this acceptance. This batch resumed
the existing isolated UI at 8092 using bundled Playwright with a separate headless
Chrome instance. No user browser profile, ports 38081/38082, models or deployment
were changed.

Fresh real-browser evidence confirmed that a blank Guardrail states that responses
are not checked. Applying Banking customer service selects 17 output Policies and
locks delivery to full buffering; the disabled selector's accessible description
names those Policies and explains that no response text is released before the
checks finish. Enter expands the native Included Policies disclosure. Inspection
found its touch target was only 20px high; existing spacing/focus tokens now enlarge
it to 44px and provide an explicit focus-visible ring, without changing runtime
semantics. The post-change browser measured 295x44px on a 390x844 viewport.

The post-change blank/preset path, keyboard disclosure, keyboard activation of
Review & create, and Close dismissal passed. Desktop and mobile dialogs had no
horizontal overflow; no unnamed dialog buttons or page errors were observed.
The first Escape observation was during exit animation, not an undismissable
dialog: a subsequent inspection confirmed it had closed. No draft was saved or
published. The independent browser was closed after capture.

Evidence: `/tmp/guard-delivery-browser-bWsncE/desktop-fixed.png`,
`desktop-fixed-full.png`, `mobile-fixed.png`, and `mobile-fixed-details.png` in
the same directory (temporary local screenshots, not committed artifacts).
The two affected component suites passed **12 tests** in 2.92s. UI/server
TypeScript checks and production build passed; existing large-bundle warning
remains. No full Python/runtime suite or external-model evaluation was rerun.

Design I/O: focused delivery-explanation product-console release gate, iteration
1, unchanged weights 20/20/15/25/15/5 and threshold 8. Each pair below is scored
0-2 from the screenshots and interactions above:

- Intent: delivery purpose 2, reason for disabled choice 2 => 10.
- IA: related mode/reason/Policy grouping 2, narrow-screen discoverability 1
  (the horizontal stepper has no explicit scroll hint) => 7.5.
- Craft: readable wrapping/no horizontal clipping 2, token-based focus and
  measured disclosure target 2 => 10.
- Trust: unchecked blank state 2, forced buffering with named dependencies 2
  => 10. This is UI evidence, not new streaming runtime evidence.
- Interaction: Enter disclosure and review activation 2, scroll/close/reopen
  recovery 2 => 10.
- Visual: existing console typography/surfaces 2, restrained hierarchy and
  focus treatment 2 => 10.

Weighted result **9.5/10**, decision **pass for this focused change**, no focused
blocker. Prior browser-unverified iteration was unscored, so score delta is not
defined. The broader permission/offline/advanced-authoring UI gate, deployed
incremental streaming matrix, live-model holdout and operational handoff remain
open; this result does not certify the entire product or mobile wizard.

## Real TCP checked-release acceptance (2026-09-06)

Stage remains end-to-end acceptance and defect convergence. The previous turn
completed the focused delivery UI audit; this batch addressed the concrete gap
between the existing in-process stream API tests and actual socket transport.

`tests/data_plane/test_stream_safety_network.py` loads the existing frozen signed
stream-safety artifacts without importing the compiler/Validator. It runs actual
Runner HTTP, NeMo, provider requests and NVIDIA/Qwen response parsers over two
OS-assigned loopback TCP ports. The model HTTP service emits synthetic verdicts;
no external model or user deployment is involved. Controlled model-response gates
prove that the client receives no unchecked response bytes while a detection is
pending. Exact released prefixes and complete safe output are checked for
interruptible, window-buffered and full-buffered delivery. A cross-chunk unsafe
marker is withheld; an HTTP 503 releases no failed candidate and same-sequence
retry sends the identical accumulated model payload before returning a genuine
parsed block, not a fail-closed detection success.

The initial 12 block/failure cases passed; after adding the normal-completion
counterexample, the final **18 cases passed in 13.05 seconds**. Only existing
NeMo deprecated `nim_url` warnings appeared. No full suite, build, external API,
publication, cluster deployment or Git commit occurred. Both TCP servers are
closed by the test lifecycle. These tests are automatically owned by the existing
data-plane test gate through their directory.

This closes the deterministic direct-Runner TCP timing gap, not the broader
deployed Relay/incremental SSE fault/cancellation matrix or live-model quality
gate. Streaming's containment boundary remains explicit: checked incremental
prefixes cannot be recalled after a later rejection; full buffering emits none
until complete-response checks pass. Remaining full-scope gates below remain open.

## Actual Relay streaming failure and cancellation (2026-09-06)

Stage remains end-to-end acceptance and defect convergence. The preceding turn
added direct-Runner TCP tests; this batch moved to an actual Relay/LiteLLM proxy
with the current TaskLattice Guard overlay, frozen signed Runner artifacts and
controlled business/classifier HTTP services. No Controller writes, user ports,
external model calls, image pulls or cluster changes were made.

The new opt-in `tests/e2e/test_relay_stream_delivery.py` exposed two real defects:

1. A detector HTTP 503 after an approved incremental prefix caused a truncated
   client socket. LiteLLM re-raises FastAPI HTTPException after its SSE response
   has started. Only TaskLattice Guard's Provider hook now converts such failures
   to native LiteLLM APIError, preserving status and only integration-owned safe
   messages. Unknown HTTP exception details are sanitized. Detection failures
   remain 5xx and cannot pass as Policy matches.
2. Full buffering held LiteLLM in its first-output-frame peek, so cancelling the
   client did not close an upstream producer paused after its first chunk. The
   integration now emits an empty assistant-role frame after validating the first
   upstream frame, allowing disconnect-aware streaming to start without releasing
   protected content. The actual upstream producer closes on cancellation.

Final actual proxy run: **3 mode tests / 12 scenarios passed in 33.02 seconds**.
Safe output was exactly 4,215 characters. Before later rejection or detector
failure, approved prefixes were 4,200 characters for interruptible, 2,152 for
window-buffered, and zero for full-buffered. No unsafe suffix or false successful
completion reached the client. Cancellation closed the paused upstream within
three seconds in all modes; full buffering made zero detector calls and released
zero content before that cancellation. Provider unit tests: **20 passed** in
0.072s, including private error sanitization and empty-frame cancellation.

Base image: `sha256:a67344ef5ab3993a9e8b07b2691578a40365639b12add3299c161f7924d0007b`.
Current source was mounted read-only, so the image digest alone is not the tested
implementation identity. Tested overlay SHA256:

- `streaming.py`: `40c396e11951c40d91632b17d467f7226bf358e622e77d5d7cdbecb664075c02`
- `tasklattice_guard.py`: `ee8d90058ae5dd772b8331349d74c0ab91e2da2a5fc644c99fdbe5fa755a23af`

All test-owned proxy containers were stopped/removed; a fresh Docker listing
found none remaining. The prior business-proxy cancellation assertion was updated
to distinguish content from role-only protocol bytes and passed Node syntax
checking, but its entire historical matrix was not rerun. Both worktrees passed
whitespace checks. No commit or deployment occurred.

This closes the three-mode safe/late-block/detector-HTTP-failure/cancel-after-first-
upstream-frame proxy acceptance gap. It does not certify first-frame stalls,
multi-replica proxy failover, live-model quality or the complete product release.

## Cross-Runner TCP/Redis stream handoff (2026-09-06)

Stage remains end-to-end acceptance. The preceding turn fixed actual Relay error
and cancellation paths; this batch checks the next gap: continuing a stream on a
different Runner without losing its release pin or checked buffer.

`tests/data_plane/test_stream_replica_network.py` uses two separate registries,
TCP servers and NeMo runtimes, shared production Redis context/stream stores,
existing signed artifacts, and a local synthetic NVIDIA model HTTP endpoint.
After sequence 0, the primary HTTP server is actually stopped (a new TCP request
fails to connect) and its NeMo runtime is shut down. The second Runner receives
sequence 1. All three modes preserve exact accumulated text, pinned release and
model revision. Normal completion releases exact safe output; rejection withholds
the unsafe suffix; detector HTTP failure does not commit state and an identical
retry succeeds. Completed sequence replay returns 409 instead of duplicate text.
Explicit call-context expiry returns 409 before model execution or buffer mutation.

The expiry test initially addressed the external call ID instead of the existing
integration-scoped internal ID; that test setup was corrected, not production
context logic. Final **12 cases passed in 10.99 seconds**. Existing NeMo `nim_url`
deprecation warnings remain. The test's Redis container used an OS-assigned
loopback port, persistence disabled, and was stopped/auto-removed afterward.
No external models, user data, Controller publication, cluster deployment, commit
or full-suite rerun occurred. Only test/documentation changes were required.

This is real TCP/Redis handoff between independent instances in one Python test
process, not a claim of Kubernetes pod eviction or production load-balancer
failover. It closes the state/release continuity acceptance gap at the Runner
boundary. First-upstream-frame stalls, operational deployment checks, the broader
custom-Policy/UI gates and independent live-model quality remain open.

## First-upstream-frame cancellation and timeout (2026-09-06)

Stage remains end-to-end acceptance. The preceding turn verified cross-Runner
Redis continuity. A new real-proxy scenario held the established upstream SSE
response before its first frame: cancellation reproduced continued upstream
waiting because the prior empty-role announcement still depended on reading
that frame. This was a real integration gap, not a test-client timeout.

TaskLattice Guard now announces a content-free assistant frame before reading the
upstream iterator. Its generated `chatcmpl-guard-*` client identity stays constant
for all content/completion/usage frames; upstream identity validation is retained
separately. The announcement does not assert model success, safety or completion
and contains no upstream fields. The existing idle deadline now produces a
native 504 error frame while the SSE response remains cancellable.

The final actual Relay run passed **3 mode tests / 16 scenarios in 43.52 seconds**:
all prior safe/block/failure/cancel cases, cancellation before the first upstream
frame in all three modes, and actual first-frame timeout in full-buffered mode.
For pre-first-frame cancellation/timeout the client received zero content and
the detector was not invoked. The paused business producer closed within the
three-second assertion. **21 Provider tests passed** in 0.082s, including idle
timeout and stable client identity through numeric usage. The base image remains
`sha256:a67344ef5ab3993a9e8b07b2691578a40365639b12add3299c161f7924d0007b` with the
current overlay mounted read-only; tested `streaming.py` SHA256 is
`2beae88a3bfac69696f0af889cac073bc96889db3756a5d4ac68bd1402b4a12b`.

No external model calls, user-cluster changes, publication, image rebuild or
commit occurred. Only the TaskLattice Guard integration, its tests and related
documentation changed. This closes the established-response first-frame gap;
DNS/TLS/connection establishment before the callback is owned by LiteLLM's model
request/connection timeout configuration, not claimed covered by this test.

A concise asynchronous question requested the reviewed model-quality corpus,
acceptable false-positive/false-negative thresholds and external API budget.
Until those are confirmed, deterministic regression is not represented as
independent detection-quality evidence. Other implementation/UI and operational
acceptance work can continue; the goal is neither complete nor blocked.

## Literal custom Policy parameters (2026-09-06)

The previous answer-only planning turn made no implementation progress. This
batch resumed the custom Policy compilation audit and reproduced an actual
code/data-boundary violation: raw `${label}` substitution allowed a quote/newline
parameter to inject `$text = "safe"` into an otherwise valid declared Flow.
The real NeMo regression returned `allow` where the authored equality Policy
required `block`; merely validating declared Action references was insufficient.

The compiler now substitutes only parsed string/doc-string nodes, once, using
literal escapes that also survive NeMo's variable and expression pre-processing.
Values containing source statements, `$text`, braces, another `${placeholder}`,
quotes, backslashes, newlines and Chinese text stay data. Missing parameters and
executable-source placeholders fail compilation; comments do not require values.
Single, double and triple-quoted strings are tested against actual NeMo execution
on both Input and Output. This is not a sandbox for trusted author-written code
or a claim about model prompt-injection detection quality.

Compiler version is `tasklattice-nemo-config-v17-literal-policy-parameters`.
All deterministic test artifacts were regenerated, including the new signed
`custom-literal-parameters-v1` fixture. The Runner-only test loads that fixture
without compilation and verifies benign forwarding and rejection of the exact
parameter payload with zero model calls. Targeted compilation, recording-failure,
symbol-ownership and independent artifact execution tests: **97 passed in 9.37s**.
Upstream NeMo deprecation and synthetic backslash escape warnings remain.
No external model call, user-cluster deployment, commit or push occurred. Older
already-published artifacts were not silently rewritten; this compiler fix needs
deployment and explicit revalidation/publication before affecting them.

## Pinned custom Policy default parameters (2026-09-06)

Following the literal-parameter fix, the next lifecycle audit found a separate
Controller mismatch: `validateProgrammableBinding` accepted a required field's
Policy default, but `buildGuardrailPlan` serialized only explicit local values.
Thus a valid Policy preview could become an un-compilable Guardrail binding.
The added regression first failed with the default absent from `parameter_values`.

The Controller now materializes defaults from the exact pinned Policy version
into its private normalized plan binding, then overlays explicit local values.
An explicit empty optional value is preserved; a field without a default remains
absent. The source Policy and editable Guardrail draft are not mutated. Controller
plan version is `tasklattice-controller-plan-v8-effective-policy-parameters`.

Evidence: **26 Controller tests passed** across plan and published-payload suites.
**4 cross-language tests passed in 1.60s**, generating the actual TypeScript plan
and compiling/executing it with real NeMo for both Input/Output. They verify the
pinned banking default, explicit securities override and isolation from a newer
Policy's different default, with zero model invocations. Deterministic artifact
fixtures were regenerated for the Controller plan version change. No external
model call, cluster deployment, commit or push occurred. Broader lifecycle/UI and
live-model acceptance below remains open.

## Creation failure and offline recovery UI gate (2026-09-06)

Stage: focused UI failure/recovery acceptance, following the completed parameter
default batch. The Vibe Designing spec/domain/component/evaluator contracts were
applied to this console workflow. Scope was frozen to explicit draft creation,
persistent failure feedback, selection retention and desktop/mobile recovery,
using the existing design-contract weights and >=8/no-blocker gate. No unrelated
layout redesign or external model traffic was authorized by this audit.

Baseline: the new offline component test failed. TanStack's default online-only
mutation paused a create write and could submit it automatically on reconnect;
the sheet did not retain a local error. Creation now attempts the explicit request
without offline queuing or automatic retry. The fixed footer preserves the error
and explains that an interrupted response has an unknown creation outcome: check
the registry before retrying. Selections remain in the open wizard, and errors
reset when opening a new wizard. The duplicate toast was removed after screenshot
review showed it obscured the narrow-screen heading. No idempotency or automatic
server-side reconciliation is claimed by this change.

Verification: **10 wizard tests passed**, including failed creation with no
success callback, no reconnect write, identical explicit retry payload and a
successful retry callback clearing the error. Full UI/server build passed, and
the final UI revision's typecheck/build passed again; existing bundle-size warning
remains. `git diff --check` passed.

Fresh browser evidence used headless system Chrome in a new context against the
isolated `127.0.0.1:8092` UI. The real banking preset supplied **17 Policies** and
the actual plan preview completed. Browser offline mode plus a deliberately
aborted create request exercised failure; reconnect produced no extra create
request. An explicit retry sent the identical payload and received a synthetic
503. Both POSTs were intercepted: **no server create write occurred**. This tests
UI failure recovery, not successful deployed persistence or detection quality.
Desktop 1440x1000 and mobile 390x844 screenshots were inspected:

- `/tmp/guard-offline-browser.CSH7WX/desktop-error.png`
- `/tmp/guard-offline-browser.CSH7WX/mobile-error.png`
- Reproduction harness: `/tmp/guard-offline-browser.CSH7WX/audit.cjs`

The mobile create action measured 133.5x44 CSS px, bottom 828 within viewport844;
no document horizontal overflow or uncaught page errors. Final screenshots show
the local error/recovery instructions without a heading-covering toast. Browser
context was closed. User-facing ports38081/38082 were not touched.

Focused evaluator subchecks (each scored2/pass): Intent—explicit create and
retained task; IA—failure next to action and stable review; Craft—existing Alert/
Button tokens and readable non-overlapping error; Domain—unknown outcome wording
and no surprise reconnect write; Interaction—same-payload retry and visible44px
mobile action; Visual—existing console styling and clean heading. Six dimension
scores10; weighted10/10, no blockers **within this focused fault-handling scope**,
decision `pass`. This is not a whole-wizard release score: permission/session
expiry, successful-save reconciliation and broader advanced-authoring coverage
remain part of the complete UI matrix below.

## Product API authorization and stale session cookies (2026-09-06)

This batch followed the completed offline UI recovery work and audited the
server-side authority behind the wizard, Policy lifecycle, Model setup and
traffic/deployment controls. An explicit **55-route** administrative inventory
was tested for unauthenticated, ordinary-user and unknown-role callers, including
forged role headers and invalid bodies. All165 cases reject before protected
service work. Read-only users can still inspect the representative presets;
session expiry and role revocation are rechecked on subsequent requests.

The first matrix passed, but inspection of actual auth configuration exposed a
real gap: Better Auth's five-minute signed cookie cache could retain administrator
identity after database role demotion, session deletion or session expiry. A
second regression uses the actual `createAuth` options and real Better Auth
signing/session-cache implementation, replacing only PostgreSQL with its memory
adapter and omitting the unrelated login-timestamp DB hook. It obtains a genuine
admin session cookie, changes authoritative backing state, proves the cached
identity is still admin, then sends a publish request through the actual Hono app.
**All three negative cases returned202 before the fix and invoked the stubbed
publish service.** This was not merely a mocked authorization verdict.

Protected product API authentication now calls `getSession` with
`disableCookieCache: true`, so current database session/role state governs access.
This introduces a fresh session lookup for protected API requests; cached shell
identity can remain stale visually but cannot authorize a write. The final real
auth matrix verifies active administrator202, demoted403, revoked401 and
expired401, with no publish-service invocation on the denied paths. The public
health endpoints and Better Auth's own endpoint policy were not changed.

Focused tests: **177 passed** across the authorization matrix, Guardrail HTTP
contract and auth configuration tests. The affected HTTP surface regression then
passed **224 tests in14 files**, followed by server TypeScript checking and
`git diff --check`. No real database, provider, compile/publish
job or cluster mutation occurred; the publish boundary is a recorded test stub.
The goal remains in acceptance/convergence, not complete. Browser-specific session
expiry recovery, broader operational failover and independent live-model quality
evaluation remain open.

## Browser session recovery and identity cache boundary (2026-09-06)

Resumed implementation after a planning-only turn. Fresh baseline tests found
four failures: frontend session refresh did not bypass the signed cookie cache,
and session expiry, account switching and role changes retained resource data
from the previous authority. `getAuthStatus` now requests the current session;
AuthProvider cancels/removes non-session queries and clears mutation-cache
records before exposing a changed authenticated identity, role or enabled state.
Ordinary profile refresh for the same authority keeps resource data. Explicit
login cancels older session refreshes; cancelled late query responses cannot
restore the previous account's cached resource data. Clearing a mutation cache
does not cancel a write already received by the server or its side effects.

Controller HTTP401 and403 errors trigger identity rechecking, not write replay.
A403 with unchanged identity preserves the error/form rather than logging out;
a confirmed absent session removes the protected shell. Unsaved forms are not
retained across confirmed logout/account changes. No local-storage draft cache
or automatic recovery submission was introduced.

The focused regression passes **22 tests across4 files** (session/API recovery
plus the10 creation-wizard tests). UI and server production builds/typechecks
pass; the existing large-bundle warning remains. Browser evidence uses actual
Chrome, UI, login, saved presets and plan preview on the isolated8092 preview.
Only create responses and the revoked-session result were intercepted: a403
followed by an explicitly retried401, with identical17-Policy banking payloads.
Both create requests were intercepted, so no Guardrail write reached the server.
All8 observed session requests requested `disableCookieCache=true`. Re-login
succeeded and did not replay creation; no uncaught browser errors occurred.
This is browser failure-state evidence, not a second real database-revocation
test (the preceding server batch owns that evidence).

Reproducer: `/tmp/guard-auth-browser.yJehOM/audit.cjs`; fresh screenshots:
`forbidden-desktop.png` (1440px) and `expired-mobile.png` (390px) in that directory.
Screenshot/DOM review found a sub44px login target, corrected locally using the
existing Input/Select/Button components. Recheck measured the submit target at
350×44px with no horizontal overflow and visible focus/labels.

Vibe Designing focused release gate: intent (explicit retry), IA (error belongs
to the open form), craft (reused controls), domain (confirmed identity/cache
boundary), interaction (403 recovery,401 exit,re-login without replay), visual
(readable desktop error/mobile login) subchecks each2/2 after correction. With
the established20/20/15/25/15/5 weights the scoped score is10/10, decision `pass`;
the baseline had correctness blockers and was not given a whole-page score.
This closes this bounded recovery path only, not the entire UI permission matrix
or product release. No user-cluster deployment, external model call or commit.

## Current-state full engineering gate and completion audit (2026-09-06)

Previous goal batch was progress: frontend authority/cache recovery changes,
focused tests and browser evidence. This batch made no further feature changes;
it ran the complete current `make test` entry point once, inspected the preset,
Default and test ownership contracts, and reconciled evidence scope. The command
completed successfully (terminal exit0), not merely an observed green subset.

| Current gate | Fresh result | Scope |
| --- | --- | --- |
| Contracts |55 passed,1 skipped; protocol check, strict Helm lint and all configured template renders passed |No real Kubernetes deployment; isolated Helm lifecycle needs explicit context |
| Control-plane Python |618 passed |Real compilation/validation including preset composition, ordering, literal custom parameters and zero-model assertions |
| Controller API/UI |761 passed in112 files |Frontend and backend automated tests; not761 browser scenarios |
| Data plane |331 passed,18 skipped |Precompiled artifacts, real NeMo execution and local TCP checks; Redis opt-in cases not executed in this invocation |
| Communication/E2E |5 passed,3 skipped |Real control-channel tests; actual Relay opt-in cases not executed in this invocation |
| Typecheck/build |Passed UI/server |Existing upstream deprecation warnings and large frontend bundle warning remain |

Total: **1,770 passing tests;22 skipped** (1 isolated Kubernetes lifecycle,
6 Redis lease tests,12 cross-Runner Redis/TCP tests,3 actual Relay mode tests).
Previously recorded isolated Redis/Relay results remain historical evidence,
not fresh passes in this batch. No external model calls or user-cluster writes
were made. This run used the current local Python3.13 environment; the CI
Python3.11/3.12/3.13 matrix was inspected but not represented as freshly executed.

Requirement-to-evidence audit:

| Requirement | Authoritative current source/evidence | Assessment |
| --- | --- | --- |
| Representative banking, securities and internet presets |`controller/shared/protection-presets.ts` lists all three plus common and Singapore; real TS→protobuf→NeMo composition tests and signed preset replay pass |Implemented and locally verified; financial text references are not compliance certification |
| Default does not require external models |`controller/server/domain/defaults.ts` rejects model dependencies/custom flows;32 ordinary bindings; Default and preset tests assert zero model calls |Implemented and locally verified; no claim of comprehensive semantic detection |
| Policy identities, order and local tuning survive compilation |Current control-plane ordering, override, version and artifact checks pass |Core path verified; arbitrary programmable-flow dependency completeness remains open |
| Full optional business protection map and guided setup |Eight shared directories, five presets; prior browser acceptance plus current UI tests |Implemented; complete advanced authoring/permission matrix not proven |
| Input/Output enforcement with checked streaming |Frozen artifact and TCP suites pass; complete-response split tests release no prefix and agree with whole output |Locally verified; final target deployment behavior still requires deployment evidence |
| End-to-end1:1 regression |Prior isolated HTTP/proxy reports pin versions and inspect client bytes; opt-in harness exists |Historical isolated engineering evidence, not current production acceptance |
| Actual detector quality |Reviewed holdout runner exists and its accounting tests pass |Not achieved: independent corpus/threshold review, API budget and actual model run pending |

The default is `full_buffered` because its PII transformations require complete
output. Checked incremental delivery releases an approved window while retaining
configured context; it cannot recall earlier output or promise full-response
semantic equivalence. Full buffering releases nothing until the complete answer
passes/transforms, trading higher first-content latency for whole-answer checks.
The product must keep this distinction visible rather than describing all modes
as identical protection.

Completion decision: **not complete**. Continue with the explicit open lifecycle
and operational gates, then reviewed live-model evaluation and final handoff.
Do not repeat the full gate without affected code/contract changes merely to
generate another status report. No commit/push or deployment is implied.

## Declared safety-model dependency prewarm gate (2026-09-06)

Fresh source inspection found that custom Policy `evaluation_contracts` were
included in the signed dependency manifest, but runtime readiness checked only
explicit `GuardEvaluateAction` bindings. A custom Policy could declare a required
model contract as its second contract and pass a benign validation branch without
that model being configured. Six real production-compiler/NeMo Validator cases
reproduced this: semantic PII, content safety and jailbreak, each Input/Output,
all incorrectly returned `passed` with only local providers.

`NeMoRuntimeRegistry._validate_bindings` now enforces the declared known safety
contracts against exact `(capability, contract)` evaluator routes before NeMo
construction. All declared entries are checked, not just the first binding
contract; local PII cannot substitute for semantic PII. Missing routes raise an
explicit `PlanCompilationError` naming the missing contracts during prewarm.
The existing control-client validation error path sends `accepted=False` and
FAILED with that reason. No artifact format or compiler output changed.

Verification: **68 focused tests passed** in three bounded commands:12 new
control-plane missing/configured cases,3 independent data-plane manifest checks,
existing artifact execution/capability validation, all five presets plus nine
extended local Policy compositions, the full Default regression and suite-boundary
checks. Configured-route controls use an evaluator that raises if called: they
prove dependency registration is enforced without fabricating a model-quality
result or invoking a model on an unrelated branch. The data-plane tests load a
frozen config and exercise additional dependency validation in isolation; they
do not claim modified unsigned metadata passed signature verification. Default
retains all321 composition cases and140 frozen legacy replays with zero model
invocations, as asserted by the existing tests. `git diff --check` passed.

This is a concrete dependency-enforcement fix, not complete static analysis of
arbitrary Colang. Other contract families, arbitrary external Actions and dynamic
dispatch remain subject to the explicit gap audit; no broad local/healthy label
was added. A declared dependency establishes a required route, not evidence that
every input exercises it or that the remote model is currently healthy. No UI,
database, user cluster, published artifact or provider credential was changed;
Runner deployment is needed for this runtime check to affect existing instances.

## Dedicated evaluator dependency gate (2026-09-06)

The previous batch was concrete progress (six reproduced missing-route failures
and safety-model prewarm checks). This continuation inspected the other configured
model implementations and reproduced six additional false passes: custom source
declaring semantic topic/company-policy on Input/Output, contextual grounding on
Output, or automated reasoning on Output could pass its benign branch with only
local providers. None of those branches made a model call, which is why observing
executed tests alone could not establish declared dependency availability.

Runtime prewarm now checks those four stable contracts against the dedicated
version1 Action provider and advertised capability. Regression controls cover
missing providers, wrong capability, wrong version and a correctly registered
provider. Native NeMo Topic Safety remains a separate implementation: when the
signed artifact explicitly requires its native topic model, the existing native
model manifest/profile/materialization checks own readiness instead of requiring
a redundant custom Guard Action. The real IORails local-HTTP test now includes
the explicit topic declaration and still checks on-topic allow, off-topic block,
malformed output fail-closed, bearer forwarding and exactly three model requests.

Fresh bounded gate: **70 tests passed in7.36s**, covering declared contracts,
independent frozen-config dependency checks, native Topic Safety, dynamic model
configuration, evaluator routing and test-suite boundaries. The missing-provider
baseline had six failures. Combining the new plane-specific test files also
revealed a pytest basename collision: the data-plane file is now
`tests/data_plane/test_declared_model_artifact_dependencies.py`. Whole-suite
collection then completed successfully; collection is not counted as execution.
`git diff --check` passes. No compiler output, signed fixture or deployed instance
was changed, and no external model endpoint was called.

This extends declared dependency availability, not model health/quality or
complete static/dynamic analysis of arbitrary custom source. The full local gate
above predates these runtime changes; this entry records the affected fresh gate
rather than presenting its historical whole-suite count as current. Arbitrary
external Actions, unknown contracts and runtime required-context coverage remain
subject to the final lifecycle audit. No UI redesign or new product category.

## Direction-scoped model dependency readiness (2026-09-06)

The previous dedicated-provider batch changed runtime dependency enforcement and
passed70 targeted tests. This batch found a related directional gap using actual
Controller-style model configurations and the production Provider factory:
Input-only content safety could satisfy a declared Output dependency, and vice
versa, whenever the reviewed custom-flow test did not call the model. Both
negative baseline cases incorrectly passed; matching-direction controls passed.

`SafetyModelEvaluator.supported_rails` now derives availability for each exact
capability/contract from assigned provider rail scopes. `EvaluationActionProvider`
exposes directional route keys and uses them when dispatching. Runtime prewarm
checks explicit Action bindings against those keys, and checks custom declared
contracts against the phases of that Policy's actual compiled bindings. It does
not union all Guardrail phases, so an unrelated local Output Policy does not force
an Input-only model dependency to gain an Output assignment. Dedicated Action
providers are also checked against their advertised rails; the native Topic
Safety exception is limited to Input declarations and retains existing model
manifest/profile/materialization verification.

Fresh checks:65 focused tests first passed (declared dependencies, evaluator
routing, dynamic configuration and native Topic Safety), then57 focused cases
passed after adding unrelated-Policy controls and independent frozen-config
direction checks. These overlap and are not summed as unique tests. Finally,
**the complete `make test-data-plane` gate passed342 tests with18 environment-gated
Redis skips in58.70s**. This gate includes frozen presets and local TCP stream
tests; no compiler/Validator was imported by the new data-plane tests. The test
suite boundary gate and `git diff --check` pass. No external models were called;
configured dependency controls expressly forbid model calls in their benign
branch. No compiler output, signed fixtures, UI or deployed processes changed.

This proves directional readiness checks for the exercised assignments, not
remote callability/quality or universal custom source dependency inference. The
whole-product acceptance gaps below remain. The previous full `make test` count
predates this code; only the data-plane full gate and scoped control-plane checks
are refreshed here. Runner rollout is still necessary to apply this change to a
deployed environment.

## Refreshed Redis handoff and actual Relay acceptance (2026-09-06)

After the directional dependency changes, the previously environment-gated
checks were executed against isolated local resources. The actual Relay suite
passed **3 tests in45.65s**, exercising16 scenarios across interruptible,
window-buffered and full-buffered delivery: safe content, blocked content,
detector failure, cancellation before/after delivery, and full-buffered first
frame timeout. Tests used the production Relay image with the current sibling
overlay mounted read-only, a real TCP Runner, signed frozen artifacts and a
synthetic HTTP/SSE upstream. The image was already local; no pull or external
model call was made.

Relay image: `sha256:a67344ef5ab3993a9e8b07b2691578a40365639b12add3299c161f7924d0007b`.
Mounted `streaming.py` SHA256:
`2beae88a3bfac69696f0af889cac073bc96889db3756a5d4ac68bd1402b4a12b`;
`tasklattice_guard.py` SHA256:
`ee8d90058ae5dd772b8331349d74c0ab91e2da2a5fc644c99fdbe5fa755a23af`.

The dedicated Redis gate passed **18 tests in10.96s with no skips**: six lease,
cancellation and concurrency checks, plus12 real TCP replica-handoff cases
(three delivery modes times safe, blocked, failure/retry and expired context).
The primary Runner stops after the initial sequence; the secondary continues
using shared Redis state and the pinned artifact identity. The original Redis
invocation's terminal result was unavailable after output truncation; after
confirming no matching process remained, this bounded gate was rerun to obtain
the authoritative result above. No unavailable result is counted as a pass.

Redis used image
`sha256:9a56851f1a97e0586f85f8d7f7652e65cb589b2409d965c5d6e275dfc2551907`,
an ephemeral loopback port, no persistence and no user database. Task-owned
containers were cleaned up after testing. User ports38081/38082, the cluster and
the separate UI preview were untouched. The only test warnings were upstream
NeMo `nim_url` deprecations.

This refresh closes the environmental skips for these specific21 tests on the
current runtime. It is not a fresh whole-product `make test` run, Kubernetes
eviction/load-balancer evidence, or an independent model-quality evaluation.
Synthetic detector results verify enforcement and exact client-visible release,
not recall against previously unseen prompt-injection attacks. Full-buffered
blocked/error cases released zero content; incremental modes retained already
approved prefixes and cannot recall them.

## Selected-Policy dependency manifest boundary (2026-09-06)

The previous goal turn completed real Redis/Relay environment checks. This
continuation reproduced a compiler defect at the local-baseline boundary:
unselected Policy snapshots were excluded from executable source, but their
Actions, evaluation contracts and prompts still entered the signed dependency
manifest. Thus a retained, unselected remote-model Policy could make an otherwise
local Guardrail fail runtime readiness. The negative compiler test failed on the
unexpected unused dependencies before the fix (an initial test-code key typo was
corrected before establishing that baseline).

The manifest now includes Policy-owned dependencies only for exact Policy/version
identities selected by the plan or its compiled Action bindings. Selected
dependencies remain mandatory; nothing is silently downgraded. A real compiler
and Validator pair verifies both an unselected content-safety Policy (local
benign case passes with zero model calls) and the same selected Policy (missing
model dependency rejects validation). The compiler identity is now
`tasklattice-nemo-config-v18-selected-policy-dependencies`; all15 deterministic
signed fixture bundles were regenerated and the generator's `--check` passed.

Fresh verification:

- 68 focused custom-source/dependency tests passed in5.31s.
- The complete Python control-plane gate passed **665 tests,424 deselected,
  no skips, in73.33s**. It includes Default, preset composition, ordering,
  compiler/Validator and model-dependency coverage. The68 focused cases overlap
  this total and are not added to it.
- 23 independent frozen-preset/dependency/suite-boundary tests passed in35.51s.
  The five preset manifests contain599 adapter replay cases and272 Output cases
  checked both whole and split across chunks with the regenerated artifacts.
- `git diff --check` and deterministic fixture freshness pass. Existing upstream
  NeMo deprecation and literal-fixture escape warnings remain.

No UI or cluster was changed, no commit was made, and no external model was
called. The previous full-product and actual-Relay results predate this compiler
identity; they are retained as historical evidence, not relabeled as runs on the
new artifacts. This closes accidental dependencies from unselected snapshots,
not universal dependency inference for arbitrary programmable Policies.

## Nonempty grounding context enforcement (2026-09-07)

The previous selected-Policy manifest fix was concrete progress. This batch
reviewed request-time prerequisites for the existing Output grounding detector.
It reproduced six false-safe cases: an empty, ASCII-whitespace-only or
Unicode-whitespace-only query/source block satisfied the presence check and
reached the judge. A synthetic positive judge response then yielded `safe`
despite the missing evidence. Truly absent blocks already returned `uncertain`.

Grounding now requires at least one nonblank query and one nonblank source before
making a model request. Empty blocks do not contribute evidence or source IDs;
nonempty content is preserved rather than trimmed or rewritten. Missing evidence
retains the established `uncertain`/`clarify` behavior instead of claiming a
detected factual violation. Real Controller catalog plan generation, compilation
and NeMo execution verify that absent/empty/blank sources replace the original
answer with a clarification response and perform zero model calls. A nonempty
control still invokes the judge once and permits its synthetic safe result.

Fresh bounded gate: **24 tests passed in3.54s** across nine direct runtime Action
cases, four real Controller/compiler/NeMo cases, dynamic model configuration and
suite boundaries. No data-plane test imports the compiler or Validator.
`git diff --check` passes. The only warnings were upstream NeMo deprecations.
The first runtime test expected `block`; inspection showed the intentional
`transform`/`clarify` contract, so its assertion now checks that contract and the
absence of the original answer, without changing established enforcement.

No external model was called, no signed artifact/schema changed and no deployed
Runner was restarted. This establishes nonempty context prerequisites and
enforcement plumbing, not the truthworthiness of supplied documents or model
factuality accuracy. No whole-product gate or live-model quality run is claimed
for this patch; arbitrary custom-flow context inference remains separate.

## Baked Relay image acceptance and release runbook (2026-09-07)

The previous grounding-context batch was progress. While preparing the final
acceptance procedure, this batch found a packaging evidence gap: the historical
Relay E2E test always mounted current source over its image. Inspection of the
existing image found stale `streaming.py` and `tasklattice_guard.py`; the other
three Python files matched. Thus a passing mounted-source test did not establish
that the previously built image contained the latest fixes.

`GUARD_TEST_RELAY_BAKED_IMAGE=1` now verifies the image's entire TaskLattice Guard
Python-file hash map against the current sibling overlay, then runs without a
source-code mount. It reports `relay_code_source` alongside the immutable image
ID. Its read-only, no-network preflight uses the module search path without
importing LiteLLM. The old image failed this new gate before any proxy workload
started, identifying exactly the two stale files. Default developer mode still
supports the explicitly reported read-only source mount.

A new local test image was built from the existing local base with only the
authorized TaskLattice Guard integration copied into `/app/litellm/proxy/guardrails/guardrail_hooks/tasklattice_guard`.
No image was pulled or pushed and the old tag was not overwritten. The build
context was restricted to that integration directory, not either repository or
its credentials. Build recipe: `/tmp/guard-relay-image-acceptance.mc68fI/Dockerfile`.
New tag: `tali-litellm:protection-productization-baked-20260907`.
Image ID: `sha256:50b12c8bbaee16c0677b145bcbebd5198758e42ca8fe18ab6a6669ab562f0e60`.

The new **baked-image E2E gate passed3 tests /16 scenarios in44.91s with no skips**,
using current v18 frozen artifacts and the current real TCP Runner. All five
baked Python files passed the source-hash comparison. Full-buffered unsafe/error
cases released zero body text; both incremental modes retained only their
already checked prefixes. Cancellation and first-frame timeout passed. This is
not a rebuild/audit of every dependency in the Relay base image, a cluster rollout,
or a real-model quality result. Synthetic HTTP/SSE model responses remain explicit.
Temporary proxy/probe containers were removed; the new image is retained locally
for the next authorized deployment/replay.

`docs/protection-acceptance-runbook.md` now provides the ordered candidate freeze,
engineering gates, persisted five-preset/Default lifecycle, final-client proxy
replay and independent live-model acceptance procedure. It documents exact
environment inputs, retained-record writes, budget boundaries, source-versus-image
evidence and Input-only versus Output injection coverage. The three referenced
Node entry points passed syntax checks, and the holdout entry's actual `--help`
was checked without making calls. This is an executable procedure, not a claim
that all of its deployment/live-model stages ran this turn. `git diff --check`
passes. No full suite was rerun and no user-cluster or external-model changes
were made.

## Refreshed candidate engineering gate (2026-09-07)

The previous goal turn found stale baked Relay files, produced a corrected local
image and passed its16 real-proxy scenarios without a source-code mount. This
turn made no runtime/UI changes: it ran the whole engineering entry point once
after the recent compiler and grounding changes. `make test` completed with
terminal exit0, not a partial or still-running result.

| Gate | Current result | Scope |
| --- | --- | --- |
| Contracts |55 passed,1 skipped in8.62s |Protocol generation, suite boundaries; strict Helm lint/render checks also passed; Kubernetes lifecycle not run |
| Control-plane Python |669 passed in72.95s |Includes real Default/preset composition, v18 compilation, selected dependencies and grounding-context checks |
| Controller API/UI |761 passed in112 files,17.43s |Automated API/component tests; not761 independent browser scenarios |
| Data plane |351 passed,18 skipped in59.03s |Independent frozen artifacts, current runtime and TCP tests; dedicated Redis environment absent in this invocation |
| Communication/E2E |5 passed,3 skipped in1.39s |Control channel executed; Relay image opt-in not supplied to this invocation |
| Typecheck/build |Passed |Both UI and server typechecking/production builds |

Total: **1,841 passed,22 skipped**. The skip list remains1 explicit Kubernetes
lifecycle test,18 Redis-dependent cases and3 Relay mode tests. The previous
isolated Redis and baked-Relay runs remain separate dated evidence; they are not
silently counted as executed inside this command. Local Python3.13 was exercised,
not the entire CI interpreter matrix. Upstream NeMo/Node warnings, synthetic
literal escape warnings and the existing large frontend bundle warning remain.
`git diff --check` passes.

The five preset source definitions still compose the common local baseline with
banking, securities, internet or Singapore reference Policies. Default's generator
still rejects model dependencies and selects full buffering for its complete-value
transformations. Those facts are backed by the current control/data-plane gates,
not inferred solely from the green build.

Completion remains **unproven**, especially for actual target-environment rollout,
independently reviewed guard-model quality and real business-model generation.
`docs/protection-acceptance-runbook.md` names the required environment, credentials,
identity and budget inputs. Do not start external calls without those inputs or
reuse an old deployment report as current release acceptance. The broader custom
authoring/lifecycle limitations below remain explicit; this run does not erase
them. No commit/push, cluster write or external-model invocation was made.

## Authorized isolated live smoke and response replay (2026-09-07)

Following explicit user approval, reused isolated Controller8093, Runner8094,
UI8092 and PostgreSQL55439. No user cluster or38081/38082 service was changed.
Created two clearly named recorded-smoke Providers and four Models in this test
database. Credentials stayed in a loopback-only recording gateway; Controller
stored only the test gateway credential. The gateway is now offline-only.

Actual outbound request count: **23**, under the200-request cap, including two
catalog reads, connection/probe calls and upstream SDK retries. Complete raw
synthetic responses are retained privately in
`/tmp/guard-protection-preview.CMncHZ/model-response-round-20260907.sqlite`.
Seven portable response fixtures are added under `tests/fixtures/model_responses`.

Candidate source HEAD: `5218bcf5aa57d9ba962183624f9a874cf4946135` (plus this
recording/replay tooling and documentation change). The round returned14 HTTP200
responses and9 HTTP500 responses; the latter include native SDK retry attempts,
not nine independently chosen attack samples. The gateway performed no retries.

Verification after adding the replay fixtures: new focused tests18 passed;
full `make test-data-plane`369 passed,18 Redis-dependent skips in62.26s;
test-suite boundary contracts2 passed; `git diff --check` passed. The six new
artifact/stream cases cover safe/unsafe captured Output classifications across
full-buffered, window-buffered and interruptible modes. They prove execution
against recorded replies, not live partial-window model quality. No compiler is
invoked by these data-plane cases.

| Check | Observed live result |
| --- | --- |
| DeepSeek `deepseek-v4-flash` | Actual call and generic-chat probe passed; not a full authoring quality test |
| NVIDIA Safety Guard8Bv3 Input | Benign allowed, unsafe blocked through real NeMo Rail |
| NVIDIA Safety Guard8Bv3 Output | Benign allowed, unsafe blocked through real NeMo Rail |
| NVIDIA Topic Control8B | HTTP500 TensorRT/CUDA illegal memory access; Rail validation failed, not a successful attack block |
| NVIDIA JailbreakDetect | Callable; benign allowed, but the current synthetic instruction-override attack also allowed; Rail validation correctly failed |
| Qwen3Guard | Not exercised: no separately supplied endpoint |

Switching the gateway to offline replay reproduced all five Controller-to-Runner
validation results, including both failures, without increasing the23-call count.
No failed model configuration was activated or represented as production-ready.
This is a small engineering smoke round, not independent holdout accuracy, full
business-model response generation or complete release acceptance.

Two integration findings were retained rather than silently changing product
behavior: fresh single-assignment Save returned409 `model_configuration_changed`
even without competing writes (timestamp precision in the optimistic-lock path
needs investigation); existing whole-draft Save allowed testing to continue.
Provider registration attempted the first discovered NVIDIA model `01-ai/yi-large`,
which the approved recording allowlist correctly denied without an external call.
After registering Safety Guard, the existing Provider validation action tested
that approved model successfully. Neither finding was patched in this test task.

## Fresh model-draft Save conflict fixed (2026-09-07)

The live-round409 was reproduced against real PostgreSQL: a stored timestamp
`2026-09-07T00:00:00.123456Z` becomes `.123Z` in JavaScript, so the old equality
predicate matches no row even without a concurrent writer. The same issue affects
single-assignment validation and whole-draft validation. Millisecond equality can
also miss a genuine concurrent update.

Model-draft snapshots now carry an internal PostgreSQL `xmin` token. Single and
whole saves/validations require both the unchanged row version and draft state;
public revision payloads do not expose this token. No schema migration or timestamp
rounding workaround is needed. This change does not waive conflict detection.

Real PostgreSQL regression:6 passed in a newly created, isolated temporary schema;
structures only were copied, and the test schema was removed afterwards. Cases
cover fresh creation, the exact microsecond failure, both validation paths, and
both stale validation paths with a concurrent write retaining `updated_at`.
Existing server suite516 passed; Controller/UI typecheck passed. No external
model requests were made. The isolated Controller8093 was restarted with the fix.
The Topic Control upstream500 and JailbreakDetect observed miss remain unresolved;
this configuration fix does not turn those results into a passing release gate.

## Recorded jailbreak miss against no-model presets (2026-09-07)

Candidate HEAD `e399861ab0562000ecfe2aa3f9b1caa471309033` plus this regression test.
Replayed the exact benign/classifier-miss inputs from recorded calls22/23 against
the signed `default-local-v1` artifact and all five signed business-preset
artifacts. Every local release allowed the benign input and blocked the attack:
12 tests passed. Each decision recorded zero model invocations and no fail-closed
infrastructure error; unsafe findings contained Policy/Rule identities belonging
to the selected release. HTTP clients were explicitly forbidden, and the signed
desired states contained no model runtimes or bindings.

This demonstrates complementary local protection for this exact instruction
override/extraction pattern, not general jailbreak detection quality, semantic
topic enforcement, or automatic fallback from a failed model. The dedicated
classifier's observed false negative remains a failed model-quality result.
No Policy, threshold, exclusion, model assignment or fixture artifact was changed
to obtain this result. No external API calls or deployment mutations were needed.

## User-authorized synthetic Topic Control endpoint (2026-09-07)

The user explicitly authorized mocking Topic Control while NVIDIA is down.
Added `scripts/mock_topic_control.py` and a separate synthetic fixture map, without
modifying the previously captured NVIDIA500 responses. This endpoint has no
external-model client, binds127.0.0.1:8098, and exposes catalog discovery plus the
OpenAI chat envelope. It matches exact user text and scoped system markers; unknown
or ambiguous inputs return409. HTTP500, timeout and invalid-verdict modes are
explicit test scenarios, not fabricated provider health.

Registered `MOCK ONLY - Topic Control 20260907` and model
`mock/nemoguard-topic-control` in isolated Controller8093. Saved only the
`topic_control.input` binding and validated it through the connected Runner.
Provider/model call checks and both semantic-topic/company-policy Rail contracts
passed:6 matched local requests,0 unmatched,0 external calls. Other assignments,
including their existing failures, were preserved. Global validation remained
false; no global model activation or user-cluster change was performed.

Added the signed `topic-control-native-v1` fixture (compiler v18, NeMo0.24,
`iorails_native`, checksum
`d04b2a9aa72128a20f467db566d71faf47b92d5c03fc3eabfc57a4494d8b07bc`).
Ten focused endpoint/runtime tests passed, including real TCP model transport,
safe/off-topic execution and distinct fail-closed handling for unknown input,
HTTP500, timeout and malformed output. Fixture freshness and two test-boundary
contracts passed. These tests do not invoke compilation in the data-plane suite.
Full affected data-plane gate:391 passed,18 Redis-dependent skips in59.96s.
All16 signed fixture bundles passed generator freshness checks. The retained
loopback Mock reported6 matched requests and0 external calls after verification.

This removes NVIDIA availability as a blocker for Topic Control engineering
regression. It does not demonstrate real topic-classification accuracy, certify
arbitrary conversations, repair the real service or replace independent model
quality acceptance. See `docs/testing.md` for restart/configuration instructions.

## Isolated activation gate regression (2026-09-08)

Extended the real PostgreSQL model-configuration suite from6 to9 tests using
only randomly named temporary schemas. Successful validation starts activation
with one generation/outbox event; sequential duplicate activation is rejected.
An unrelated failed assignment remains failed after another assignment passes,
and cannot be activated. Editing a validated immutable snapshot produces a new
draft requiring fresh target evidence. The previous validated snapshot is not
silently modified. All9 tests and Controller/UI typechecking passed. These tests
use synthetic Rail-validator results and do not claim concurrent activation race
coverage. No production activation code or external Provider was changed/called.
The retained Topic Mock health endpoint still reported6 matched requests and
zero external calls. No preview draft was globally activated.

## Consolidated candidate gate after Topic Mock (2026-09-08)

Ran `make test` once against Guard HEAD
`e399861ab0562000ecfe2aa3f9b1caa471309033` plus the current uncommitted Topic
Mock, signed Topic artifact/generator, local-baseline recorded-attack tests,
runtime-test helper and PostgreSQL activation-gate tests. Relay HEAD remains
`3e6ade3590cbc1561ee15fa378bd996d774af4be` with its existing dirty LiteLLM
integration/build/test changes; this command does not deploy either checkout.

| Gate | This invocation |
| --- | --- |
| Contracts |55 passed,1 Kubernetes opt-in skip |
| Python control plane |669 passed in74.12s |
| Controller API/UI |761 passed,9 PostgreSQL opt-in skips,20.29s |
| Data plane |391 passed,18 Redis opt-in skips,63.38s |
| Communication/E2E |5 passed,3 Relay-image opt-in skips,1.51s |
| Build checks |Protocol/16 signed fixture freshness, strict Helm lint/render, UI/server typechecking and production builds passed |

Total **1,881 passed,31 skipped**; exit0. The separate same-day PostgreSQL run
above passed all9 tests; it is not included in this total. Earlier isolated Redis
and baked-Relay evidence remains separately dated, not silently counted here.
Warnings remain for NeMo's deprecated `nim_url`, deliberately escaped Policy
literal test strings, Node's localStorage flag, and the large UI bundle. No real
Provider round, user-cluster deployment or activation was performed. This is a
consolidated engineering gate, not independent detector-quality acceptance.

## Explicit remaining gaps

This is a historical gap snapshot. Use C1/U1/Q1 in the
[current completion audit](protection-completion-audit.zh-CN.md) for actionable
remaining work. In particular, the live-model round, selected-only/directional
dependency gates, activation/ACK races and bounded streaming checks below have
subsequent evidence; do not repeatedly treat them as unimplemented. The audit
does not waive arbitrary-flow completeness or whole-desktop/quality evidence.

- Canonical action/dependency lifecycle alignment. Policy-owned literal phrase
  configuration is implemented and verified above; custom programmable Policy
  declared contract projection and statically named source-reference compilation
  gates and static symbol-aware linking are now aligned above, but complete
  dependency enforcement/dynamic dispatch for arbitrary flows and older nonempty
  anonymous-draft migration remain explicit gaps.
- Wizard per-direction assignment evidence and focused AI recommendation
  eligibility and latest published custom recommendation metadata are implemented
  above. Pinned-older-version binding metadata and inspection are implemented;
  the real pinned custom publish/execute acceptance path is now verified above.
  Representative business-preset creation now has real UI/save/validation
  evidence. Custom published category projection and explicit author selection
  of all eight business directories are implemented and verified above; the
  remaining complete UI permission/offline/advanced-authoring matrix remains.
- Health now separates published coverage, configured model bindings, draft
  validation and fresh/converged serving evidence. Extend canonical dependency
  metadata beyond the custom declared lower-bound requirements now projected
  above. Arbitrary flows still correctly retain unknown completeness. Runtime
  summaries preserve capacity/convergence reasons instead of claiming a missing
  capability; broader custom-dependency enforcement remains outstanding.
- Operational deployment/failover checks beyond the verified direct-Runner
  handoff and three-mode proxy scenarios above, live guard/business model evaluation and final
  operational handoff remain. The verified banking full-buffered proxy leak and
  synthetic-completion defects above are fixed, not deferred.

## Completion audit: preset preview versus applied selection (2026-09-08)

The previous goal turn was concrete progress: the authorized expanded real-model
round completed with durable recordings, actual main lifecycle/routing evidence,
and cleanup. This turn re-read the objective, stage contract, current preset
definitions, dependency prewarm code, test contracts, and sibling Relay diff.
Five presets still compose real pinned Policies; the common baseline remains
shared and model-free. No generic Relay Router change was introduced.

A fresh main `tali` desktop audit found a remaining semantic error, also noted
in an older audit: before Apply, the template preview said "已选择 10 项" while
the actual stepper correctly said unselected. `ProtectionPresetPicker` now uses
"包含 / 未包含" (`included / Not included`) only in the preview. Actual selected
counts and application feedback retain their existing wording and behavior.
No binding, Policy, model assignment, order, or release contract changed.

Regression first failed on the old preview. After the correction, 34 targeted
wizard/order/detail tests passed; typecheck and production build passed. A
separate fresh 62-test gate covered all five presets and extended local Policies,
capability validation, Rule overrides, ordered execution, and independent
declared-model artifact dependencies. These are scoped fresh runs, not a new
full-suite or live-model run.

Controller `dev` was rebuilt and rolled out in `tali` only. Verified image:
`sha256:25dad29873ba7eb341e4a01f6d3b82be95ea67d88e74cbb2e3e0938bc37f53bc`,
UI asset `index-C-Qmz8vz.js`; no Runner rebuild or model/Default configuration
change. The fresh Chinese desktop page verifies: bank preview says included
with no selected steps; Apply marks 17 Policies selected; previewing Internet
shows its 20 included Policies but preserves the bank's actual selections and
clears the old application feedback. The temporary tab was closed without
saving any Guardrail. No real model calls occurred this turn.

Vibe Designing evaluation is limited to this preset-preview state transition,
not the whole UI. Using the existing 20/20/15/25/15/5 weights and >=8 threshold:
intent (optional template, explicit Apply), IA (preview separated from stepper),
craft (existing count text/layout), domain trust (included != selected),
interaction (Apply updates; changing preview preserves choices), and visual
readability (fresh rendered desktop screenshot) each passed its one scoped
subcheck at 2/2. Weighted score 10/10; no blocker within this changed scope;
decision `pass`. This does not certify unexercised advanced-authoring, offline,
or complete accessibility states. Mobile remains explicitly excluded.

The remaining-gaps section above is not evidence that its broad items are all
still broken: declared/directional dependencies, selected-only manifests,
activation races and bounded streaming now have later successful tests. Full
goal completion still requires mapping those broad custom-flow/UI/production
quality claims to their exact current evidence; do not silently replace this
audit with either blanket "all complete" or a replay of outdated blockers.

### Desktop gate increment: inherited Rule action (2026-09-08)

Vibe Designing bounded revision: one semantic correction for business/platform
owners editing a Guardrail in the existing product console. Preserve Policy and
Rule order, action precedence, optional map and draft-not-publish boundaries;
reuse the existing Select, labels and dimensions. No mobile scope.

Baseline fresh desktop evidence showed a Passport Policy overridden to reject
while its inherited Rule showed redact, and an indistinguishable default versus
explicit redact option. The compiler already used Rule override > Policy
override > Rule default. The editor now names the inherited/default option and
reflects that same precedence, including configured-phrase actions. No runtime
action or allowed action was changed.

Using existing weights 20/20/15/25/15/5, one scoped subcheck per dimension:
intent (edit a local override), IA (same Policy/Rule location), craft (existing
Select), trust (accurate inherited action), interaction (distinct reset versus
explicit override), visual readability (fresh 1366x900 screenshot). Baseline
scores 2/2, 2/2, 2/2, 0/2, 1/2, 2/2 yielded 6.75/10 with a domain-trust blocker.
After the correction all six scoped subchecks passed at 2/2: 10/10, no blocker
within this narrow scope, decision pass; stop the bounded revision here.

Evidence: 66 tests across editor, wizard, detail, workspace and plan; typecheck
and production build passed. Browser verified default, Policy inheritance,
explicit Rule override, reset, clearing Policy override, Escape/focus return,
no document horizontal overflow and no console errors. Review still shows
20 Policies, 50 Rules, full buffering and draft-only creation. No draft saved.
Controller dev image 2775d9b0b8ede0dcbbe04d36612697fc87aed839ac8ebc1791b9da5025342c83
was deployed to tali, UI asset index-CbwDsXU_.js verified. No real API calls.
This is not the consolidated whole-product U1 release gate or Q1 quality signoff.

### Compiler gate increment: literal Flow lifecycle targets (2026-09-08)

Ordinary Policy Flow specs were linked, but the equivalent static flow_id in
NeMo lifecycle events was neither linked nor checked for Policy ownership.
The six lifecycle events now use the same local declaration set and namespace;
both classic and simple named argument syntax are covered. The change does
not rewrite business strings or claim arbitrary interpolation is static.

Compiler v20 and 18 fresh signed fixtures include custom-flow-events-v1,
which exercises two same-named helpers with ordered redact then reject.
The Runner-only tests load frozen signed bytes: Input/Output ownership and
full-buffered HTTP streaming, without calling the compiler in the data plane.
110 focused checks and 1234 complete Python checks passed (22 conditional
skips). Actual deployed container execution confirms both directions with
zero models. Runner dev digest is
2d45841ab87112022860a06ebb02dbb86c03b80f8ed2ad06fcf3a29e3810d6f4 in tali;
both pods ready with two prewarmed versions, synchronized generation 30.
Dynamic expression/event-object dependency completeness remains C1, not a
completed guarantee. No new live API calls or Git commit.
