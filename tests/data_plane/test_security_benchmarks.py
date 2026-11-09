"""Offline benchmark contracts; synthetic rows never establish model quality."""
from dataclasses import replace
import json

import pytest

from scripts import evaluate_security_benchmarks as evaluation


def source(tmp_path, adapter, rows, *, split="test", task=None):
    path = tmp_path / ("fixture.jsonl" if adapter == "bipia_context" else "fixture.json")
    if adapter in {"advbench", "harmbench"}:
        import csv
        path = tmp_path / "fixture.csv"
        with path.open("w", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=rows[0])
            writer.writeheader()
            writer.writerows(rows)
    else:
        path.write_text("".join(json.dumps(r) + "\n" for r in rows) if adapter == "bipia_context" else json.dumps(rows))
    count = sum(map(len, rows.values())) if adapter == "bipia_payload" else len(rows)
    return {"dataset": adapter if not adapter.startswith("bipia") else "bipia", "path": path.name,
            "sha256": evaluation.sha256(path.read_bytes()), "bytes": path.stat().st_size,
            "revision": "a" * 40, "url": "https://raw.githubusercontent.com/owner/repo/" + "a" * 40 + "/fixture",
            "role": "data", "adapter": adapter, "split": split, "task": task, "expected_records": count}


def goal(id="one", text="A synthetic harmful goal", split="test"):
    return evaluation.Sample(id, "fixture", split, "harmful_goal", "fixture.json", "a" * 64, id,
                             {"user_request": text}, {"source_label": "harmful_behavior"})


def result(sample, **changes):
    return {"id": sample.id, "text_sha256": evaluation.sha256(sample.inputs["user_request"].encode()),
            "status": "complete", "decision": "block", "fail_closed": False, "error_types": [], **changes}


def test_advbench_target_is_annotation_not_sent_to_guard(tmp_path):
    spec = source(tmp_path, "advbench", [{"goal": "  Raw\nGoal  ", "target": "Optimization prefix"}])
    sample, = evaluation.load_samples(tmp_path, [spec])
    assert sample.inputs == {"user_request": "  Raw\nGoal  "}
    assert sample.annotations["reference_target"] == "Optimization prefix"


def test_tdc_official_split_and_raw_text_survive(tmp_path):
    spec = source(tmp_path, "tdc2023", ["  Original\nbehavior "], split="dev")
    sample, = evaluation.load_samples(tmp_path, [spec])
    assert sample.split == "dev"
    assert sample.inputs["user_request"] == "  Original\nbehavior "


def test_harmbench_context_and_copyright_cannot_be_flattened_into_goal_replay(tmp_path):
    spec = source(tmp_path, "harmbench", [{"BehaviorID": kind, "Behavior": "Goal",
        "FunctionalCategory": kind, "SemanticCategory": "fixture", "ContextString": "Original context",
        "Tags": "tag"} for kind in ("standard", "contextual", "copyright")])
    samples = evaluation.load_samples(tmp_path, [spec])
    assert [s.protocol for s in samples] == ["harmful_goal", "contextual_behavior", "copyright_behavior"]
    assert all(s.inputs["context"] == "Original context" for s in samples)
    assert evaluation.select_goals(samples, splits=["test"]) == samples[:1]


def test_bipia_keeps_trust_boundary_and_answer_out_of_inputs(tmp_path):
    spec = source(tmp_path, "bipia_context", [{"context": "External material", "question": "User task",
        "ideal": "Expected answer"}], task="email")
    sample, = evaluation.load_samples(tmp_path, [spec])
    assert sample.protocol == "injection_context_component"
    assert sample.inputs == {"context": "External material", "question": "User task"}
    assert sample.annotations["reference_answer"] == "Expected answer"
    with pytest.raises(ValueError, match="No harmful-goal"):
        evaluation.select_goals([sample], splits=["test"])


def test_codeqa_segment_lists_and_author_attribution_are_preserved(tmp_path):
    row = {"code": ["line1", "line2"], "error": ["error"], "context": ["suggestion"],
           "ideal": ["answer"], "context_url": "https://example.test/question",
           "context_author_url": ["https://example.test/author"]}
    spec = source(tmp_path, "bipia_context", [row], task="code")
    sample, = evaluation.load_samples(tmp_path, [spec])
    assert sample.inputs["code"] == row["code"]
    assert sample.annotations["attribution"]["context_author_url"] == row["context_author_url"]


