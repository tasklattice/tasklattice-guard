#!/usr/bin/env python3
"""Test-only dataset inventory, offline preparation and harmful-goal replay.

No product registration, policy updates, attack generation or target-model ASR.
Use ``python -m scripts.evaluate_security_benchmarks --help`` from the repo root.
"""
from __future__ import annotations

import argparse
import asyncio
from collections import Counter, defaultdict
import csv
from dataclasses import asdict, dataclass
import hashlib
import json
from pathlib import Path
import re
from urllib.request import urlopen

from scripts.evaluation_contract import normalize, summarize_actions, target_identity


ROOT = Path(__file__).resolve().parents[1]
LOCK = Path(__file__).with_name("security_benchmarks.lock.json")
DEFAULT_SOURCES = ROOT / "output/evaluation-catalog/sources"
SCORER = {
    "id": "harmful-goal-action-coverage", "version": "2",
    "label_mapping": "harmful_goal -> block_reference",
    "transform": "unresolved_without_residual_review",
    "fail_closed": "execution_error_not_detection",
    "generation_model": None, "judge_model": None,
    "claims": ["guardrail_action_coverage"],
    "not_measured": ["classifier_accuracy", "false_positive_rate", "target_model_asr"],
}


def sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def canonical_hash(value: object) -> str:
    return sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
                             allow_nan=False).encode())


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


@dataclass(frozen=True)
class Sample:
    id: str
    dataset: str
    split: str
    protocol: str
    source_file: str
    source_sha256: str
    upstream_id: str
    inputs: dict
    annotations: dict

    def record(self) -> dict:
        row = asdict(self)
        return {**row, "input_sha256": canonical_hash(self.inputs), "sample_sha256": canonical_hash(row)}


def catalog() -> dict:
    return json.loads(LOCK.read_text(encoding="utf-8"))


def select_files(lock: dict, tracks: list[str]) -> list[dict]:
    known = {track["id"] for track in lock["tracks"]}
    if not tracks or len(tracks) != len(set(tracks)) or set(tracks) - known:
        raise ValueError(f"Choose unique tracks from {sorted(known)}")
    return [spec for spec in lock["files"] if spec["track"] in tracks]


def verify_sources(directory: Path, specs: list[dict], *, download: bool = False) -> None:
    for spec in specs:
        name = spec["path"]
        if Path(name).name != name or name in {".", ".."}:
            raise ValueError("Source filenames must be flat")
        if not re.fullmatch(r"[a-f0-9]{40}", spec["revision"]) or spec["revision"] not in spec["url"]:
            raise ValueError("Source URL must pin a full Git revision")
        path = directory / name
        if not path.is_file():
            if not download:
                raise FileNotFoundError(f"Missing {name}; use --download to fetch pinned public sources")
            if not spec["url"].startswith("https://raw.githubusercontent.com/"):
                raise ValueError("Only the pinned first-party GitHub files are supported")
            with urlopen(spec["url"], timeout=60) as response:
                raw = response.read(spec["bytes"] + 1)
            if len(raw) != spec["bytes"] or sha256(raw) != spec["sha256"]:
                raise ValueError(f"Downloaded source hash/size mismatch: {name}")
            directory.mkdir(parents=True, exist_ok=True)
            with path.open("xb") as stream:
                stream.write(raw)
        raw = path.read_bytes()
        if len(raw) != spec["bytes"] or sha256(raw) != spec["sha256"]:
            raise ValueError(f"Source hash/size mismatch: {name}")


def text_field(row: dict, name: str, *, empty: bool = False) -> str:
    value = row[name]
    if not isinstance(value, str) or (not empty and not value.strip()):
        raise ValueError(f"Expected {'possibly empty' if empty else 'nonempty'} string: {name}")
    return value  # Keep original bytes/whitespace; never normalize model input.


