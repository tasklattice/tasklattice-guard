"""Evaluation-harness accounting only; synthetic evidence is not model quality."""
from copy import deepcopy

import pytest

from scripts.evaluate_model_holdout import classify_result, summarize, validate_corpus, main


def corpus():
    return {"guardrail_id": "fixture", "guardrail_version": "20260906-120000.001Z",
        "effective_release_id": "release-1", "model_revision_id": "model-1",
        "runtime_config_checksum": "a" * 64, "endpoint_id": "fixture-endpoint",
        "reviewed_by": "synthetic-test", "reviewed_at": "2026-09-06", "dataset_version": "fixture-1",
        "thresholds": {"max_false_positive_rate": 0, "max_false_negative_rate": 0, "min_cases_per_class": 1},
        "cases": [{"id": label, "phase": "output", "category": "content_safety", "expected": expected,
            "content": "private-fixture-content", "model_name": "guard-model", "capability": "content_safety"}
            for label, expected in (("benign", "allow"), ("unsafe", "block"))]}


def evidence():
    c = corpus()
    return {key: c[key] for key in ("guardrail_id", "guardrail_version", "effective_release_id", "model_revision_id")} | {
        "mode": "enforce", "decision": "block", "usage": {"config_checksum": "a" * 64, "fail_closed": False, "model_invocations": 1},
        "trace": [{"model_name": "guard-model", "capability": "content_safety", "rail_type": "output", "model_result": "success"}]}


@pytest.mark.parametrize("change,expected", [
    ("none", "true_positive"), ("fail_closed", "execution_failure"), ("trace_error", "execution_failure"),
    ("wrong_version", "configuration_drift"), ("wrong_model_revision", "configuration_drift"),
    ("wrong_checksum", "configuration_drift"), ("no_model", "missing_model_evidence"),
    ("other_model", "missing_model_evidence"), ("other_phase", "missing_model_evidence"),
    ("observe", "not_enforcing"), ("transform", "unsupported_decision"), ("miss", "false_negative"),
])
def test_requires_matching_execution_and_real_call_evidence(change, expected):
    result = evidence()
    if change == "fail_closed": result["usage"]["fail_closed"] = True
    if change == "trace_error": result["trace"].append({"status": "error"})
    if change == "wrong_version": result["guardrail_version"] = "other"
    if change == "wrong_model_revision": result["model_revision_id"] = "other"
    if change == "wrong_checksum": result["usage"]["config_checksum"] = "b" * 64
    if change == "no_model": result["usage"]["model_invocations"] = 0
    if change == "other_model": result["trace"][0]["model_name"] = "business-model"
    if change == "other_phase": result["trace"][0]["rail_type"] = "input"
    if change == "observe": result["mode"] = "observe"
    if change == "transform": result["decision"] = "transform"
    if change == "miss": result["decision"] = "allow"
    assert classify_result(corpus(), corpus()["cases"][1], result) == expected


@pytest.mark.parametrize("unsafe_outcome,passed", [("true_positive", True), ("http_503", False), ("false_negative", False)])
def test_errors_are_not_successful_detections(unsafe_outcome, passed):
    c = corpus()
    validate_corpus(c)
    report = summarize(c, [{"id": "benign", "outcome": "true_negative"}, {"id": "unsafe", "outcome": unsafe_outcome}])
    assert report["passed"] is passed
    if unsafe_outcome == "http_503":
        group = report["groups"]["content_safety/output"]
        assert group["errors"] == 1 and group["true_positive"] == 0
        assert group["false_negative_rate"] is None


def test_missing_samples_and_false_positives_cannot_pass():
    assert not summarize(corpus(), [{"id": "benign", "outcome": "true_negative"}])["passed"]
    result = summarize(corpus(), [{"id": "benign", "outcome": "false_positive"}, {"id": "unsafe", "outcome": "true_positive"}])
    assert result["groups"]["content_safety/output"]["false_positive_rate"] == 1
    assert not result["passed"]


@pytest.mark.parametrize("change", ["missing_benign", "duplicate", "too_small", "nan_threshold", "negative_threshold"])
def test_corpus_rejects_unreviewable_sample_accounting(change):
    c = deepcopy(corpus())
    if change == "missing_benign": c["cases"] = c["cases"][1:]
    if change == "duplicate": c["cases"][1]["id"] = "benign"
    if change == "too_small": c["thresholds"]["min_cases_per_class"] = 2
    if change == "nan_threshold": c["thresholds"]["max_false_positive_rate"] = float("nan")
    if change == "negative_threshold": c["thresholds"]["max_false_negative_rate"] = -1
    with pytest.raises(ValueError): validate_corpus(c)


@pytest.mark.parametrize("allow,limit", [(False, 2), (True, 1)])
def test_no_network_without_opt_in_and_sufficient_explicit_budget(tmp_path, monkeypatch, allow, limit):
    import json
    import scripts.evaluate_model_holdout as module
    path = tmp_path / "corpus.json"
    path.write_text(json.dumps(corpus()))
    monkeypatch.setattr("sys.argv", ["holdout", str(path), "--runner", "http://127.0.0.1:8094", "--max-cases", str(limit)])
    monkeypatch.setenv("GUARD_HOLDOUT_ALLOW_MODEL_CALLS", "1" if allow else "0")
    monkeypatch.setattr(module, "build_opener", lambda *_: pytest.fail("Network setup must not happen"))
    with pytest.raises(ValueError): main()


@pytest.mark.parametrize("drift", [False, True])
def test_cli_emits_redacted_report_and_stops_on_configuration_drift(tmp_path, monkeypatch, capsys, drift):
    import io
    import json
    import scripts.evaluate_model_holdout as module
    c = corpus()
    path = tmp_path / "corpus.json"
    path.write_text(json.dumps(c))
    monkeypatch.setattr("sys.argv", ["holdout", str(path), "--runner", "http://127.0.0.1:8094", "--max-cases", "2"])
    monkeypatch.setenv("GUARD_HOLDOUT_ALLOW_MODEL_CALLS", "1")
    monkeypatch.setenv("GUARD_HOLDOUT_ENDPOINT_KEY", "private-fixture-token")
    requests = []
    class Transport:
        def open(self, request, timeout):
            payload = json.loads(request.data)
            assert payload["phase"] == "output" and payload["mode"] == "enforce"
            assert request.get_header("X-api-key") == "private-fixture-token"
            assert timeout == 30
            result = evidence()
            result["decision"] = "allow" if not requests else "block"
            result["reason"] = "private-backend-response"
            if drift: result["model_revision_id"] = "changed"
            requests.append(payload)
            return io.BytesIO(json.dumps(result).encode())
    monkeypatch.setattr(module, "build_opener", lambda *_: Transport())
    assert main() == (1 if drift else 0)
    output = capsys.readouterr().out
    report = json.loads(output)
    assert report["passed"] is not drift
    assert len(requests) == (1 if drift else 2)
    assert "private-" not in output
    assert len(report["corpus_sha256"]) == 64


def test_redirects_cannot_forward_endpoint_credentials():
    from scripts.evaluate_model_holdout import NoRedirect
    assert NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.example") is None
