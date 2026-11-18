# Laya post-training and quantization

Post-training material for Laya, the encoder that scores English safety decisions for the
TaskLattice Guard Runner. Given text and a yes/no question such as whether it contains
personal information, the model estimates the probability of yes.
[Laya model card](https://huggingface.co/convaiinnovations/laya) ·
[TaskLattice Guard](https://github.com/tasklattice/tasklattice-guard)

The training Notebook records the data provenance, pinned base checkpoint, fine-tuning
recipe and frozen acceptance cases. The recipe runs in
[`notebooks/train_laya_kaggle.ipynb`](../notebooks/train_laya_kaggle.ipynb) on a Kaggle `GPU T4 ×2`
session.

## Material

| Material | Where |
| --- | --- |
| Data sources, revisions, file SHA-256, license and usage | [`datasets/registry.yaml`](../datasets/registry.yaml) |
| Dataset version, split counts, category and label distribution | [`datasets/manifests/notebook-v2-tensor-trust.json`](../datasets/manifests/notebook-v2-tensor-trust.json) |
| Frozen acceptance cases with their source rows | [`datasets/reference/fixed-acceptance.json`](../datasets/reference/fixed-acceptance.json) |
| How the splits were built, and how to mount them on Kaggle | [`docs/datasets.md`](datasets.md) |
| Base checkpoint revision and per-file SHA-256 | the `config` cell of the Notebook |
| Training recipe, question wording, runtime budgets | the `config` cell of the Notebook |
| One run, end to end | the `report` cell → `laya-material.json` in `/kaggle/working` |

The rows themselves stay in access-controlled storage; only the registry, the version manifest
and the frozen acceptance cases are committed.

## The Notebook

The first cell records what changed since the previous revision, so a Kaggle copy can be
identified from its output.

| Cell | What it does |
| --- | --- |
| `config` | the recipe of record: dataset identity, pinned checkpoint, LoRA and optimizer settings, question wording per task, runtime budgets |
| `environment` | installs the pinned `laya`, `transformers` and `peft` versions, reports GPUs |
| `verify-data` | checks the manifest and all five shard SHA-256 values before anything else runs |
| `scoring` | scores the original checkpoint on the full validation and frozen acceptance splits across the visible GPUs and shows per-dataset metrics and case evidence for both splits |
| `preprocess` | defines the shared training item encoder used by `train` when fine-tuning is enabled |
| `train-script` | the training loop as a `%%writefile` cell, written to `/kaggle/working/train_laya.py` |
| `train` | writes the run spec and launches `torchrun` on two T4s, validation across both ranks every 250 updates, `latest.pt` and `best.pt` |
| `export-fp16` | optionally converts an existing merged checkpoint to FP16 for evaluation and upload |
| `export-int8` | optionally exports a saved FP16 checkpoint to a Guard-compatible INT8 ONNX graph |
| `upload-hf` | checks the exported checkpoint and optionally uploads it to Hugging Face before evaluation |
| `evaluate` | scores the base checkpoint and the post-trained candidate on the same split and prints one metric table |
| `evaluation-cases` | pairs decisions by case ID, previews fixed and new FP/FN cases, and writes `laya-guardrails/evaluation-<split>-cases.jsonl` |
| `score-separation` | uses the existing case comparison to measure AUC and score distributions by task and source exposure |
| `int8-fpr-budget` | compares FP16 with INT8 at the same FPR budget and saves paired case evidence |
| `report` | writes the dataset identity, recipe, original baseline, training receipt, evaluation and optional upload commit into `laya-material.json` |

Set `RUN_TRAINING = True` in the `train` cell to launch the fine-tune. When `upload-hf`
prints `Checkpoint ready` in an interactive Kaggle session, use **Save Version → Quick Save**
with output files enabled in **Advanced Settings**. Check `laya-guardrails/model/model.safetensors`
in the saved version's **Output** tab.

To reuse a saved checkpoint, attach the Notebook Output alongside the classification dataset
and leave `RUN_TRAINING = False`. Both evaluations load the mounted `laya-guardrails/model/`.
Set `TUNED_MODEL_DIR` in `config` when choosing between multiple mounted checkpoints.

New training runs save FP16 weights by default. For an existing FP32 checkpoint, enable
`CONVERT_EXISTING_CHECKPOINT` in `export-fp16`. The conversion writes
`laya-guardrails/model-fp16/` for both evaluations and optional upload.

Enable `RUN_INT8_EXPORT` in `config` to create `model.onnx` and run the FP16 / INT8
comparison from a saved checkpoint. The graph, companion files, FPR summary and
paired case evidence are saved under `laya-guardrails/int8-onnx/<run>/`. In the
run's `evaluation/` directory, `fixed-cutoff-acceptance.csv` compares FP16 and INT8
using Evaluation's shared cutoff. `summary.csv` compares the thresholds fitted
to the shared FPR budget.

To upload an exported model, attach a Hugging Face token with write access as `HF_TOKEN` in
Kaggle **Add-ons → Secrets**. In `upload-hf`, set `HF_REPO_ID` to `owner/model-name` and set
`RUN_HF_UPLOAD = True`. `HF_PRIVATE` defaults to `True`. Run `report` to include the Hub
commit in `laya-material.json`.

## Dataset

The Notebook pins `laya-guardrails` version `notebook-v2-tensor-trust`. It contains 49,430
training rows, 6,314 validation rows, two calibration partitions and a 926-row acceptance
suite. The [dataset record](datasets.md) describes the source selection, the original
859-row acceptance suite in `notebook-v1`, and how to mount the package on Kaggle.

## Scope

The Notebook exports checkpoints and evaluates them at a fixed FPR budget. Guard replay,
operating thresholds and release bundles use the Guard model delivery workflow.
