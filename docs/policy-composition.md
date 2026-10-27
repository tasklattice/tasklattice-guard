# Policy composition and execution

A published Guardrail is an immutable execution plan. Plans use the effective Rule action (Rule override, Policy override, then Rule default) to schedule compiler-owned checks. Changes require a newly compiled version.

The compilation step is an optimisation over that plan, not a second definition
of it. Every step therefore declares two things the schedule is not allowed to
change: its **authored precedence** and the **view** it inspects.

The following is the default `interventions` execution path:

```text
Input / buffered output
  -> local Block checks (stable order, stop on Block)
  -> independent model Block checks (same text, bounded parallelism)
       any Block -> reject; cancel remaining work
       all pass  -> continue
  -> Transform checks (serial, each sees the preceding output)
  -> Allow observations (cannot bypass another check)
  -> final response
```

## Execution contract

This section describes observable behaviour. The parameter validation rules and
the evidence statuses are implemented once, in the Runner
(`NeMoConfigCompiler.compile()`, `NeMoActionBridge._declared_view()`,
`validator._case_evidence()`), and negative cases live in
`tests/control_plane/test_ordered_execution.py` and
`tests/control_plane/test_evidence_capability_matrix.py`.

The Controller writes two step parameters that the Runner must honour:

| Step parameter | Meaning |
| --- | --- |
| `precedence` | The authored step order, fixed before scheduling. Each step must declare one canonical non-negative integer, unique across the plan. Execution order may differ and gaps are allowed. This metadata is not a separate decision resolver; the Runtime still gives Block precedence. |
| `evaluation_view` | `original` for read-only checks; `previous_output` for a Transform step and every step of its trigger chain. |

Consequences:

- **Within the verified deterministic, full-buffered cases, decision is order-independent under legal schedules.** A Block wins wherever it is scheduled, because read-only checks inspect the phase input rather than whatever an earlier step happened to write. Scheduling Block first enables earlier rejection in `interventions` scope.
- **Read-only detection input is schedule-independent.** Moving an independent check ahead of a Transform step does not change its declared input. Full evidence mode also preserves execution after a Block; the default fast path does not promise identical findings.
- **Output is order-dependent by contract.** Only Transform steps compose text, they keep their authored order, and each one sees the output of the Transform steps it declares as its view.
- A windowed output stream has no complete phase input yet, so its rails keep checking exactly the pending window they were handed.

## Dependencies and concurrency

- Trigger prerequisites override action priority. A conditional exact/semantic chain stays together. A Transform prerequisite is not moved behind its dependent check.
- Transform order is stable and Transform checks never share a parallel group.
- Independent, unconditional, single-step model checks can share a group. The Runner starts at most four checks per request. This limit is separate from Veritas request concurrency.
- In the default `interventions` scope, a Block cancels pending group work and prevents later stages. Cancellation is recorded as `cancelled` or `skipped`; it is not a successful check. An upstream service may have already processed or billed a cancelled call, so missing provider usage is not zero cost.
- Timeouts and transport errors retain the configured failure policy; an Allow result cannot override another required check's Block or failure.
- Arbitrary authored Colang flows retain their declared execution order as a conservative dependency barrier. Streaming output checks remain serial. Full-buffered input/output checks support parallel groups.
- NeMo owns flow execution and each existing Action/evaluator still owns its model request, deadline, verdict and evidence. No second evaluation framework is introduced.

## PII and content safety

Block takes precedence over Transform. If PII would redact a request but the content-safety or jailbreak check blocks it, the final decision is Block and no redacted request is released. A content-safety Privacy classification is not silently removed because a narrower PII detector exists. An uncertain jailbreak verdict retains its configured handling and remains distinguishable from an explicit detection.

In `interventions` scope, PII transformations run only after required Block checks pass; supported `full` scope also runs them after a Block to collect evidence. Transforms run sequentially: each step and its declared chain consume the current transformed text, while unrelated conversation history and external-content boundaries remain intact. A read-only Block or Allow check inspects the phase input, so another Policy's redaction can neither blind a Block check nor erase an Allow observation. Allow means that a particular check does not object; it is not a global exemption.

