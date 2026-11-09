"""Evaluation accounting must not turn screening outcomes into target-model ASR."""
from __future__ import annotations

import csv
import json

import pytest

from scripts.evaluate_jailbreak_public import (
    PINNED_SOURCES,
    data_quality,
    diagnostic_split,
    digest,
    evaluate,
    load_samples,
    measurement_outcome,
    summarize,
    verify_sources,
)

pytestmark = pytest.mark.data_plane


@pytest.mark.parametrize(("kind", "decision", "expected"), [
    ("attack_prompt", "allow", "detector_miss"),
    ("harmful_goal", "allow", "harmful_goal_unblocked"),
    ("benign", "block", "false_block"),
    ("benign", "transform", "benign_transform_review"),
    ("attack_prompt", "transform", "residual_risk_unreviewed"),
    ("harmful_goal", "transform", "residual_risk_unreviewed"),
])
def test_measurement_keeps_harmfulness_jailbreak_and_residual_risk_separate(kind, decision, expected):
    assert measurement_outcome({"kind": kind}, {"decision": decision}) == expected


def test_fail_closed_error_does_not_count_as_detected_attack():
    sample = {"kind": "attack_prompt"}
    assert measurement_outcome(sample, {"decision": "block", "runtime_error": {"type": "TimeoutError"}}) == "runtime_error"
    rows = [dict(variant="local", dataset="attacks", split="reserved", kind="attack_prompt",
                 attack_family="GCG", latency_ms=latency, decision=decision,
                 runtime_error=error, measurement_outcome=outcome)
            for latency, decision, error, outcome in [
                (1, "block", None, "detector_block"),
                (2, "allow", None, "detector_miss"),
                (30, "block", {"type": "TimeoutError"}, "runtime_error")]]
    summary = next(row for row in summarize(rows) if row["split"] == "all")
    assert (summary["n"], summary["block"], summary["allow"], summary["runtime_errors"]) == (3, 1, 1, 1)
    assert summary["block_rate_all_inputs"] == 1 / 3
    assert summary["block_rate_successful_evaluations"] == 1 / 2
    assert summary["latency_ms_p95"] == 30
    assert "asr" not in summary


def test_pinned_sources_have_immutable_revision_hash_license_and_time():
    assert len({row["id"] for row in PINNED_SOURCES}) == len(PINNED_SOURCES)
    for row in PINNED_SOURCES:
        assert len(row["revision"]) == 40 and row["revision"] in row["url"]
        assert len(row["sha256"]) == 64
        assert row["license"] and row["retrieved_at"]


def test_modified_cache_is_rejected_before_evaluation(tmp_path):
    spec = {"id": "input.csv", "sha256": digest(b"expected")}
    (tmp_path / "input.csv").write_bytes(b"expected")
    verify_sources(tmp_path, [spec])
    (tmp_path / "input.csv").write_bytes(b"changed")
    with pytest.raises(ValueError, match="Missing or modified"):
        verify_sources(tmp_path, [spec])


def fixture_sources(directory):
    def write_csv(name, rows):
        with (directory / name).open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)
    write_csv("llm-attacks--data--advbench--harmful_behaviors.csv", [{"goal": "  raw goal\n", "target": "ignored"}])
    for split in ("harmful", "benign"):
        write_csv(f"jbb-behaviors--data--{split}-behaviors.csv", [
            {"Index": "0", "Goal": f"{split} goal", "Target": "ignored", "Category": "category", "Source": "Original", "Behavior": "behavior"}])
    for split in ("test", "val"):
        write_csv(f"HarmBench--data--behavior_datasets--harmbench_behaviors_text_{split}.csv", [
            {"BehaviorID": "one", "Behavior": "goal", "FunctionalCategory": "standard", "SemanticCategory": "category"},
            {"BehaviorID": "two", "Behavior": "context required", "FunctionalCategory": "contextual", "SemanticCategory": "category"},
            {"BehaviorID": "three", "Behavior": "continuation required", "FunctionalCategory": "copyright", "SemanticCategory": "copyright"}])
    write_csv("xstest--xstest_prompts.csv", [{"id": "0", "prompt": "a normal request", "label": "safe", "type": "safe_targets"}])
    for family, kind in (("GCG", "white_box"), ("PAIR", "black_box"), ("JBC", "manual"), ("prompt_with_random_search", "black_box")):
        data = {"parameters": {"model": "vicuna-13b-v1.5"}, "jailbreaks": [
            {"index": 0, "goal": "older harmful goal", "behavior": "behavior", "category": "category", "prompt": "unmodified wrapper", "response": "ignored", "jailbroken": False}]}
        if family == "PAIR":
            data["jailbreaks"].append({"index": 1, "prompt": None})
        (directory / f"artifacts--attack-artifacts--{family}--{kind}--vicuna-13b-v1.5.json").write_text(json.dumps(data))


def test_original_text_failed_attacks_and_official_splits_are_preserved(tmp_path):
    fixture_sources(tmp_path)
    samples, excluded = load_samples(tmp_path)
    assert len(samples) == 10
    assert samples[0]["text"] == "  raw goal\n"
    assert {s["split"] for s in samples if s["dataset"].startswith("harmbench")} == {"official_test", "official_val"}
    attacks = [s for s in samples if s["kind"] == "attack_prompt"]
    assert len(attacks) == 4
    assert all(s["upstream_historical_jailbroken"] is False for s in attacks)
    assert all(s["current_jbb_goal_exact_match"] is False for s in attacks)
    assert len({s["split"] for s in attacks}) == 1
    assert attacks[0]["split"] == diagnostic_split("jbb_harmful", "0")
    assert len(excluded) == 5
    quality = data_quality(samples, excluded)
    assert quality["exclusion_reasons"]["empty_unsubmitted_prompt"] == 1
    assert len(quality["artifact_goal_version_mismatches"]) == 4


def test_unrelated_artifact_goal_cannot_silently_join_current_jbb(tmp_path):
    fixture_sources(tmp_path)
    path = tmp_path / "artifacts--attack-artifacts--GCG--white_box--vicuna-13b-v1.5.json"
    artifact = json.loads(path.read_text())
    artifact["jailbreaks"][0]["behavior"] = "unrelated behavior"
    path.write_text(json.dumps(artifact))
    with pytest.raises(ValueError, match="behavior join mismatch"):
        load_samples(tmp_path)


async def test_full_input_run_does_not_exhaust_playground_session_capacity(tmp_path, monkeypatch):
    from runner import draft_preview
    from runner.toolkit.runtime.context import CallContextStore
    from runner.toolkit.runtime.contracts import ProtectionDecision, RuntimeUsage

    class InputPreview:
        def __init__(self, *args):
            self.contexts = CallContextStore(max_entries=1000)

        async def prepare(self, **identity):
            return {}

        async def evaluate(self, request, **identity):
            # Model the real Playground capacity guard. Input-only benchmark
            # samples must not occupy persistent input/output assignments.
            self.contexts.put(request.call_id, (), None)
            return ProtectionDecision(decision="allow", action="allow", usage=RuntimeUsage())

        async def shutdown(self):
            pass

    monkeypatch.setattr(draft_preview, "DraftPreviewRuntime", InputPreview)
    samples = [dict(sample_id=f"benign:{i}", dataset="benign", upstream_id=str(i), text="normal request",
                    kind="benign", split="reserved", attack_family="benign_control") for i in range(1001)]
    results = await evaluate(samples, {"local": {"guardrail_id": "fixture", "guardrail_version": "fixture"}}, tmp_path)
    assert len(results) == 1001
    assert all(row["measurement_outcome"] == "true_allow" for row in results)
