# Strict input Prompt Injection testing

An Endpoint's final decision combines model evidence with policy actions.
JEV's `jailbreak-input.v1` evaluator can return `matched`, `not_matched`, or
`unknown`. An unknown result is a valid model response, not a connection error
and not an explicit model match.

For an input Prompt Injection workload that prioritizes rejecting uncertain
instruction manipulation, use a dedicated Guardrail with the existing
`jailbreak-uncertainty-control` Policy and `on_unknown: block`:

| Model outcome | Strict profile action |
| --- | --- |
| Explicit match | Block |
| Valid unknown | Block, retaining unknown evidence |
| Not matched | Allow |
| Model execution failure | Fail closed; record an execution error |

This is a policy configuration, not a new classifier. It does not change JEV
questions, the lower/upper probability boundaries, dataset labels, or NVIDIA's
native verdict. In particular, it cannot turn NVIDIA's explicit `not_matched`
response into an uncertain result or a detected attack.

## Provisioning

Publish the Policy from
[`examples/jailbreak-uncertainty-control.json`](examples/jailbreak-uncertainty-control.json)
through Policy Studio's existing definition, validation, and publication APIs
if it is not already available. Use the immutable published version returned by
that instance, not the source document's version or another instance's revision.

Create a `guardctl tenant provision` patch with this binding:

```json
{
  "runtimeProfile": "auto",
  "draftConfig": {
    "allowedTopics": [],
    "restrictedTopics": [],
    "topicControlMode": "permissive",
    "policyBindings": [{
      "policyId": "jailbreak-uncertainty-control",
      "policyVersion": "REPLACE_WITH_PUBLISHED_VERSION",
      "action": "block",
      "parameterValues": {"on_unknown": "block"},
      "enabledRuleIds": ["model/jailbreak"],
      "ruleOrder": ["model/jailbreak"],
      "enabledRails": ["input"],
      "testCaseOverrides": {},
      "ruleActions": {},
      "reasoningPolicy": null
    }]
  }
}
```

Follow [the configuration CLI guide](guardctl-configuration.md) to duplicate
Default, apply the patch to the copy, validate, publish, and create a dedicated
Endpoint and Router. Do not repoint an existing permissive jailbreak Endpoint:
its intended tradeoff may differ. Store the private CLI state under
`.local-secrets/`; load its Endpoint credential into the environment variable
referenced by the Veritas Target's `apiKeyEnv`.

The `jailbreak.input` model binding remains platform-wide. An isolated Endpoint
does not pin JEV. Before and after each test, verify the active model revision
and the actual model name in every correlated Guard trace.

## Validation and interpretation

1. Freeze development and holdout cases before testing. Keep their text hashes
   disjoint and preserve upstream labels. A previously inspected test split is
   a regression set; do not describe it as an unseen holdout.
2. Use development evidence to compare uncertainty actions. Counterfactual
   calculations must be labelled as such; do not rewrite historical Reports.
3. Freeze the policy and run the holdout through the real Endpoint. Check both
   Accuracy and false-positive rate, then run the original regression snapshot
   with a Report Baseline comparison and the agreed acceptance gates.
4. Verify input text, Guardrail version, model revision, actual model calls,
   response mapping, execution errors, and promptfoo scoring consistency.

Report explicit matches, uncertain blocks, and errors separately. Accuracy
under this profile measures **Guard plus JEV policy decisions**, not JEV's
explicit-match accuracy. Unknown blocking can reduce misses while increasing
false positives; assess that tradeoff per workload. Direct input text testing
does not validate an indirect-injection or persistent-memory execution chain.
Historical F5 metrics on a different corpus are reference values, not proof of
same-dataset parity.
