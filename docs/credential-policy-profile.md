# Local PII credential testing

Use the Credentials & Secrets Policy for passwords, private keys and API/auth credentials. Its current catalog source is [credentials-secrets/policy.yaml](../policies/library/credentials-secrets/policy.yaml), with reviewed boundary and context cases in [its acceptance tests](../policies/library/credentials-secrets/tests/acceptance.yaml). It uses local checks and has no model dependency.

## Configure a dedicated test path

Create a dedicated Guardrail in the intended Project using the current
Credentials & Secrets catalog Policy. Select its required Input/Output Rules,
review their configured handling, then validate and publish the version. Bind it
through a dedicated Router and Endpoint using the current console or
[guardctl configuration workflow](guardctl-configuration.md). Keep the existing
Default and original Report unchanged.

The older `docs/examples/credentials-local.json` patch pins the removed
`local-credentials@4.2.0` package and is historical, not a patch for the current
unified catalog. Recreate that Rule selection against the current catalog and
record the exact published Policy/Guardrail versions for comparison.

For an existing dedicated test path, reuse its Endpoint and Router as described
in [guardctl](../bin/README.md). Reusing an Endpoint preserves its credential;
load it through the evaluation target's existing environment reference. The
current local credential checks require no model registration or binding.

## Compare real Reports

1. Freeze CredData source revision, converter, case IDs, text and labels before changing rules. Balance positives and negatives explicitly; the source distribution is heavily imbalanced.
2. Keep the pre-fix Report. Repeat the identical selection, scorer, input direction, repeat count and concurrency through the real Endpoint after routing the published repair. Select the original Report as Baseline.
3. Inspect fixed, newly failing and still-failing cases. Confirm every request's route headers and Controller trace identify the intended Guardrail version and the exact reviewed `credentials-secrets` Policy version; verify complete text coverage, zero execution errors and zero model invocations. HTTP success alone is insufficient.
4. Use a separately frozen, text-disjoint cohort to check whether improvements transfer. Do not tune on that cohort and continue describing it as independent. Report its positive/negative balance and remaining errors separately.

Keep unmatched source labels unchanged. A real-looking example password/private key may be labelled benign by CredData but still trigger an exposure policy. Distinguish that scope disagreement from genuine rule gaps, such as unrecognized source-code references, encoded credentials or uncommon assignment syntax. Do not add exemptions for particular benchmark values.

One repeat supports deterministic before/after comparison, not a measurement of instability. These small balanced tests are not full-corpus accuracy and are not directly comparable to historical F5 results on an internal spreadsheet. Report measured local latency separately; do not infer billing from the generic cost field when it is unavailable.
