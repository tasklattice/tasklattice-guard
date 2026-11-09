# Classifier uncertainty handling

Jailbreak, Content Safety and Topic Control Rules can configure `on_unknown`
independently of their `on_match.action`. An absent value defaults to `block`.
Valid values are `allow` and `block`; invalid authored values fail compilation.
Existing published versions keep their frozen configuration.

In a Policy draft, declare a text parameter with default `block`, then reference
it from the classifier Rule:

```yaml
parameters:
  - name: on_unknown
    label: Uncertain result action
    kind: text
    default: block
    required: false
rules:
  - id: content-safety
    name: Content safety
    stages: [input]
    detector:
      ref: model/classifier
      version: 1.0.0
      parameters:
        profile: safety-classification
        on_unknown: '{{on_unknown}}'
    on_match:
      action: block
    risk_level: high
    metadata:
      taxonomy_ids: [TALI-PHYSICAL-HARM]
```

Use `topic-classification` for Topic Control or `jailbreak-classification` for
Jailbreak. The Policy editor exposes the same parameter field. Publish a new
Policy version and set `parameterValues.on_unknown` on the Guardrail binding.
Duplicate a shared Policy before experimenting with a dedicated test route.

`allow` observes an uncertain verdict; it neither converts it to `not_matched`
nor skips other Rules. Explicit positive matches still use `on_match.action`.
Timeouts, transport errors and invalid responses retain the execution-error
path. F5 scans still reject incomplete coverage or missing-context results.
Monitor mode records the would-be action without enforcing it.

This parameter does not change model prompts or decision thresholds. With JEV's
current lower/upper operating points of 0.1/0.9, lowering only the upper point to
0.85 changes the uncertain/matched boundary. With `on_unknown: block`, that
usually changes attribution rather than the final action. With `allow`, it can
add interventions in the 0.85–0.90 interval. Compare benign false positives and
attack recall together; these scores are not calibrated risk guarantees.

Opt-in `evaluations-v1` response evidence includes all three JEV capabilities.
Topic Control retains `denied_task` and `unlisted_task` probabilities and its
own enforced action. Evidence never includes source text or configured topics.
Historical responses without this evidence must not be treated as proof that
Topic Control did not run.
