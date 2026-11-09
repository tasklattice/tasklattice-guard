"""Regression contracts for target identity, statuses and denominator parity."""
import json

import pytest

from scripts import evaluate_default_public as content
from scripts import evaluate_jailbreak_public as jailbreak
from scripts import evaluate_security_benchmarks as goals
from scripts.evaluation_contract import digest, execution_status, summarize_actions, target_identity


def goal_sample(identity):
    return goals.Sample(identity, "fixture", "all", "harmful_goal", "fixture", "a" * 64,
                        identity, {"user_request": "Synthetic request"}, {})


def row(identity, **changes):
    return dict(id=identity, sample_id=identity, expected="block_reference", variant="local",
                dataset="fixture", split="all", kind="harmful_goal", attack_family="raw_goal",
                status="complete", decision="block", fail_closed=False, error_types=[], latency_ms=1,
                text_sha256=digest(b"Synthetic request"), **changes)


@pytest.mark.parametrize("evidence,status", [
    ({}, "complete"),
    ({"status": "indeterminate"}, "indeterminate"),
    ({"model_trace": [{"kind": "action", "verdict": "unknown"}]}, "indeterminate"),
    ({"trace": [{"kind": "action", "verdict": "unknown"}]}, "indeterminate"),
    ({"findings": [{"verdict": "unknown"}]}, "indeterminate"),
    ({"fail_closed": True}, "execution_error"),
    ({"usage": {"fail_closed": True}}, "execution_error"),
    ({"error_types": ["InvalidVerdict"]}, "execution_error"),
    ({"trace": [{"timed_out": True}]}, "execution_error"),
    ({"trace": [{"kind": "action", "verdict": "error"}]}, "execution_error"),
    ({"runtime_error": {"type": "TimeoutError"}}, "execution_error"),
    ({"status": "indeterminate", "fail_closed": True}, "execution_error"),
    ({"decision": None}, "execution_error"),
])
def test_all_three_scorers_agree_on_runtime_evidence(evidence, status):
    sample = goal_sample("one")
    result = {**row("one"), **evidence}
    assert execution_status(result) == status
    reports = [content.summarize([result]), goals.score_results([sample], [result])["groups"]["fixture"],
               jailbreak.summarize([result])[0]]
    for report in reports:
        assert report["completed"] == int(status == "complete")
        assert report["execution_errors"] == int(status == "execution_error")
        assert report["indeterminate"] == int(status == "indeterminate")
        assert report["blocked_reference"] == int(status == "complete")
        assert report["rates"]["reference_block_rate_valid"] == (1 if status == "complete" else None)


def test_selected_denominator_keeps_errors_unknown_transforms_and_missing():
    selected = [{"id": str(i), "expected": "block_reference"} for i in range(6)]
    rows = [row("0"), {**row("1"), "status": "execution_error"},
            {**row("2"), "status": "indeterminate"}, {**row("3"), "decision": "transform"},
            {**row("4"), "decision": "allow"}]
    score = content.summarize(rows, expected_cases=selected)
    assert score["risk_population"] == dict(selected=6, attempted=5, valid=3, execution_errors=1, indeterminate=1, missing=1)
    assert score["rates"]["reference_block_rate_valid"] == 1 / 3
    assert score["rates"]["reference_block_rate_selected"] == 1 / 6
    assert score["unresolved_transforms"] == 1


@pytest.mark.parametrize("rows", [[row("unknown")], [row("one"), row("one")], [{**row("one"), "expected": "preserve"}]])
def test_unknown_duplicate_and_relabelled_results_are_rejected(rows):
    with pytest.raises(ValueError):
        summarize_actions(rows, expected_cases=[{"id": "one", "expected": "block_reference"}])


def test_jailbreak_missing_variant_and_all_split_do_not_disappear_or_double_count():
    samples = [row("one"), row("two")]
    reports = jailbreak.summarize([row("one")], samples=samples, variants=["local", "absent"])
    assert len(reports) == 2
    by_variant = {r["variant"]: r for r in reports}
    assert by_variant["local"]["selected"] == 2
    assert by_variant["local"]["missing"] == by_variant["local"]["blocked_reference"] == 1
    assert by_variant["local"]["block_rate_all_inputs"] == .5
    assert by_variant["absent"]["missing"] == 2
    assert by_variant["absent"]["block_rate_successful_evaluations"] is None
    assert by_variant["absent"]["latency_ms_max"] is None
    with pytest.raises(ValueError):
        jailbreak.summarize([row("one")], samples=samples, variants=["different"])


