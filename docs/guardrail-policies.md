# Guardrail Policies and Validation

A Policy defines versioned checks, actions, and test cases. A Guardrail composes
Policies into the protection configuration assigned to application traffic.
Validate the current draft before publishing an executable version; deployment
readiness is a separate step. See [revision lifecycles](revision-lifecycle.md)
for publication and rollback.

## Default protection and model requirements

The Default Guardrail explicitly selects **124 Rules across 14 Policies**: two model
Policies and 12 local Policies. Additional capability Rules remain opt-in.
It requires compatible, validated assignments for `jailbreak.input`,
`content_safety.input`, and `content_safety.output`. The Jailbreak binding may
use the dedicated NemoGuard JailbreakDetect profile or another supported
Jailbreak profile; the baseline does not hard-code a vendor or credentials. The authoritative selection is in
[defaults.ts](../controller/server/domain/defaults.ts). Focused Policies cover
credentials, payment data, tax/health/government identifiers, contact and
network data, harmful phrases, and prompt/code injection. Selected Rules retain their matching behavior,
actions, Rail scope, and inherited test cases; Default owns their composition
order and reviewed test expectations. On newly compiled versions, local Block
checks run first; independent `builtin-jailbreak` and `builtin-content-safety`
checks can run together on Input.
Content safety also runs on Output. Models see the
original content before local redaction. A blocking verdict stops the chain.
Missing required bindings reject runtime preparation; an unavailable or malformed
model response fails closed and is recorded as an error, never a successful detection.
Model support alone does not establish accuracy or multi-turn coverage; those
remain properties of the configured model/profile and its measured behavior.

The older mixed `Baseline PII Protection`, `Pattern Matching`, and advanced PII
collections have been replaced in Default by focused bindings. Local checks
provide format/context screening, not exhaustive semantic protection. Default
uses `full_buffered` output delivery because its transformations require the
complete response.

## Topic and company business boundaries

`builtin-topic-safety` is the single model-backed Topic Control Policy. It retains
the independent `topic/denylist` and `topic/allowlist` Rules; both resolve through
`topic_control.input`. Denied tasks block first. Strict Allowlist mode also blocks
unlisted tasks; permissive mode allows tasks outside either list. Allowed and
denied tasks belong to the Policy binding, including company-specific boundaries.

The separate Company Policy, model binding and evaluation contract are removed
without aliases or configuration migration. Recreate any old Company Policy
configuration using Topic Control and validate it before publication.

## Capability catalog and regional/industry Profiles

The Policy Library presents named regional, compliance and industry sets alongside
the shared capability Policies in one searchable catalog. Jurisdiction and framework
filters apply to both. Sets use enabled database Profiles and show only their selected,
versioned Rules; viewing or applying a set does not create another detector definition.
Capability tags describe discovery coverage, while a set's scope comes from its own
regional and framework metadata. All catalog entries share one list, card and three-tab Policy inspector (Policy, Test Cases, Compliance); labels drive discovery. The inspector lists Rules directly, without nested source Policies. Test Cases include only enabled stages and complete selected Rule coverage; compliance references retain only selected Rule IDs from matching versions. Storage reuse does not introduce another product hierarchy.

The current catalog has **26 Policies and 223 Rules**, consolidated from 64 Policies
and 405 Rule declarations. Policies own detection capabilities: content safety,
injection, credentials, payment data, government identifiers, passports, contact
and network data, sensitive/risk terms, fraud, data use, advice, and high-risk
practices. The 14 consolidated local packages use version `1.0.0`. Native model
Policies and configurable text/code filters keep their independent contracts.
Child Safety is one Rule inside Local Content Safety, not a separate Policy.

