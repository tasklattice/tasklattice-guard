from __future__ import annotations

import asyncio
import hashlib
import json
import threading
import time
from copy import deepcopy
from types import SimpleNamespace

import httpx
import pytest

from runner import builtin_laya, generated as protocol, resources
from runner.builtin_laya import BuiltinLaya, BuiltinLayaBusyError, BuiltinLayaInferenceError, _verify_checkpoint
from runner.capability_validation import validate_capability
from runner.evaluation_evidence import evaluation_evidence
from runner.model_bundle_contract import Bundle
from runner.model_validation_diagnostics import ValidationDiagnostics, capture_validation_case
from runner.toolkit.runtime.contracts import ProtectionDecision, RuntimeTraceStep


REVISION = "85cc74ddae6109077ebe2853a9b3077fb6606a78"
QUESTIONS = {"greeting": {"type": "noul", "instructions": "Does the text contain a greeting?"}}


@pytest.mark.parametrize(("budget", "capacity", "concurrency", "override", "expected"), [
    ("4000", 8, 1, None, 4),
    ("1500", 8, 1, None, 1),
    ("250", 8, 1, None, 1),
    ("8000", 2.5, 1, None, 2),
    ("8000", 8, 2, None, 4),
    ("4000", 8, 1, "3", 3),
    ("0", 3, 1, None, 3),
    (None, 6, 1, None, 6),
])
async def test_builtin_laya_sizes_torch_threads_to_cpu_budget(tmp_path, monkeypatch, budget, capacity,
                                                       concurrency, override, expected):
    for name, value in {"GUARD_RUNNER_CPU_MILLICORES": budget,
                        "GUARD_BUILTIN_LAYA_TORCH_THREADS": override}.items():
        if value is None:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, value)
    monkeypatch.setenv("GUARD_BUILTIN_LAYA_MODEL_PATH", str(tmp_path))
    monkeypatch.setenv("GUARD_BUILTIN_LAYA_INFERENCE_CONCURRENCY", str(concurrency))
    monkeypatch.setattr(builtin_laya, "cpu_capacity_cores", lambda: capacity)

    runtime = BuiltinLaya.from_env()
    assert runtime is not None
    try:
        assert runtime.torch_threads == expected
    finally:
        await runtime.close()


def test_cpu_capacity_respects_cgroup_quota_and_affinity(tmp_path, monkeypatch):
    monkeypatch.setattr(resources, "_CGROUP", tmp_path)
    monkeypatch.setattr(resources.os, "process_cpu_count", lambda: 4)
    assert resources.cpu_capacity_cores() == 4

    cpu_max = tmp_path / "cpu.max"
    cpu_max.write_text("250000 100000\n")
    assert resources.cpu_capacity_cores() == 2.5

    cpu_max.write_text("800000 100000\n")
    assert resources.cpu_capacity_cores() == 4

    cpu_max.unlink()
    legacy = tmp_path / "cpu,cpuacct"
    legacy.mkdir()
    (legacy / "cpu.cfs_quota_us").write_text("150000\n")
    (legacy / "cpu.cfs_period_us").write_text("100000\n")
    assert resources.cpu_capacity_cores() == 1.5


def test_checkpoint_manifest_rejects_changed_files(tmp_path):
    files = ["model.safetensors", "rl_agent_config.json", "encoder/config.json",
             "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json"]
    for name in files:
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(name)
    manifest = {"revision": REVISION, "files": {name: hashlib.sha256(name.encode()).hexdigest() for name in files}}
    (tmp_path / "model-manifest.json").write_text(json.dumps(manifest))
    assert _verify_checkpoint(tmp_path) == REVISION

    (tmp_path / "tokenizer/tokenizer.json").write_text("changed")
    with pytest.raises(ValueError, match="checksum mismatch for tokenizer/tokenizer.json"):
        _verify_checkpoint(tmp_path)


async def test_builtin_bundle_threshold_and_decision_identity(tmp_path):
    runtime = BuiltinLaya(tmp_path)
    runtime._bundle = Bundle(
        {"modelVersion": "candidate", "calibrationVersion": "cal-v1",
         "thresholdPolicyVersion": "policy-v1", "artifactSha256": "a" * 64},
        {},
        {"default": {"allow": 0.1, "block": 0.9},
         "categories": {"pii": {"allow": 0.05, "block": 0.75}}},
    )
    try:
        assert runtime.thresholds("pii", (0.2, 0.8)) == (0.05, 0.75)
        assert runtime.thresholds("content_safety", (0.2, 0.8)) == (0.1, 0.9)
        evidence = json.dumps({
            "model_metadata": {"backend": "builtin_laya", "runner_version": "runner-v1", **runtime.model_identity},
            "thresholds": {"lower": 0.05, "upper": 0.75},
        })
        step = RuntimeTraceStep(id="pii:laya", kind="evaluation", name="Laya PII", status="completed", detail="",
                                capability="pii", evaluator_id="laya-pii", verdict="matched", evidence=evidence)
        decision = ProtectionDecision(decision="transform", action="transform", guardrail_id="test",
                                      trace=(step,))
        [row] = json.loads(evaluation_evidence(decision))["layaEvaluations"]
        assert row["runnerVersion"] == "runner-v1"
        assert row["modelVersion"] == "candidate"
        assert row["calibrationVersion"] == "cal-v1"
        assert row["thresholdPolicyVersion"] == "policy-v1"
        assert row["thresholds"] == {"lower": 0.05, "upper": 0.75}
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_cancelled_builtin_call_holds_capacity_until_cpu_forward_finishes(tmp_path, monkeypatch):
    entered = threading.Event()
    release = threading.Event()
    calls = []

    def infer(state, questions, **kwargs):
        calls.append(state)
        if state == "first":
            entered.set()
            assert release.wait(5)
        return {"model": "laya"}

    runtime = BuiltinLaya(tmp_path, concurrency=1, queue_capacity=1)
    monkeypatch.setattr(runtime, "_load", lambda: (REVISION, SimpleNamespace(system_one=infer)))
    await runtime.start()

    async def predict(text):
        return await runtime.predict(text, QUESTIONS, max_len=1024, head_max_len=512, deadline=time.monotonic() + 5)

    try:
        first = asyncio.create_task(predict("first"))
        assert await asyncio.to_thread(entered.wait, 5)
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first

        second = asyncio.create_task(predict("second"))
        await asyncio.sleep(0)
        with pytest.raises(BuiltinLayaBusyError):
            await predict("queue-full")
        assert calls == ["first"] and not second.done()

        release.set()
        assert await second == {"model": "laya"}
        assert calls == ["first", "second"]
    finally:
        release.set()
        await runtime.close()