def test_payloads_are_components_not_complete_attack_scenarios(tmp_path):
    spec = source(tmp_path, "bipia_payload", {"test category": ["payload one", "payload two"]}, task="text")
    samples = evaluation.load_samples(tmp_path, [spec])
    assert len(samples) == 2
    assert {s.protocol for s in samples} == {"injection_payload_component"}
    assert evaluation.audit(samples)["component_counts_are_scenario_counts"] is False


def test_source_hash_pin_and_offline_default(tmp_path, monkeypatch):
    spec = source(tmp_path, "tdc2023", ["fixture"])
    monkeypatch.setattr(evaluation, "urlopen", lambda *a, **k: pytest.fail("Unexpected network"))
    evaluation.verify_sources(tmp_path, [spec])
    (tmp_path / spec["path"]).write_text("tampered")
    with pytest.raises(ValueError, match="hash/size mismatch"):
        evaluation.verify_sources(tmp_path, [spec], download=True)
    with pytest.raises(FileNotFoundError, match="--download"):
        evaluation.verify_sources(tmp_path, [{**spec, "path": "missing.json"}])
    with pytest.raises(ValueError, match="Git revision"):
        evaluation.verify_sources(tmp_path, [{**spec, "revision": "main"}])


def test_duplicate_audit_keeps_original_rows_and_does_not_change_inputs():
    samples = [goal("a", "One goal", "dev"), goal("b", "One goal", "test"), goal("c", "  ONE  goal  ")]
    report = evaluation.audit(samples)
    assert report["exact_goal_duplicate_groups"] == [["a", "b"]]
    assert report["normalized_goal_duplicate_groups"] == [["a", "b", "c"]]
    assert samples[2].inputs["user_request"] == "  ONE  goal  "


def test_input_hash_ignores_annotations_but_sample_hash_tracks_label_changes():
    original = goal()
    relabeled = replace(original, annotations={"source_label": "corrected"})
    assert original.record()["input_sha256"] == relabeled.record()["input_sha256"]
    assert original.record()["sample_sha256"] != relabeled.record()["sample_sha256"]


def test_scorer_separates_errors_transforms_and_missing_samples():
    samples = [goal(str(i)) for i in range(6)]
    rows = [result(samples[0]), result(samples[1], fail_closed=True),
            result(samples[2], decision="transform"), result(samples[3], decision="allow"),
            result(samples[4], error_types=["provider_error"])]
    report = evaluation.score_results(samples, rows)
    group = report["groups"]["fixture"]
    assert (group["blocked_reference"], group["execution_errors"], group["unresolved_transforms"], group["missing"]) == (1, 2, 1, 1)
    assert group["raw_goal_block_rate_valid_responses"] == 1 / 3
    assert report["status"] == "incomplete"
    assert report["target_model_asr"] is None and report["false_positive_rate"] is None


@pytest.mark.parametrize("change", ["duplicate", "unknown", "hash"])
def test_scorer_rejects_unmatched_execution_evidence(change):
    sample = goal()
    rows = [result(sample)]
    if change == "duplicate": rows *= 2
    if change == "unknown": rows[0]["id"] = "other"
    if change == "hash": rows[0]["text_sha256"] = "b" * 64
    with pytest.raises(ValueError):
        evaluation.score_results([sample], rows)


def test_all_errors_do_not_produce_zero_or_perfect_detection_rate():
    sample = goal()
    report = evaluation.score_results([sample], [result(sample, status="execution_error")])
    assert report["groups"]["fixture"]["raw_goal_block_rate_valid_responses"] is None


def test_replay_budget_and_scenario_rejection_happen_before_runtime(tmp_path, monkeypatch):
    monkeypatch.setattr(evaluation, "replay", lambda *a: pytest.fail("Runtime must not be called"))
    with pytest.raises(SystemExit):
        evaluation.main(["replay", "--tracks", "memory_poisoning", "--output", str(tmp_path / "run")])
    with pytest.raises(SystemExit):
        evaluation.main(["replay", "--tracks", "advbench", "--output", str(tmp_path / "run"),
                         "--protocol", "harmful_goal", "--splits", "unspecified", "--max-cases", "0"])


def test_preparation_is_immutable_and_memory_is_catalogued_without_fake_samples(tmp_path):
    lock = evaluation.catalog()
    specs = evaluation.select_files(lock, ["memory_poisoning"])
    assert {s["dataset"] for s in specs} == {"agentpoison", "minja"}
    assert all(s["role"] == "reference" for s in specs)
    samples = evaluation.load_samples(tmp_path, specs)
    assert samples == []
    output = tmp_path / "prepared"
    evaluation.prepare(output, lock, specs, samples, ["memory_poisoning"])
    with pytest.raises(FileExistsError):
        evaluation.prepare(output, lock, specs, samples, ["memory_poisoning"])
