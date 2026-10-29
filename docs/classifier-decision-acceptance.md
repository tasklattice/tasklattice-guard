# Classifier configuration and decision acceptance

JEV probabilities use one lower/upper operating point per Runner. They are raw
Noul answers, not confidence or severity. A Rule applies its own action after
classification; an Allow result continues the remaining Policies.

The opt-in, separately versioned second-stage review is documented in
[JEV / Laya 灰区复核](classifier-gray-review.md). With `review_unknown=true`, a valid
first-stage unknown is reviewed before the Rule completes; first-stage failures
are not reviewed or converted to allow.

| Result | Dedicated acceptance configuration |
| --- | --- |
| Any relevant probability >= 0.85 | `matched`; Block |
| Every relevant probability <= 0.1 | `not_matched`; continue |
| Valid probabilities between the boundaries | `unknown`; `on_unknown=allow` continues this Rule |
| Timeout, HTTP error or invalid response | Error; retain configured failure handling |
| Missing required context or coverage | Incomplete; retain context/coverage handling |

The lower boundary remains 0.1. A value exactly at 0.85 is a match, and one
exactly at 0.1 is not matched. Unknown is a completed abstention and is distinct
from missing context. Observing an unknown result cannot suppress another
Rule's Block, including a local Rule or another model classifier.

## Versioned Policies

| Policy | First version declaring `on_unknown` | Frozen predecessor |
| --- | --- | --- |
| `builtin-content-safety` | 1.1.0 | 1.0.0 |
| `builtin-topic-safety` | 2.1.0 | 2.0.0 |
| `builtin-jailbreak` | 1.1.0 | 1.0.0 |
| `builtin-jailbreak-strict` | 1.0.0, already configurable | — |

New versions declare `on_unknown` and reference it in every classifier Rule.
Its default remains `block`. Set `parameterValues.on_unknown` to `allow` in the
dedicated Guardrail binding and retain Block as the matched action. Native and
declarative Controller compilation both pin the resolved parameter in the
execution plan. Supplying an undeclared parameter to an older Policy does not
enable the new handling. Existing published artifacts retain their definitions.

Adopt `local-data-use-boundaries` 4.0.1 separately for the PHI access-intent
repair. Its tests distinguish access-process questions and authorized caregiver
guidance from direct retrieval, covert access, access without consent and bulk
disclosure. This local repair does not depend on JEV's verdict.

## Isolated Runner configuration

Use a dedicated deployment for the acceptance operating point:

```yaml
runner:
  jev:
    lowerThreshold: 0.1
    upperThreshold: 0.85
```

The corresponding environment variables are `GUARD_JEV_LOWER_THRESHOLD` and
`GUARD_JEV_UPPER_THRESHOLD`. They affect **all JEV checks on that Runner**,
including the legacy topic-only profile. A separate Endpoint by itself does not
isolate these settings. Keep model versions, model questions, topic lists and
benchmark expectations fixed when comparing policy behavior.

## Response evidence

Request `x-guard-evidence: evaluations-v1` on F5 Scan or LiteLLM requests and
inspect `x-guard-evaluation-evidence` in the actual response. Check:

- Top-level `guardrailId`, `guardrailVersion`, `modelRevisionId` and execution status.
- Per-evaluation `policyId`, `policyVersion`, requested and response model names.
- `thresholds.lower` and `thresholds.upper`, requiring an actual **0.85** upper value.
- Raw `probabilities` and the original `verdict`, including unchanged `unknown`.
- `policyAction`, the Rule's resolved action, and `enforcedAction`, the correlated
  intervention (null for an observed unknown or Monitor).

Errors retain threshold and requested-model evidence. An unavailable response
model remains null and a failed call has no invented probabilities. A failed F5
scan with an available decision also returns the opt-in evidence header. Error
responses remain errors and must not count as successful detections.

The header is bounded and excludes input text and free-form model responses.
An omitted/truncated evaluation is not proof that the check completed. Inspect
full correlated telemetry when `complete` is false.

Native Safety classifiers expose a separate `classifications` collection in
the same header: `nativeVerdict`, normalized `verdict`, requested/response model,
Policy version and resolved/enforced action. The collection includes successful
safe classifications and errors, including outer Action timeouts. Native
labels do not provide JEV probabilities; no score or 0.85 threshold is invented
for these models. A model-binding replacement must be measured as a model
change, rather than attributed to a JEV threshold or Policy repair.

## Verification

`tests/control_plane/test_classifier_decision_chain.py` executes actual shipped
Policies through Controller planning, Runner compilation, mocked JEV transport,
decision composition and the F5 HTTP adapter. It covers 0.1/0.85 boundaries,
each classifier's Block against unknown siblings, local Blocks, all-unknown
continuation, timeouts, HTTP/parse errors, both JEV topic profiles and the PHI
repair. Additional uncertainty tests cover standard/programmed execution and
Enforce/Monitor modes.

After deterministic verification, run Veritas against the isolated published
Guard with the frozen 256-case F5 cohort, three repeats and concurrency two.
Preserve source IDs, raw texts, expected labels, annotations and scoring rules.
Verify the saved request/response and route evidence, not just UI settings.

Compare JBB benign false positives against **28/48 (58.33%)**, and harmful/attack
intervention recall against **366/384 (95.31%)**. The latter excludes credential
and PII extraction cases; report those separately. Retain strict scorer accuracy,
execution errors, newly missed cases and repeat instability. A lower false
positive rate with lower recall is a tradeoff, not proof of improved protection.

This F5 cohort includes 32 existing MPBench text projections without the
original context boundaries. Replaying them is a text-scan regression and does
not certify the full memory-poisoning execution chain.

## Recorded quality limit

The local frozen 256-case experiment (three repeats, concurrency two) did not
establish the current review model as an acceptable replacement. The following
results use all planned cases as the denominator; execution errors count as
misses instead of disappearing from a completed-only percentage.

| Configuration | Aegis 2.0 expected outcomes | JBB benign false positives | Harmful/attack recall | Errors across 768 requests |
| --- | --- | --- | --- | --- |
| Original baseline | 77/96 (80.21%) | 28/48 (58.33%) | 366/384 (95.31%) | 0 |
| First-stage unknown allows this Rule | 63/96 (65.63%) | 0/48 (0%) | 294/384 (76.56%) | 0 |
| Opt-in review using `nvidia/nemotron-3.5-lightning-30b-a3b` | 71/96 (73.96%) | 10/48 (20.83%) | 299/384 (77.86%) | 21 |

The review chain recovers some Aegis outcomes relative to allowing all unknowns,
but its harmful/attack recall remains below the baseline and it introduces
execution errors. Lower JBB false positives alone do not pass acceptance.
`review_unknown` therefore remains opt-in and defaults to `false`. Select and
measure a review model independently before enabling it on a production route.
These results evaluate JEV plus the named reviewer; they do not validate Laya.