Model checks before PII redaction can receive the original text. A deployment requiring redaction before external model processing must express that dependency explicitly or use a local model; action priority alone does not establish a data-egress policy.

## Evidence capability

`full` evidence means "evaluate every reachable check, then decide". Only some
execution types can honour it, and the report never pretends otherwise:

| Execution type | `interventions` (default) | `full` (Validator, Scan API) |
| --- | --- | --- |
| `full_buffered`, no custom Colang | early exit at the first Block; report only interventions | every reachable check runs, Action-internal Rule short-circuiting is off; `observed` evidence for each Rule |
| `window_buffered` / `interruptible` | early exit; report only interventions | early exit is kept; unreached Rules report `not_reached` / `preempted_by`, never a fabricated non-match |
| any custom Colang Flow | authored order and flow-owned short-circuiting; report only interventions | same execution, same early exit; unreached Rules report `not_reached` / `preempted_by` |

Two consequences worth knowing before writing Test Cases:

- A `rule_acceptance` case can only be certified for a Rule that actually ran.
  When the execution type keeps its early exit, the second Rule of an overlapping
  pair is reported as unreached; review it with an expectation override, or test
  it in a Policy-level suite instead of the composed Guardrail.
- `full` increases cost. A blocked request evaluates every reachable check, so
  Validation and Scan runs can issue more model calls than production does. See
  [`policy-scheduling-benchmark.md`](./policy-scheduling-benchmark.md) for the
  measured check counts.

## Validation and reporting

> 设计约定、已验证范围、统一契约与后续工作，见
> [`policy-scheduling-optimization-design.zh-CN.md`](./policy-scheduling-optimization-design.zh-CN.md)。

Single-Policy acceptance and combined final decisions answer different questions. Another Rule's Block or Transform cannot prove the target Rule passed. A target must have the pinned source version, enabled phase and Rules, executable steps, and actual evidence. Rule acceptance requires every target; scenario coverage may list alternative detectors and requires an actual match within that pinned coverage. A scenario match does not certify its unmatched Rules.

- `observed` requires actual target matches. `absent` requires conclusive execution without those matches. `missing`, `not_reached`, `not_matched` and `unverifiable` cannot pass target acceptance.
- `preempted_by` and `shadowed_by` explain why target evidence is unavailable; they do not satisfy acceptance. A local pinned-definition recheck on original text is diagnostic only, never an actual match on a transformed view.
- A reviewed expectation override can explicitly require a different Rule and exact output. It remains version-bound and cannot repair an omitted or disabled target by assumption.
- Compiler-owned, full-buffered plans honor `evidence_scope=full`: all reachable checks collect evidence despite a Block, including parallel members. Both Validator and the Scan API request this scope. Blocked scans can therefore incur later model calls, latency and execution errors; `flagOnly` and `verbose` do not change the scope. The final Block still prevents content delivery. LiteLLM's default `interventions` retains short-circuiting and cancellation.
- `complete_evidence_supported()` describes the plan's execution structure, not provider availability or determinism. Actual failures and evidence still require runtime classification; schedule invariance assumes fixed provider responses. Independent local and Topic Rule interventions retain their Action attribution even after later checks, while native exact/semantic chains for the same Rule retain their terminal-result semantics.
- Reports carry explicit structured evidence and a required `ruleContractSatisfied` result. The console uses that result directly. There is no historical-report fallback, `preemptingMatches` field or evidence-contract version field. Skipped model cases explicitly record `not_reached` and an unsatisfied Rule assertion, and remain excluded from executed-case metrics.
- Full evidence separates a proven Block from independent execution failures. A terminal matched Block sets `usage.fail_closed=false`; other errors remain in trace and assessments. A `rule_acceptance` case can pass with an execution warning when every pinned target on the `original` view has conclusive matching evidence and its dependencies succeeded. `actualFailure` and `evidenceDetail` retain the failure; the console shows that Rule acceptance passed without certifying composition availability. Target/dependency/runtime failures remain failures. Transformed-view targets, scenarios, custom cases and reviewed composition overrides retain strict execution assertions; explicit `expectedFailure` must match. Decision, output and reasoning assertions still apply. Scan retains its strict whole-scan execution contract, including errors after a real Block.
- Controller and Runner use one execution contract. There is no view capability negotiation or version-dependent stop behavior. Every step must declare exactly one valid `evaluation_view`; missing, duplicate and unknown views are rejected. Custom Flow bindings explicitly use `previous_output`. Compiler version identifiers remain artifact provenance, not behavior switches.
- Three legal schedules of each tested action composition must have identical decisions, outputs, normalized evidence and assertions. These deterministic tests do not prove equivalence for arbitrary custom flows, windowed streaming, model randomness or stateful checks.

