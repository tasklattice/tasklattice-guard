# Guardrail Policies and Validation

A Policy defines versioned checks, actions, and test cases. A Guardrail composes
Policies into the protection configuration assigned to application traffic.
Validate the current draft before publishing an executable version; deployment
readiness is a separate step. See [revision lifecycles](revision-lifecycle.md)
for publication and rollback.

## Default local protection

The Default Guardrail currently composes **32 complete local Policies** and
requires no model configuration. The authoritative selection is in
[defaults.ts](../controller/server/domain/defaults.ts). Focused Policies cover
credentials, payment data, tax/health/government/travel identifiers, contact and
network data, harmful phrases, and prompt/code injection. Each retains its Rules,
actions, Rail scope, and inherited test cases; Default owns their composition
order and reviewed test expectations.

The older mixed `Baseline PII Protection`, `Pattern Matching`, and advanced PII
collections have been replaced in Default by focused bindings. Local checks
provide format/context screening, not exhaustive semantic protection. Default
uses `full_buffered` output delivery because its transformations require the
complete response.

## Default reconciliation

On Controller startup, an uncustomized Default is reconciled against the bundled
Policy catalog and recompiled if its bindings change, including Policy versions
or Rule membership. User-customized Defaults are preserved. Publishing a custom
Policy does not currently hot-update existing Guardrails.

## Policy and Rule execution order

Guardrails execute Policy bindings in list order. A binding's optional `ruleOrder`
lists stable Rule IDs to execute first; unlisted Rules retain their pinned template
order afterward. Duplicate/unknown IDs are rejected. `enabledRuleIds` controls
membership independently. Redaction changes the text seen by subsequent Rules;
rejection stops subsequent execution. Rule action overrides take precedence over
Policy overrides, then the template action. Compilation preserves that order
across local, model-backed, and programmable Policies instead of sorting actions
by severity or running independent copies of the original text in parallel.

## Validation and composition expectations

The bundled acceptance tests retain their original expectations and source Rule
identity. A binding's optional `testCaseOverrides`, keyed by inherited source Case
ID, supplies a reviewed Guardrail composition expectation: source Policy version,
reason, final decision, expected Policy/Rule matches, and exact complete output
(required for transformations). A stale version, disabled expected Rule, missing
review, or unsafe-to-allow override is rejected. Overrides are frozen in each
Validation request/result; original expectations remain inspectable. No override
is inferred from an observed runtime result. Editing the draft invalidates the
previous Validation/release gate.

The [Default tests](../tests/control_plane/test_default_guardrail.py) cover the
current composition and replay a frozen migration baseline of 140 cases from
18 legacy Policies at version `1.95.0`. Those numbers describe the historical
baseline, not the current Policy count or a current test-run result. Runner-only
tests consume the signed `default-local-v1` artifact without compiling it.

## Routing and output delivery

Publish a Router revision to assign traffic to concrete Guardrail versions.
Later Guardrail publications do not change targets in existing Router revisions.
See [weighted routing](router-route-weighted-distribution-design.md).

Streaming delivery depends on the selected policies. Complete-response checks
can require buffering until the final chunk; incremental modes cannot retract
text already released. The [gateway integration guide](gateway-integration.md)
defines the supported modes, call association, and enforce/dry run behavior.