def load_samples(directory: Path, specs: list[dict]) -> list[Sample]:
    samples = []
    for spec in specs:
        if spec["role"] != "data":
            continue
        path, adapter = directory / spec["path"], spec["adapter"]
        if path.suffix == ".csv":
            with path.open(encoding="utf-8", newline="") as stream:
                rows = list(csv.DictReader(stream))
        elif path.suffix == ".jsonl":
            rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        else:
            rows = json.loads(path.read_text(encoding="utf-8"))
        if adapter == "bipia_payload":
            rows = [{"category": category, "variant": i, "payload": text}
                    for category, values in rows.items() for i, text in enumerate(values)]
        start = len(samples)
        for i, row in enumerate(rows):
            upstream_id, protocol = str(i), "harmful_goal"
            if adapter == "advbench":
                inputs = {"user_request": text_field(row, "goal")}
                annotations = {"source_label": "harmful_behavior", "reference_target": text_field(row, "target"),
                               "target_semantics": "optimization_prefix_not_reference_answer"}
            elif adapter == "tdc2023":
                inputs = {"user_request": text_field({"behavior": row}, "behavior")}
                annotations = {"source_label": "harmful_behavior", "label_source": "official_behavior_list"}
            elif adapter == "harmbench":
                upstream_id = text_field(row, "BehaviorID")
                category = text_field(row, "FunctionalCategory")
                protocol = {"standard": "harmful_goal", "contextual": "contextual_behavior",
                            "copyright": "copyright_behavior"}[category]
                inputs = {"user_request": text_field(row, "Behavior"),
                          "context": text_field(row, "ContextString", empty=True)}
                annotations = {"source_label": "benchmark_behavior", "functional_category": category,
                               "semantic_category": row["SemanticCategory"], "tags": row["Tags"]}
            elif adapter == "bipia_context":
                protocol = "injection_context_component"
                if spec["task"] == "code":
                    # CodeQA stores segments as lists; preserve them instead of
                    # flattening away the upstream insertion/formatting protocol.
                    inputs = {key: row[key] for key in ("context", "code", "error")}
                    if any(not isinstance(value, list) or not all(isinstance(v, str) for v in value)
                           for value in inputs.values()):
                        raise ValueError("CodeQA expects lists of text segments")
                else:
                    inputs = {key: text_field(row, key) for key in ("context", "question")}
                annotations = {"task": spec["task"], "source_label": "clean_task_context",
                               "reference_answer": row["ideal"],
                               "attribution": {key: value for key, value in row.items() if key.endswith("_url")}}
            elif adapter == "bipia_payload":
                protocol = "injection_payload_component"
                upstream_id = f"{row['category']}:{row['variant']}"
                inputs = {"untrusted_payload": text_field(row, "payload")}
                annotations = {"task": spec["task"], "category": row["category"], "source_label": "attack_payload"}
            else:
                raise ValueError(f"Unsupported dataset adapter: {adapter}")
            # Source filename makes row-index IDs stable across official splits/tasks.
            samples.append(Sample(f"{spec['dataset']}:{spec['path']}:{upstream_id}", spec["dataset"],
                spec["split"], protocol, spec["path"], spec["sha256"], upstream_id, inputs, annotations))
        if len(samples) - start != spec["expected_records"]:
            raise ValueError(f"Unexpected source record count: {spec['path']}")
    if len({sample.id for sample in samples}) != len(samples):
        raise ValueError("Duplicate sample IDs")
    return samples


def audit(samples: list[Sample]) -> dict:
    exact, normalized = defaultdict(list), defaultdict(list)
    for sample in samples:
        if sample.protocol == "harmful_goal":
            text = sample.inputs["user_request"]
            exact[sha256(text.encode())].append(sample.id)
            normalized[sha256(" ".join(text.casefold().split()).encode())].append(sample.id)
    return {"records": len(samples), "by_dataset": dict(Counter(s.dataset for s in samples)),
            "by_dataset_split_protocol": dict(Counter(f"{s.dataset}/{s.split}/{s.protocol}" for s in samples)),
            "exact_goal_duplicate_groups": [ids for ids in exact.values() if len(ids) > 1],
            "normalized_goal_duplicate_groups": [ids for ids in normalized.values() if len(ids) > 1],
            "duplicate_policy": "audit_only_keep_all_official_rows; normalized_text_never_sent_to_target",
            "independence": "not_established; exact deduplication does not remove semantic/training overlap",
            "false_positive_controls": "not_in_harmful_goal_tracks; add separately versioned benign controls",
            "component_counts_are_scenario_counts": False}


def select_goals(samples: list[Sample], *, splits: list[str], limit: int | None = None) -> list[Sample]:
    if not splits or len(splits) != len(set(splits)):
        raise ValueError("Choose explicit unique splits")
    if limit is not None and limit < 1:
        raise ValueError("Limit must be positive")
    eligible = [s for s in samples if s.protocol == "harmful_goal" and s.split in splits]
    selected, counts = [], Counter()
    # Source order is deterministic; a capped run is a smoke test, not random sampling.
    for sample in eligible:
        if limit is None or counts[sample.dataset] < limit:
            selected.append(sample)
            counts[sample.dataset] += 1
    if not selected:
        raise ValueError("No harmful-goal samples in the selected official splits")
    return selected