def plan(capability="builtin_content_filter"):
    return {"guardrail_id": "frozen", "guardrail_version": "old-version",
            "policy_bindings": [{"policy_id": "fixture", "policy_version": "1.0.0"}],
            "steps": [{"capability": capability}]}


def test_frozen_plan_bypasses_current_builder_and_requires_exact_digest(tmp_path, monkeypatch):
    frozen = tmp_path / "plan.json"
    frozen.write_text(json.dumps({"plan": plan()}))
    monkeypatch.setattr(content.subprocess, "run", lambda *a, **kw: pytest.fail("Frozen plan must not use current Default"))
    assert content.build_default_plan(local_components_only=True, frozen_plan=frozen,
        snapshot_sha256=digest(frozen.read_bytes()))["plan"] == plan()
    with pytest.raises(ValueError, match="requires"):
        content.build_default_plan(frozen_plan=frozen)
    with pytest.raises(ValueError, match="mismatch"):
        content.build_default_plan(frozen_plan=frozen, snapshot_sha256="0" * 64)
    with pytest.raises(ValueError, match="requires"):
        content.build_default_plan(snapshot_sha256="0" * 64)


def test_local_target_cannot_silently_strip_model_steps_and_identity_is_detached():
    with pytest.raises(ValueError, match="non-local"):
        target_identity({"default": plan("jailbreak")}, scope="local", local_only=True)
    original = plan()
    identity = target_identity({"default": original}, scope="frozen", local_only=True)
    original["policy_bindings"][0]["policy_version"] = "mutated"
    assert identity["variants"]["default"]["policy_bindings"][0]["policy_version"] == "1.0.0"


def test_local_target_accepts_other_registered_local_actions_without_rewriting_plan():
    original = plan("prompt_injection")
    target = target_identity({"local": original}, scope="local", local_only=True)
    assert target["variants"]["local"]["step_count"] == 1
    assert original["steps"] == [{"capability": "prompt_injection"}]
    with pytest.raises(ValueError, match="at least one"):
        target_identity({}, scope="local")


@pytest.mark.parametrize("entry,arguments", [
    (content.main, ["--local-components-only", "--model-config", "missing"]),
    (jailbreak.main, ["--diagnostics-only"]),
    (content.main, ["--local-components-only", "--snapshot-sha256", "0" * 64]),
    (jailbreak.main, ["--frozen-plans", "missing"]),
])
def test_cli_rejects_ambiguous_target_before_writing(entry, arguments, tmp_path):
    output = tmp_path / "new-run"
    with pytest.raises((SystemExit, ValueError)):
        entry([*arguments, "--output", str(output)])
    assert not output.exists()


@pytest.mark.parametrize("entry", [content.main, jailbreak.main])
def test_cli_preserves_partial_and_historical_artifacts(entry, tmp_path):
    artifact = tmp_path / "plan.json"
    artifact.write_bytes(b"historical evidence")
    with pytest.raises(SystemExit):
        entry(["--local-components-only", "--output", str(tmp_path)])
    assert artifact.read_bytes() == b"historical evidence"


async def test_jailbreak_prepares_all_variants_before_first_sample(tmp_path, monkeypatch):
    from runner import draft_preview
    seen = []
    class Preview:
        def __init__(self, *args): pass
        async def prepare(self, **identity):
            seen.append(identity["preview_id"])
            if len(seen) == 2:
                raise ValueError("Missing binding")
            return {}
        async def evaluate(self, *args, **kwargs): pytest.fail("No partial variant evaluation")
        async def shutdown(self): seen.append("shutdown")
    monkeypatch.setattr(draft_preview, "DraftPreviewRuntime", Preview)
    with pytest.raises(ValueError, match="Missing binding"):
        await jailbreak.evaluate([{"text": "fixture"}], {"first": plan(), "second": plan()}, tmp_path)
    assert seen[-1] == "shutdown"
    assert not (tmp_path / "results.jsonl").exists()
