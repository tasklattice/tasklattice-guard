import asyncio
from dataclasses import replace
import json
import time

import httpx
import pytest

from runner.toolkit.nemo.actions import model_retry
from runner.toolkit.nemo.evaluators.laya_content_safety import LayaContentSafetyEvaluator
from scripts.evaluate_laya import evaluation_request


def request():
    return evaluation_request({"capability": "content_safety", "content": "A benign request."})


def service(handler):
    return LayaContentSafetyEvaluator(base_url="https://laya.test/v1", model="auto", api_key="synthetic",
                                     transport=httpx.MockTransport(handler))


def busy(delay="0.001"):
    return httpx.Response(503, json={"detail": "server busy, try again later"}, headers={"retry-after": delay})


async def test_admission_rejection_recovers_without_inventing_a_classification(monkeypatch):
    monkeypatch.setattr(model_retry, "_rate_limit_attempts", 3)
    bodies = []

    def respond(wire):
        bodies.append(wire.content)
        return busy() if len(bodies) == 1 else httpx.Response(200, json={
            "model": "actual-laya", "answers": {name: {"type": "noul", "noul": .03}
                for name in json.loads(wire.content)["questions"]}})

    result = await service(respond).evaluate(request())
    assert result.verdict == "not_matched" and len(bodies) == 2 and bodies[0] == bodies[1]
    call = result.usage.model_calls[0]
    assert call.result == "success" and call.retries == 1 and call.backoff_ms >= 1
    assert json.loads(result.trace[0].evidence)["response_model"] == "actual-laya"


@pytest.mark.parametrize("response", [
    httpx.Response(503, json={"detail": "upstream inference failed"}),
    httpx.Response(503, text="server busy, try again later"),
    httpx.Response(500, json={"detail": "server busy, try again later"}),
    httpx.Response(503, json=["server busy, try again later"]),
    httpx.Response(200, json={"model": "actual-laya", "answers": {}}),
])
async def test_other_failures_are_not_retried_or_changed_into_success(response):
    calls = 0

    def respond(wire):
        nonlocal calls
        calls += 1
        return response

    result = await service(respond).evaluate(request())
    assert calls == 1 and result.verdict == "error" and not result.findings
    assert result.usage.model_calls[0].retries == 0


async def test_busy_recovery_has_an_attempt_bound_and_keeps_real_failure(monkeypatch):
    monkeypatch.setattr(model_retry, "_rate_limit_attempts", 3)
    calls = 0

    def respond(wire):
        nonlocal calls
        calls += 1
        return busy()

    result = await service(respond).evaluate(request())
    assert calls == 3 and result.verdict == "error" and not result.findings
    call = result.usage.model_calls[0]
    assert call.retries == 2 and call.http_status == 503 and call.result == "server_error"


async def test_retry_after_must_fit_within_existing_deadline():
    calls = 0

    def respond(wire):
        nonlocal calls
        calls += 1
        return busy("1")

    result = await service(respond).evaluate(replace(request(), deadline=time.monotonic() + .2))
    assert calls == 1 and result.verdict == "error"
    assert result.usage.model_calls[0].retries == 0


async def test_scan_cancellation_interrupts_busy_backoff():
    rejected = asyncio.Event()
    calls = 0

    def respond(wire):
        nonlocal calls
        calls += 1
        rejected.set()
        return busy("1")

    task = asyncio.create_task(service(respond).evaluate(request()))
    await asyncio.wait_for(rejected.wait(), .5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, .5)
    assert calls == 1