The 14 Profiles select current capability Rules for regions, languages and
industries, including Singapore, China, Australia, EU, UAE, banking, securities,
internet support and claims. Singapore identifiers and PDPA checks share the same
capability owners; data-use restrictions remain distinct from identifier matching.
General topic restrictions are an optional denylist preset within Topic Control.
Applying it appends topics only to the current Guardrail binding, without enabling
new Rules or changing its allowlist or mode. New configurations use semantic model
classification; existing phrase bindings and published snapshots retain their
reviewed behavior. Phrase filters remains available for literal matching. Profile references carry explicit Rule selection,
Rail scope, order, parameters and reviewed composition expectations. Adding a Profile
appends missing same-version Rules as well as missing Policies, preserving current
actions, parameters, directions and order. Different version pins remain untouched.
Combined selections require fresh validation and review of overlapping findings;
individual Profile expectations are not an approval of an arbitrary combination.

Exact duplicate contracts have one canonical Rule. Three older content-safety
word lists are strict subsets of their retained Rules, with unchanged exclusions
and handling. Variants with different context requirements, checksum validation,
risk or redaction output remain separate. Default removes only two exact duplicate
ABN/Medicare declarations; its ordered checks, model bindings and observation-only
Insults override are preserved. New optional capabilities are not enabled in Default.

The `0043_capability_profiles` migration updates built-in database Profiles while
preserving disabled state and user-owned definitions. Retired mixed/regional Policy
IDs have no new aliases. Historical assets remain available for audit and existing
immutable publication snapshots; adopting current capabilities uses normal draft,
validation and publication. The previously removed aviation Policies and Rules
remain removed.

The coverage oracle checks every pre-consolidation Rule contract and replays 382
pre-consolidation local Default cases. The current package suite has 833 local
cases and 16 model-dependent cases. All Profiles also run as complete Controller
plans through the real Runner compiler and validator.

## Default reconciliation

On Controller startup, an uncustomized Default is reconciled against the bundled
Policy catalog when its bindings change, including Policy versions or Rule
membership. The system queues the full inherited validation suite (currently
611 cases) and publishes only its passed compiled candidate. Missing models or
failed validation leave the old published version intact; on a fresh installation
there is no new executable Default until validation passes. There is no automatic
local-only downgrade. After fixing model configuration, rerun validation. User-customized Defaults are preserved. Publishing a custom
Policy does not currently hot-update existing Guardrails.

## Policy and Rule execution order

Newly compiled Guardrails prioritize effective Block actions, then serial
Transform actions, then Allow observations. Effective handling resolves Rule
overrides before Policy overrides and template actions. Mixed-action local
Policies are split into execution groups without changing their resource identity.

A binding's optional `ruleOrder` remains the stable tie-breaker within each
action group; unlisted Rules retain template order. `enabledRuleIds` controls
membership independently. Each Step and Action declares its evaluation view:
independent read-only checks use the original stage input and can run concurrently;
Transforms and their dependent checks use `previous_output`. Transforms run
serially in author order. In LiteLLM's default `interventions` mode, Block can
stop later execution and cancel pending siblings. Validation and the Scan API
use `full`: supported full-buffered plans collect reachable evidence even after
Block. Blocked scans can therefore incur further model calls, latency or errors;
`flagOnly` and `verbose` do not enable early exit. Allow never exempts a request
from another required check.

Trigger prerequisites remain ordered, and arbitrary authored Colang flows form
a conservative barrier. Published artifacts retain their frozen execution order
only while their execution contract is supported. Only the V1 execution contract is accepted. Admission requires
`tasklattice-controller-plan-v1` together with
`tasklattice-nemo-config-v1`, and exactly one valid
`evaluation_view` on every Step and Action. A valid signature does not imply a
supported execution contract.

Unsupported artifacts fail admission with `artifact_recompile_required` before
runtime activation or test execution. A rejected update preserves the current
valid release; a cold Runner with only an old persisted release stays unready
and logs the reason. Old artifacts with cached successful environment checks
are excluded from optional preloading; a Router referencing one causes explicit
rollout rejection instead of silently omitting that protection.

Deploy matching Controller and Runner versions, then publish the Guardrail draft
again. Publication recompiles when its existing version or test candidate uses
an unsupported contract, even if the draft did not change. Check the new version's
environment and switch the Router to it. Keep the existing serving deployment
until its replacement is ready when uninterrupted service is required. Old signed
artifacts and reports are immutable; tests remain optional and failed tests do
not prevent publication. See
[composition semantics, PII conflicts and validation limits](policy-composition.md).