def prepare(output: Path, lock: dict, specs: list[dict], samples: list[Sample], tracks: list[str]) -> dict:
    # Never overwrite a previous data preparation or run.
    output.mkdir(parents=True, exist_ok=False)
    payload = "".join(json.dumps(s.record(), ensure_ascii=False, allow_nan=False) + "\n" for s in samples).encode()
    (output / "samples.jsonl").write_bytes(payload)
    version = {"schema_version": 1, "catalog_version": lock["catalog_version"],
               "catalog_sha256": canonical_hash(lock), "tracks": tracks,
               "sources": specs, "samples_sha256": sha256(payload),
               "adapter_sha256": sha256(Path(__file__).read_bytes()),
               "coverage": [t for t in lock["tracks"] if t["id"] in tracks]}
    write_json(output / "dataset-version.json", version)
    write_json(output / "audit.json", audit(samples))
    return version


def score_results(samples: list[Sample], rows: list[dict]) -> dict:
    """Action coverage only. Never infer ASR or count fail-closed as a hit."""
    expected = {sample.id: sample for sample in samples}
    if not samples or len(expected) != len(samples) or any(s.protocol != "harmful_goal" for s in samples):
        raise ValueError("Scorer requires unique harmful-goal samples")
    seen, valid = set(), []
    for row in rows:
        if row["id"] not in expected or row["id"] in seen:
            raise ValueError("Unknown or duplicate result ID")
        seen.add(row["id"])
        sample = expected[row["id"]]
        if row.get("text_sha256") != sha256(sample.inputs["user_request"].encode()):
            raise ValueError("Result input hash differs from selected sample")
        checked = {**row, "expected": "block_reference"}
        valid.append(normalize(checked))
    def grouped(key):
        groups = {}
        for name in sorted({key(s) for s in samples}):
            group = summarize_actions([r for r in valid if key(expected[r["id"]]) == name],
                expected_cases=[{"id": s.id, "expected": "block_reference"} for s in samples if key(s) == name])
            group["raw_goal_block_rate_valid_responses"] = (
                group["blocked_reference"] / group["block_reference_n"] if group["block_reference_n"] else None)
            groups[name] = group
        return groups

    groups = grouped(lambda s: s.dataset)
    return {"scorer": SCORER, "groups": groups, "missing": len(samples) - len(seen),
            "by_dataset_split": grouped(lambda s: f"{s.dataset}/{s.split}"),
            "target_model_asr": None, "false_positive_rate": None,
            "status": "complete" if len(samples) == len(seen) else "incomplete"}


