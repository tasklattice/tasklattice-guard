# Laya Guardrails Classification Dataset

The dataset contains labeled examples for fine-tuning and evaluating Laya's
guardrail decisions. It covers content safety, prompt injection, jailbreaks,
personally identifiable information (PII), credential leakage, and memory
poisoning.

The dataset ID is `laya-guardrails`. The version `notebook-v1` identifies the
fixed dataset extracted from the original guardrails Notebook. The extracted
acceptance cases are kept in [`datasets/reference/fixed-acceptance.json`](../datasets/reference/fixed-acceptance.json).
[Version manifest](../datasets/manifests/notebook-v1.json)

| File | Role | Examples in `notebook-v1` |
| --- | --- | ---: |
| `train.jsonl` | Update model weights during fine-tuning | 49,430 |
| `validation.jsonl` | Score and select the training checkpoint | 6,314 |
| `calibration_fit.jsonl` | Fit the temperature used to calibrate model probabilities | 3,307 |
| `calibration_policy.jsonl` | Select decision thresholds using the calibrated model | 3,245 |
| `acceptance.jsonl` | Evaluate the finished candidate on a frozen holdout, including dedicated memory cases | 859 |

## Expanded Tensor Trust acceptance

`notebook-v1` sampled 16 risk and 16 benign Tensor Trust cases for the frozen suite.
The pinned source file contains 230 outputs. The `notebook-v2-tensor-trust` cohort
contains 48 verified access-code disclosures and 51 benign outputs from that file.
The selection keeps one case per normalized output, excludes conflicting labels and overlap
with the other notebook cases, and replaces disclosed access codes with fictional values
of the same shape. This cohort measures literal access-code leakage.

The expanded acceptance split has 926 cases. The other four shards come from `notebook-v1`.
The [expanded manifest](../datasets/manifests/notebook-v2-tensor-trust.json) records the
selection and split hashes.

Extract `output/notebook-v2-tensor-trust-kaggle.zip` and attach its contents as a private Kaggle
Dataset. The notebook's `config` cell expects the version and manifest digest below. Set
`ref` to the attached Dataset's reference if you use a different Kaggle account or slug.

```python
DATASET["version"] = "notebook-v2-tensor-trust"
DATASET["sha256"] = "189c1a779978ed258c77d60e6dc25fdc990e682993f8d95b6a2ce95d7ff75970"
```

## Prepare the dataset

The source registry pins the revision, file size and SHA-256, license or terms,
intended usage, and language of each public source. The generated manifest
records the dataset ID and version, label schema digest, source receipts,
transform version, and each split's digest and counts. It records unknown
language as `und`. [Source registry](../datasets/registry.yaml)

```sh
# Preparation runs outside this repository and must reproduce the digest above,
# otherwise it is a different dataset version.
```

Preparation produced `notebook-v1` and printed its `version` and
`manifestSha256`; those two values are the contract, and the Notebook refuses
to train against anything else.

The source adapters preserve the Notebook's exact-source grouping, frozen
case IDs, deterministic stratification and independent benign controls.
Training and validation follow the reference Notebook's upstream partition
and group assignments. Its test pool supplies the two calibration splits.
Normalized content, template and group matches, plus high lexical similarity,
remove leakage from lower-priority partitions. These checks detect obvious
near duplicates. Semantic paraphrases still require dataset review.

The prep command uses generated credential examples for the CredData and
Tensor Trust cohort labels. The replacement preserves selection and provenance
while excluding raw credential values from the materialized examples. Source
caches and all materialized partitions belong in access-controlled storage.

<a name="mount-notebook-v1-on-kaggle"></a>

## Mount the classification dataset on Kaggle

Attach the private **Laya Guardrails Classification Dataset** in the Notebook's Inputs.
The uploaded files must include the expanded `notebook-v2-tensor-trust/` directory with its
manifest and five JSONL shards. Extract the prepared archive before uploading the files.
[Kaggle Dataset file formats](https://www.kaggle.com/docs/datasets#technical-specifications)

Keep `DATASET_ROOT = None` on Kaggle. The loader finds the directory under `/kaggle/input`
by the identity in its manifest and checks the pinned manifest digest and all five shard
digests. For a local run, set `DATASET_ROOT` to the directory containing the extracted files.
To reproduce the original acceptance run, use the ID, version and digest in the
[`notebook-v1` manifest](../datasets/manifests/notebook-v1.json).
[Kaggle training Notebook](../notebooks/train_laya_kaggle.ipynb)

## Memory and additional acceptance coverage

MPBench defines the intended persistent record in `expected_memory` and
the follow-up task in `retrieval_query`. Use these fields to build separate
candidate-write and recall requests. Select legitimate benign writes and
recommendation-poisoning examples. Both requests for a record share one group
and one split. Source records used for the dedicated memory suite are reserved
from the general injection pool. The small authored fixtures exercise
additional boundary wiring. The gate counts distinct groups per label and
category. Credential Leakage needs additional independent licensed samples
for a production gate. [MPBench source schema](https://github.com/Digital-Trust-Lab/mp-bench/blob/6886880a7c29625e0109e0ad91d0e095029f1577/README.md)

A supplemental file is a private JSON object whose keys are the five physical
split names and whose arrays match the classification schema. Use stable case
IDs and set `group` to a common value for related cases. Its digest is recorded
in the manifest next to the source receipts. Mount the corresponding `VERSION/`
directory as a private Kaggle Input and set the Notebook's `DATASET` to that
version and its manifest digest.
