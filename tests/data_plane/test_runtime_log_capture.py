from __future__ import annotations

import base64
import asyncio
import json
import os
import time
from dataclasses import replace
from uuid import uuid4

import pytest
import httpx
from fastapi import FastAPI
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from runner.api import RunnerAPI
from runner.runtime_log_capture import RuntimeLogCapture
from tests.test_runner_api import Runtime, Store, Metrics, Telemetry

KEY = bytes(range(32))


def decode(event):
    prefix, nonce, tag, ciphertext = event["metadata"]["contentCiphertext"].split(":")
    return json.loads(AESGCM(KEY).decrypt(base64.b64decode(nonce),
        base64.b64decode(ciphertext) + base64.b64decode(tag), prefix.encode()))


async def decision(severity=None, action="allow", verdict="matched", mode="enforce"):
    result = await Runtime().evaluate(None)
    return replace(result, decision=action, action=action, texts=("REWRITTEN",), protection_mode=mode,
                   findings=(replace(result.findings[0], risk_severity=severity, verdict=verdict),) if severity else ())


async def emit(api, event_id, result, *, phase="input", call_id="call", endpoint="endpoint", text="ORIGINAL"):
    await api._emit_telemetry(request_id=event_id, call_id=call_id, endpoint_id=endpoint,
        phase=phase, protocol="litellm", mode="enforce", started=time.perf_counter(),
        decision=result, content_before=(text,))


def api(level, telemetry=None, capture=None, key=KEY, runner_id="runner"):
    return RunnerAPI(Runtime(), Store(level), Metrics(), telemetry or Telemetry(), runner_id, "internal",
                     key, runtime_log_capture=capture)


@pytest.mark.parametrize("level", ["info", "debug", "trace"])
@pytest.mark.parametrize("severity", [None, "informational", "low", "medium", "high", "critical"])
@pytest.mark.parametrize("action", ["allow", "transform", "block"])
async def test_enforce_capture_matrix_preserves_audit_and_only_original_content(level, severity, action):
    instance = api(level)
    result = await decision(severity, action)
    await emit(instance, "one", result, call_id=None)
    event = instance._telemetry.events[0]
    expected = level == "trace" or level == "debug" and severity in {"medium", "high", "critical"}
    assert event["metadata"]["runtimeLogCaptured"] == expected
    assert ("contentCiphertext" in event["metadata"]) == expected
    assert event["metadata"]["trace"] and len(event["metadata"]["findings"]) == len(result.findings)
    assert "ORIGINAL" not in json.dumps(event)
    if expected:
        content = decode(event)
        assert content["contentBefore"][0]["text"] == "ORIGINAL"
        assert "contentAfter" not in content and "REWRITTEN" not in json.dumps(content)


@pytest.mark.parametrize("first_matches", [False, True])
async def test_debug_selects_both_directions_across_runners(first_matches):
    shared = RuntimeLogCapture()
    first, second = api("debug", capture=shared, runner_id="one"), api("debug", capture=shared, runner_id="two")
    await emit(first, "input", await decision("high" if first_matches else None), text="original request")
    await emit(second, "output", await decision(None if first_matches else "medium"), phase="output", text="original response")
    events = {e["id"]: e for e in first._telemetry.events + second._telemetry.events}
    assert set(events) == {"input", "output"}
    assert all(e["metadata"]["runtimeLogCaptured"] for e in events.values())
    assert decode(events["input"])["contentBefore"][0]["text"] == "original request"
    assert decode(events["output"])["contentBefore"][0]["text"] == "original response"
    assert events["input"]["runnerId"] == "one"
    if not first_matches:
        assert "contentCiphertext" not in first._telemetry.events[0]["metadata"]


async def test_level_pinned_and_correlation_scoped_to_endpoint():
    instance = api("debug")
    await emit(instance, "in", await decision())
    instance._store.level = "info"
    await emit(instance, "out", await decision("high"), phase="output")
    assert instance._telemetry.events[-1]["id"] == "in"
    assert instance._telemetry.events[-1]["metadata"]["captureLevel"] == "debug"
    instance._store.level = "debug"
    await emit(instance, "other", await decision(), phase="output", endpoint="other")
    assert "contentCiphertext" not in instance._telemetry.events[-1]["metadata"]


async def test_info_never_captures_errors_and_debug_requires_matched_risk():
    for result in (None, await decision("critical", "block", "error"), await decision("high", "block", "not_matched")):
        for level in ("info", "debug"):
            instance = api(level)
            await emit(instance, str(uuid4()), result, call_id=None)
            assert not instance._telemetry.events[-1]["metadata"]["runtimeLogCaptured"]
    instance = api("trace")
    await emit(instance, "error", None, call_id=None)
    assert decode(instance._telemetry.events[0])["contentBefore"][0]["text"] == "ORIGINAL"


async def test_selection_independent_of_encryption_and_monitor_action():
    instance = api("debug", key=None)
    await emit(instance, "input", await decision("high", mode="monitor"))
    await emit(instance, "output", await decision(), phase="output")
    assert all(e["metadata"]["runtimeLogCaptured"] for e in instance._telemetry.events)
    assert all("contentCiphertext" not in e["metadata"] for e in instance._telemetry.events)
    assert all(e["metadata"]["contentCaptureStatus"] == "storage_unavailable" for e in instance._telemetry.events)


