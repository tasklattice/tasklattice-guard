from __future__ import annotations

import asyncio
import hashlib
import json
import threading
import time
from types import SimpleNamespace

import httpx
import pytest

from runner import builtin_laya, generated as protocol, resources
from runner.builtin_laya import BuiltinLaya, BuiltinLayaBusyError, _verify_checkpoint
from runner.capability_validation import validate_capability


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
        calls.append((state, kwargs))
        probability = 0.01 if state == "Have a pleasant day." else 0.99
        return {"model": "laya", "answers": {
            key: {"type": "noul", "noul": probability} for key in questions
        }, "usage": {"input_tokens": 12, "output_tokens": 0}}

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
        assert [options for _, options in calls] == [{"lang": "en", "max_len": 1024, "head_max_len": 512}] * 2
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