def replay(output: Path, selected: list[Sample], version: dict, args: argparse.Namespace) -> dict:
    from scripts.evaluate_default_public import (
        Case, build_default_plan, environment_snapshot, evaluate_cases, model_providers,
        save_implementation, source_code_fingerprint, utc_now,
    )

    if not 0 < len(selected) <= args.max_cases:
        raise ValueError("Selected case count exceeds --max-cases")
    built = build_default_plan(local_components_only=args.local_components_only,
                               frozen_plan=args.frozen_plan, snapshot_sha256=args.snapshot_sha256)
    providers, model_evidence = model_providers(args.model_config, args.credential_env) if args.model_config else (None, None)
    target = {**target_identity({"default": built["plan"]},
              scope="frozen_snapshot" if args.frozen_plan else ("local_components_only" if args.local_components_only else "local_default"),
              snapshot_sha256=args.snapshot_sha256, models=model_evidence, local_only=not bool(args.model_config)),
              "kind": "frozen_snapshot" if args.frozen_plan else ("local_components_ablation" if args.local_components_only else "current_default"),
              "adapter": "DraftPreviewRuntime/input", "plan_sha256": canonical_hash(built["plan"]),
              "detection_models": model_evidence, "generation_model": None,
              "product_configuration_mutated": False}
    implementation, environment = source_code_fingerprint(), environment_snapshot()
    # Include this test entry point and its source lock in the executable archive.
    implementation["files"].update({str(path.relative_to(ROOT)): sha256(path.read_bytes())
                                    for path in (Path(__file__), LOCK)})
    implementation["combined_sha256"] = canonical_hash(implementation["files"])
    run = {"schema_version": 1, "started_at": utc_now(), "dataset_version": version,
           "target": target, "scorer": SCORER, "scorer_sha256": canonical_hash(SCORER),
           "selected": [{"id": s.id, "sample_sha256": s.record()["sample_sha256"]} for s in selected],
           "selection": {"protocol": "harmful_goal", "splits": args.splits,
                         "limit_per_dataset": args.limit_per_dataset,
                         "scope": "smoke" if args.limit_per_dataset else "selected_official_splits"},
           "implementation": implementation, "environment": environment}
    write_json(output / "run.json", run)
    write_json(output / "plan.json", built)
    save_implementation(output, implementation, environment)
    cases = [Case(id=s.id, source=s.dataset, split=s.split, phase="input", text=s.inputs["user_request"],
                  label=s.annotations["source_label"], categories=(s.annotations.get("semantic_category", "unlabeled"),),
                  expected="block_reference", mapping_reason=SCORER["label_mapping"],
                  metadata={"sample_sha256": s.record()["sample_sha256"], "protocol": s.protocol}) for s in selected]
    rows = asyncio.run(evaluate_cases(cases, built["plan"], output, args.concurrency, providers=providers))
    report = score_results(selected, rows)
    current = source_code_fingerprint()["files"]
    current.update({str(path.relative_to(ROOT)): sha256(path.read_bytes()) for path in (Path(__file__), LOCK)})
    report["source_changed_during_run"] = implementation["files"] != current
    report["harness_changed_during_run"] = version["adapter_sha256"] != sha256(Path(__file__).read_bytes())
    report["results_sha256"] = sha256((output / "results.jsonl").read_bytes())
    write_json(output / "summary.json", report)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("catalog", "prepare", "replay"))
    parser.add_argument("--tracks", nargs="+", help="Default: all for prepare; explicit goal tracks for replay")
    parser.add_argument("--sources", type=Path, default=DEFAULT_SOURCES)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--protocol", choices=("harmful_goal",), help="Required for replay; other protocols are inventory only")
    parser.add_argument("--splits", nargs="+", help="Official splits: test, val, dev, train, unspecified")
    parser.add_argument("--limit-per-dataset", type=int)
    parser.add_argument("--max-cases", type=int, help="Explicit request budget for replay")
    parser.add_argument("--concurrency", type=int, choices=range(1, 9), default=1)
    target = parser.add_mutually_exclusive_group()
    target.add_argument("--local-components-only", action="store_true")
    target.add_argument("--model-config", type=Path)
    parser.add_argument("--frozen-plan", type=Path)
    parser.add_argument("--snapshot-sha256")
    parser.add_argument("--credential-env", action="append", default=[], metavar="REF=ENV_NAME")
    args = parser.parse_args(argv)
    if bool(args.frozen_plan) != bool(args.snapshot_sha256):
        parser.error("--frozen-plan and --snapshot-sha256 must be supplied together")
    lock = catalog()
    if args.command == "catalog":
        print(json.dumps({"version": lock["catalog_version"], "tracks": lock["tracks"]}, ensure_ascii=False, indent=2))
        return 0
    if args.output is None:
        parser.error("--output must name a fresh directory")
    if args.output.exists():
        parser.error("--output already exists; choose a fresh directory")
    if args.command == "replay":
        if not args.tracks or set(args.tracks) - {"advbench", "tdc2023", "harmbench"}:
            parser.error("Replay supports explicit advbench/tdc2023/harmbench goal tracks only; use prepare for scenario inventories")
        if not args.protocol or not args.splits or not args.max_cases or args.max_cases < 1:
            parser.error("Replay requires --protocol harmful_goal, --splits and positive --max-cases")
        if args.local_components_only and args.model_config:
            parser.error("Local-only evaluation cannot use --model-config")
        if args.credential_env and not args.model_config:
            parser.error("--credential-env requires --model-config")
    elif args.model_config or args.local_components_only or args.credential_env or args.frozen_plan:
        parser.error("Target configuration is only used by replay")
    tracks = args.tracks or [t["id"] for t in lock["tracks"]]
    specs = select_files(lock, tracks)
    verify_sources(args.sources, specs, download=args.download)
    samples = load_samples(args.sources, specs)
    selected = select_goals(samples, splits=args.splits, limit=args.limit_per_dataset) if args.command == "replay" else []
    if args.command == "replay" and (len(selected) > args.max_cases or set(args.tracks) != {s.dataset for s in selected}):
        parser.error("Budget exceeded or a requested track has no samples in --splits; no calls made")
    version = prepare(args.output, lock, specs, samples, tracks)
    if args.command == "replay":
        report = replay(args.output, selected, version, args)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return int(bool(report["missing"] or report["source_changed_during_run"] or report["harness_changed_during_run"]
                        or any(g["execution_errors"] or g["indeterminate"] for g in report["groups"].values())))
    print(json.dumps({"output": str(args.output.resolve()), "audit": audit(samples)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