@pytest.mark.asyncio
async def test_builtin_laya_rail_validation_uses_the_local_checkpoint(tmp_path, monkeypatch):
    calls = []

    def infer(state, questions, **kwargs):
        probability = 0.01 if state == "Have a pleasant day." else 0.99
        output = {"model": "laya", "answers": {
            key: {"type": "noul", "noul": probability} for key in questions
        }, "usage": {"input_tokens": 12, "output_tokens": 0}, "sdk_detail": {"opaque": True}}
        calls.append({"input": {"state": state, "questions": deepcopy(questions), **kwargs}, "output": deepcopy(output)})
        next(iter(questions.values()))["test_mutation"] = True
        return output

    def reject_http(_request):
        pytest.fail("Built-in Laya attempted an HTTP request")

    runtime = BuiltinLaya(tmp_path)
    monkeypatch.setattr(runtime, "_load", lambda: (REVISION, SimpleNamespace(system_one=infer)))
    await runtime.start()
    request = protocol.CapabilityValidationRequest(request_id="candidate", binding_id="content_safety.input",
        configuration=protocol.DataPlaneModelConfiguration(
            runtimes=[protocol.ModelRuntime(id="builtin", model="english", profile_ref="tali.laya.v1",
                backend="builtin_laya", checkpoint_revision=REVISION, timeout_seconds=5)],
            bindings=[protocol.CapabilityBinding(binding_id="content_safety.input", capability_ref="content_safety",
                rail_type=protocol.RAIL_TYPE_INPUT, model_ref="builtin", profile_ref="tali.laya.v1",
                contract_refs=["tali.guard.content-safety.v1"])]))
    try:
        result = await validate_capability(request, {}, builtin_laya=runtime, transport=httpx.MockTransport(reject_http))
        assert result.passed, result.message
        assert [case.actual_decision for case in result.cases] == ["allow", "block"]
        for case, call in zip(result.cases, calls, strict=True):
            captured = json.loads(case.output_content)
            assert captured["local_model_calls"] == [call]
            assert captured["model_exchanges"] == []
            assert call["input"]["lang"] == "en"
            assert call["input"]["max_len"] == 1024
            assert call["input"]["head_max_len"] == 512
        evidence = json.loads(result.cases[0].output_content)["evaluation_evidence"]
        local = next(json.loads(item["evidence"]) for item in evidence if item["evaluator_id"] == "laya-content-safety")
        assert local["model_metadata"]["backend"] == "builtin_laya"
        assert local["model_metadata"]["checkpoint_revision"] == REVISION

        request.configuration.runtimes[0].checkpoint_revision = "0" * 40
        stale = await validate_capability(request, {}, builtin_laya=runtime, transport=httpx.MockTransport(reject_http))
        assert not stale.passed and "checkpoint is unavailable" in stale.message
        assert len(calls) == 2
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_builtin_laya_local_evidence_handles_failed_and_non_json_sdk_returns(tmp_path, monkeypatch):
    def infer(state, questions, **options):
        if state == "failed":
            raise ValueError("internal error")
        return {"score": float("nan"), "metadata": object(), "token": "private"}

    runtime = BuiltinLaya(tmp_path)
    monkeypatch.setattr(runtime, "_load", lambda: (REVISION, SimpleNamespace(system_one=infer)))
    await runtime.start()
    session = ValidationDiagnostics({}, ())
    try:
        with capture_validation_case(enabled=True, secrets=(), session=session):
            with pytest.raises(BuiltinLayaInferenceError):
                await runtime.predict("failed", QUESTIONS, max_len=1024, head_max_len=512, deadline=time.monotonic() + 5)
            failed = session.local_evidence()["local_model_calls"][0]
            assert failed["input"]["state"] == "failed"
            assert failed["output"] is None
            assert failed["error"]["type"] == "ValueError"

        with capture_validation_case(enabled=True, secrets=(), session=session):
            await runtime.predict("succeeded", QUESTIONS, max_len=1024, head_max_len=512, deadline=time.monotonic() + 5)
            [captured] = session.local_evidence()["local_model_calls"]
            assert captured["input"]["state"] == "succeeded"
            assert captured["output"] == {"score": "NaN", "metadata": {"unavailable_type": "object"}, "token": "[REDACTED]"}
            assert "error" not in captured
    finally:
        await runtime.close()