async def test_unselected_candidates_expire_without_entering_audit_storage(monkeypatch):
    cache = RuntimeLogCapture(ttl_seconds=300)
    instance = api("debug", capture=cache)
    await emit(instance, "input", await decision("low"))
    assert "ORIGINAL" not in json.dumps(cache._items)
    assert "contentCiphertext" not in instance._telemetry.events[0]["metadata"]
    now = time.time()
    monkeypatch.setattr("runner.runtime_log_capture.time.time", lambda: now + 301)
    cache.prune()
    assert not cache._items and cache._memory_bytes == 0
    await emit(instance, "output", await decision("high"), phase="output")
    assert [e["id"] for e in instance._telemetry.events] == ["input", "output"]


async def test_buffer_limit_does_not_drop_audit_or_the_current_selected_body():
    instance = api("debug", capture=RuntimeLogCapture(max_call_bytes=10))
    await emit(instance, "input", await decision("high"))
    event = instance._telemetry.events[0]
    assert event["metadata"]["callCaptureIncomplete"]
    assert decode(event)["contentBefore"][0]["text"] == "ORIGINAL"


async def test_pending_bodies_survive_wal_failure_for_idempotent_retry():
    class FailOnce(Telemetry):
        async def emit(self, event):
            if event["id"] == "input" and event["metadata"]["runtimeLogCaptured"] and not getattr(self, "failed", False):
                self.failed = True
                raise OSError("WAL unavailable")
            await super().emit(event)
    instance = api("debug", telemetry=FailOnce())
    await emit(instance, "input", await decision())
    with pytest.raises(OSError):
        await emit(instance, "output", await decision("high"), phase="output")
    await emit(instance, "output-retry", await decision("high"), phase="output")
    assert any(e["id"] == "input" and e["metadata"]["runtimeLogCaptured"] for e in instance._telemetry.events)


@pytest.mark.parametrize("concurrent", [False, True])
async def test_real_redis_correlates_independent_caches(concurrent):
    url = os.environ.get("GUARD_TEST_REDIS_URL")
    if not url:
        pytest.skip("Set GUARD_TEST_REDIS_URL to isolated loopback Redis")
    from urllib.parse import urlparse
    assert urlparse(url).hostname in {"localhost", "127.0.0.1", "::1"}
    stores = [RuntimeLogCapture(url), RuntimeLogCapture(url)]
    first, second = [api("debug", capture=store, runner_id=str(i)) for i, store in enumerate(stores)]
    call = str(uuid4())
    try:
        incoming, outgoing = await decision(), await decision("high")
        if concurrent:
            await asyncio.gather(emit(first, "input", incoming, call_id=call),
                emit(second, "output", outgoing, phase="output", call_id=call))
        else:
            await emit(first, "input", incoming, call_id=call)
            await emit(second, "output", outgoing, phase="output", call_id=call)
        selected = {event["id"]: event for event in first._telemetry.events + second._telemetry.events
                    if event["metadata"]["runtimeLogCaptured"]}
        assert set(selected) == {"input", "output"}
        assert all(decode(event)["contentBefore"][0]["text"] == "ORIGINAL" for event in selected.values())
        key = stores[0].key("endpoint", "guardrail-1", "litellm", call)
        assert 0 < await stores[0]._redis.ttl(key) <= 300
        assert not json.loads(await stores[0]._redis.get(key))["pending"]
    finally:
        for store in stores:
            await store.close()


async def test_output_match_recovers_the_exact_http_input_received_by_another_runner():
    class PhasedRuntime(Runtime):
        async def evaluate(self, request, **kwargs):
            return await decision("high" if request.phase == "output" else None,
                                  "block" if request.phase == "output" else "allow")
    capture, events = RuntimeLogCapture(), []
    for phase in ("request", "response"):
        telemetry, app = Telemetry(), FastAPI()
        app.include_router(RunnerAPI(PhasedRuntime(), Store("debug"), Metrics(), telemetry, phase, "internal",
                                    KEY, runtime_log_capture=capture).router)
        raw = json.dumps({"input_type": phase, "texts": [f"原始 {phase}"], "litellm_call_id": "http-call"},
                         ensure_ascii=False, indent=3).encode() + b"\n"
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
            response = await client.post("/runtime/v1/endpoints/endpoint-1/beta/litellm_basic_guardrail_api",
                content=raw, headers={"x-api-key": "valid-secret", "content-type": "application/json"})
        assert response.status_code == 200
        if phase == "request":
            input_bytes = raw
            assert "contentCiphertext" not in telemetry.events[0]["metadata"]
        events.extend(telemetry.events)
    selected = [event for event in events if event["metadata"]["runtimeLogCaptured"]]
    assert len(selected) == 2 and len({event["requestId"] for event in selected}) == 1
    input_event = next(event for event in selected if event["direction"] == "incoming")
    assert base64.b64decode(decode(input_event)["httpRequest"]["bodyBase64"]) == input_bytes
    assert input_event["runnerId"] == "request"