**Testing does not gate Guardrail publication.** Untested and failed drafts can publish through independent compilation. A failed report remains failed, including when published as release evidence. Artifact validity, pinned Policy identity and execution dependencies remain necessary checks. Create a new compiled artifact to adopt the current contract, and rerun tests when current evidence is needed. Retesting is not a prerequisite for publication.

The existing local-only validation option verifies local Rules without model calls, explicitly lists skipped model tests, and publishes the complete model-enabled artifact. It does not certify combined model behavior. Real-target Veritas runs are separate evidence, with unchanged source labels and frozen samples. Report strict scorer Accuracy alongside binary intervention Precision/Recall/F1, new failures, fixes, repeat instability, execution errors and latency. For PII, an arbitrary Block or incomplete redaction must not count as successful full removal when the scorer requires a transformed output.

The progressive combination regression uses four, six and eight benchmark areas against their corresponding single-capability baselines. It is not an exhaustive all-pairs experiment. Baselines with one repetition do not eliminate model randomness as a cause of a changed result.

## Independent offline verification

From the repository root, with the existing Controller dependencies and Python
virtual environment installed, run:

```sh
(cd controller && node node_modules/vitest/vitest.mjs run \
  server/domain/execution-plan.test.ts \
  server/domain/guardrail-plan.test.ts \
  server/domain/validation.test.ts)

.venv/bin/python -m pytest -q \
  tests/control_plane/test_action_composition_matrix.py \
  tests/control_plane/test_schedule_invariance.py \
  tests/control_plane/test_ordered_execution.py \
  tests/control_plane/test_parallel_checks.py \
  tests/control_plane/test_catalog_rule_overrides.py \
  tests/control_plane/test_validation_expectations.py \
  tests/control_plane/test_released_version_validation.py \
  tests/control_plane/test_evidence_capability_matrix.py \
  tests/control_plane/test_schedule_replay_diff.py
```

These are ordinary test-suite commands, not a deployment or CI workflow. They do
not load credentials or make external model calls. Controller tests verify
effective actions, scheduling, dependencies, and validation assertions. Runner
tests execute real NeMo flows with local detectors or deterministic providers.

`tests/control_plane/test_action_composition_matrix.py` compiles its synthetic
Policies through the real Controller and executes the resulting plans through
NeMo. The expected result is derived independently from the action contract.
The matrix covers all nine two-Rule action sequences and all 27 three-Rule
sequences, including repeated actions. Every sequence is tested with all matching
and nonmatching input combinations, both within one Policy and across Policies,
and in Input and Output: 1,008 scenarios in total. Assertions check executed Rule
order, the current text at each Rule, terminal Block short-circuiting, unchanged
Allow content, complete sequential Transform output, final decision, and finding
identity. Compilation must leave source definitions unchanged.

Companion tests cover overlapping transformations, explicit Rule order, Allow
continuation, missing Transform output, parallel checks and cancellation,
conditional dependencies, custom Colang flow boundaries, invalid parallel plans,
publication expectation safeguards, and replay of an existing released Artifact
without recompilation. These tests do not establish model accuracy or exhaust
every combination of remote failure timing, streaming mode, and authored flow.
The product's publication Validation uses selected Policies' acceptance cases;
it does not automatically generate this complete synthetic matrix for each draft.
