# Local PII credential testing

Use the `local-credentials` Policy for passwords, private keys and API/auth credentials. It belongs to PII detection and has no model dependency. The 4.2.0 [format changes and limitations](../policies/builtin/local-credentials/docs/4.2.0.md) are versioned with the Policy.

## Configure a dedicated test path

Install the updated Controller catalog before selecting the new version. Keep Default and the original Report unchanged. The following patch selects only the credential Policy, including its additional opt-in rules, on a duplicate of Default:

```sh
bin/guardctl tenant provision \
  --url http://localhost:38081 --env-file .local-secrets/guardctl.env \
  --name 'PII credential regression' --source guardrail-default \
  --adapter litellm-generic-guardrail \
  --patch docs/examples/credentials-local.json \
  --state .local-secrets/credential-regression.json \
  --emergency-reason 'Authorized local credential-rule regression'
```

For an existing dedicated test path, use `--endpoint-id` and `--router-id` as described in [guardctl](../bin/README.md). The CLI validates and publishes the Guardrail before applying the audited route change. Reusing an Endpoint keeps its existing credential; load that credential through the Veritas Target's existing environment-variable reference. Model registration or binding is unnecessary.

## Compare real Reports

1. Freeze CredData source revision, converter, case IDs, text and labels before changing rules. Balance positives and negatives explicitly; the source distribution is heavily imbalanced.
2. Keep the pre-fix Report. Repeat the identical selection, scorer, input direction, repeat count and concurrency through the real Endpoint after routing the published repair. Select the original Report as Baseline.
3. Inspect fixed, newly failing and still-failing cases. Confirm every request's route headers and Controller trace identify the intended Guardrail version and `local-credentials@4.2.0`; verify complete text coverage, zero execution errors and zero model invocations. HTTP success alone is insufficient.
4. Use a separately frozen, text-disjoint cohort to check whether improvements transfer. Do not tune on that cohort and continue describing it as independent. Report its positive/negative balance and remaining errors separately.

Keep unmatched source labels unchanged. A real-looking example password/private key may be labelled benign by CredData but still trigger an exposure policy. Distinguish that scope disagreement from genuine rule gaps, such as unrecognized source-code references, encoded credentials or uncommon assignment syntax. Do not add exemptions for particular benchmark values.

One repeat supports deterministic before/after comparison, not a measurement of instability. These small balanced tests are not full-corpus accuracy and are not directly comparable to historical F5 results on an internal spreadsheet. Report measured local latency separately; do not infer billing from the generic cost field when it is unavailable.