## Validation and composition expectations

The bundled acceptance tests retain their original expectations, with source Rule
identities remapped to canonical capability owners. A multi-Rule scenario is inherited
only when all covered Rules are enabled; selected Profiles do not promise disabled checks. A binding's optional `testCaseOverrides`, keyed by inherited source Case
ID, supplies a reviewed Guardrail composition expectation: source Policy version,
reason, final decision, expected Policy/Rule matches, and exact complete output
(required for transformations). A stale version, disabled expected Rule, missing
review, or unsafe-to-allow override is rejected. Overrides are frozen in each
Validation request/result; original expectations remain inspectable. No override
is inferred from an observed runtime result. Editing the draft invalidates the
previous Validation/release gate.

The [Default tests](../tests/control_plane/test_default_guardrail.py) execute all 748 current composition cases through the Controller codec and Runner validator. Runner-only tests consume the signed `default-local-v1` artifact generated from current Policy sources. [Model runtime tests](../tests/control_plane/test_default_model_runtime.py) use HTTP transport doubles to verify model ordering, Policy attribution, missing bindings and provider failures. These contract tests are not live model quality evidence; acceptance against real configured models remains separate.

## Routing and output delivery

Publish a Router revision to assign traffic to concrete Guardrail versions.
Later Guardrail publications do not change targets in existing Router revisions.
See [weighted routing](router-route-weighted-distribution-design.md).

Streaming delivery depends on the selected policies. Complete-response checks
can require buffering until the final chunk; incremental modes cannot retract
text already released. The [gateway integration guide](gateway-integration.md)
defines the supported modes, call association, and enforce/dry run behavior.

## Model Rule parameters

Policy Studio declares named parameters and references them as `{{parameter_name}}`
in supported model Rule fields. Topic lists and mode, grounding thresholds, and
formal policy IDs, versions and confidence thresholds can use these references.
The detector profile remains part of the Policy contract; runtime models remain
environment bindings. Configure business values independently on each Guardrail's
Policy binding. Policy test parameters are isolated examples, never binding defaults.

Undeclared references are rejected during authoring/compilation. Binding validation
checks required inputs, types, threshold ranges and strict-mode allowlists before
generating a concrete immutable execution plan. Parameters used only by disabled
model Rules do not block other Rules. V1 seeds contain only the five current Profiles.

## Test scope and publication

The **Test model rules** switch defaults to on. Both draft and immutable-version
`POST /api/v1/guardrails/{id}/.../test-runs` APIs accept `testModelRules: false`.
The Runner first compiles/verifies and loads the complete publication Artifact,
then uses a private local-rule projection for testing. Model-dependent Rules,
arbitrary Colang without a proven local implementation, and dependencies on
excluded Rules are skipped. Mixed Policies keep their registered local Rules.

Reports freeze `testModelRules` and `testScope`: skipped Policy/Rule identities,
actual model invocations, the test execution digest, and full Artifact load
confirmation. Cases have `skipped` and `skipReason`; Skipped is never Passed.
Metrics distinguish total, executed, passed and skipped. Pass rates use executed
cases. The console labels these reports **Model-dependent tests skipped**, including
in the report list, detail, and publication review. They do not establish model
quality or full-chain acceptance. A local-only run must record zero model calls.

The existing test → publish/release flow applies to every Guardrail. Required
executed cases must pass, at least one required case must execute, and Artifact
and suite digests must match. Publication signs the original complete Artifact;
model Rules stay enabled. Deleting/pruning a report preserves its scope in compact
release evidence. Imported versions require their own tests in the destination.

Default is preconfigured once with local protections and a bundled immutable
version. It uses the ordinary Guardrail permissions and edit, test, publish and
delete workflow. Startup never overwrites edits or restores a deleted Default.
Router rules and Fallback targets explicitly select traffic protection; there is
no global runtime baseline. Bundled provenance remains truthful release evidence.

The former Default candidate/waiver creation endpoints have been removed. Existing
waiver reasons, actors, timestamps, source reports and audit records are retained
and remain visible as historical evidence; failed reports are never rewritten.
