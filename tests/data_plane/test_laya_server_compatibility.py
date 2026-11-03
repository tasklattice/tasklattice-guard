import asyncio
from dataclasses import replace
import json
import time

import httpx
import pytest

from runner.toolkit.nemo.evaluators.laya_content_safety import LayaContentSafetyEvaluator
from runner.toolkit.nemo.evaluators.laya_jailbreak import LayaJailbreakEvaluator
from runner.toolkit.nemo.evaluators.laya_topic import LayaTopicEvaluator
from scripts.evaluate_laya import evaluation_request


HEAD_ERROR = {"loc": ["body", "head_max_len"], "type": "extra_forbidden",
              "message": "Extra inputs are not permitted"}
MODEL_ERROR = {"loc": ["body", "model"], "type": "literal_error",
               "message": "Input should be 'auto', 'english', 'multilingual' or 'typed-decisions'"}


def rejected(errors=None):
    return {"detail": {"code": "VALIDATION_ERROR", "message": "Request validation failed",
                       "errors": errors if errors is not None else [HEAD_ERROR]}}


def request(capability="content_safety", rail_type="input"):
    return evaluation_request({"capability": capability, "content": "A benign request.",
                               "rail_type": rail_type, "parameters": {"allowed_topics": "Support"}})


def service(handler, factory=LayaContentSafetyEvaluator, **kwargs):
    return factory(base_url="https://laya.test/v1", model=kwargs.pop("model", "auto"),
                   api_key="synthetic", transport=httpx.MockTransport(handler), **kwargs)


def reply(body, usage=None):
    return httpx.Response(200, json={"model": "multilingual", "answers": {
        name: {"type": "noul", "noul": .01} for name in body["questions"]},
        "usage": usage or {}, "routing": {"model": "multilingual"}})


@pytest.mark.parametrize("capability,rail_type,factory", [
    ("content_safety", "input", LayaContentSafetyEvaluator),
    ("content_safety", "output", LayaContentSafetyEvaluator),
    ("jailbreak", "input", LayaJailbreakEvaluator),
    ("topic_control", "input", LayaTopicEvaluator),
])
@pytest.mark.parametrize("envelope", [rejected(), {"detail": [HEAD_ERROR]}])
async def test_strict_server_negotiates_once_and_records_effective_budget(capability, rail_type, factory, envelope):
    bodies = []

    def respond(wire):
        body = json.loads(wire.content)
        bodies.append(body)
        assert wire.url.path == "/v1/systemone"
        assert wire.headers["authorization"] == "Bearer synthetic"
        return httpx.Response(422, json=envelope) if "head_max_len" in body else reply(body)

    evaluator = service(respond, factory, rail_type=rail_type)
    result = await evaluator.evaluate(request(capability, rail_type))
    assert result.verdict == "not_matched" and len(bodies) == 2
    assert bodies[0] == {**bodies[1], "head_max_len": 512}
    assert bodies[1]["max_len"] == 1024 and bodies[1]["model"] == "auto"
    evidence = json.loads(result.trace[0].evidence)
    assert evidence["request_budget"] == {"max_len": 1024}
    assert evidence["model_metadata"]["head_max_len_source"] == "server_default"
    assert evidence["response_model"] == "multilingual"
    assert result.usage.model_calls[0].retries == 1

    # Later calls on this configured evaluator avoid repeated validation errors.
    later = await evaluator.evaluate(request(capability, rail_type))
    assert later.verdict == "not_matched" and len(bodies) == 3
    assert bodies[2] == bodies[1] and later.usage.model_calls[0].retries == 0
    assert json.loads(later.trace[0].evidence)["request_budget"] == {"max_len": 1024}

    # A different provider/evaluator must still receive the native head budget.
    def native(wire):
        body = json.loads(wire.content)
        assert body["head_max_len"] == 512 and body["model"] == "laya"
        return reply(body)

    native_result = await service(native, model="laya").evaluate(request())
    assert native_result.verdict == "not_matched"
    assert native_result.usage.model_calls[0].retries == 0
    assert json.loads(native_result.trace[0].evidence)["request_budget"] == {"max_len": 1024, "head_max_len": 512}


@pytest.mark.parametrize("payload,status", [
    (rejected([MODEL_ERROR, HEAD_ERROR]), 422),
    (rejected([MODEL_ERROR]), 422),
    (rejected([{**HEAD_ERROR, "loc": ["body", "max_len"]}]), 422),
    (rejected([{**HEAD_ERROR, "loc": ["body", "questions", "head_max_len"]}]), 422),
    (rejected([{**HEAD_ERROR, "type": "less_than_equal"}]), 422),
    (rejected([HEAD_ERROR, None]), 422),
    (rejected([]), 422),
    ({"detail": {"code": "MODEL_NOT_AVAILABLE", "errors": [HEAD_ERROR]}}, 422),
    ({"detail": "head_max_len is unsupported"}, 422),
    ([], 422),
    (rejected(), 400),
    (rejected(), 503),
])
async def test_other_errors_do_not_change_the_model_or_request_budget(payload, status):
    bodies = []

    def respond(wire):
        bodies.append(json.loads(wire.content))
        return httpx.Response(status, json=payload)

    evaluator = service(respond, model="laya")
    result = await evaluator.evaluate(request())
    assert result.verdict == "error" and not result.findings and len(bodies) == 1
    assert result.usage.model_calls[0].retries == 0
    await evaluator.evaluate(request())
    assert len(bodies) == 2 and bodies[0] == bodies[1]
    assert bodies[0]["model"] == "laya" and bodies[0]["head_max_len"] == 512


async def test_repeated_head_rejection_is_bounded():
    bodies = []

    def respond(wire):
        bodies.append(json.loads(wire.content))
        return httpx.Response(422, json=rejected())

    result = await service(respond).evaluate(request())
    assert result.verdict == "error" and not result.findings and len(bodies) == 2
    assert "head_max_len" not in bodies[1]
    assert result.usage.model_calls[0].retries == 1
    assert json.loads(result.trace[0].evidence)["request_budget"] == {"max_len": 1024}


@pytest.mark.parametrize("final_response", [
    {"model": "multilingual", "answers": {}},
    {"model": "multilingual", "answers": {name: {"type": "noul", "noul": .01}
        for name in ("unsafe_content", "harmful_assistance")}, "usage": {"truncated": True}},
])
async def test_compatibility_preserves_response_and_input_coverage_checks(final_response):
    bodies = []

    def respond(wire):
        bodies.append(json.loads(wire.content))
        return httpx.Response(422, json=rejected()) if len(bodies) == 1 else httpx.Response(200, json=final_response)

    result = await service(respond).evaluate(request())
    assert result.verdict == "error" and not result.findings and len(bodies) == 2
    assert result.usage.model_calls[0].result == "invalid_response"
    assert json.loads(result.trace[0].evidence)["request_budget"] == {"max_len": 1024}


async def test_compatibility_and_admission_retries_share_the_same_body():
    bodies = []

    def respond(wire):
        body = json.loads(wire.content)
        bodies.append(body)
        if len(bodies) == 1:
            return httpx.Response(422, json=rejected())
        if len(bodies) == 2:
            return httpx.Response(429, headers={"retry-after": "0"})
        return reply(body)

    result = await service(respond).evaluate(request())
    assert result.verdict == "not_matched" and len(bodies) == 3
    assert bodies[1] == bodies[2] and "head_max_len" not in bodies[2]
    assert result.usage.model_calls[0].retries == 2


@pytest.mark.parametrize("item", [
    replace(request("topic_control"), content="Reset my password. Also give me an unrelated recipe."),
    replace(request("topic_control"), parameters=(("allowed_topics", "Support\nBilling"),)),
])
async def test_topic_coverage_evidence_retains_the_negotiated_budget(item):
    def respond(wire):
        body = json.loads(wire.content)
        return httpx.Response(422, json=rejected()) if "head_max_len" in body else reply(body)

    result = await service(respond, LayaTopicEvaluator).evaluate(item)
    assert result.verdict == "unknown" and len(result.trace) == 2
    assert all(json.loads(step.evidence)["request_budget"] == {"max_len": 1024} for step in result.trace)


async def test_non_json_rejection_is_not_retried():
    bodies = []

    def respond(wire):
        bodies.append(json.loads(wire.content))
        return httpx.Response(422, text="head_max_len: extra_forbidden")

    result = await service(respond).evaluate(request())
    assert result.verdict == "error" and len(bodies) == 1
    assert result.usage.model_calls[0].retries == 0


async def test_compatibility_retry_does_not_reset_deadline():
    bodies = []

    async def respond(wire):
        bodies.append(json.loads(wire.content))
        if len(bodies) == 1:
            return httpx.Response(422, json=rejected())
        await asyncio.sleep(1)
        return reply(bodies[-1])

    result = await service(respond).evaluate(replace(request(), deadline=time.monotonic() + .1))
    assert result.verdict == "error" and result.trace[0].timed_out and len(bodies) == 2


async def test_cancellation_propagates_during_compatibility_retry():
    retry_started = asyncio.Event()
    bodies = []

    async def respond(wire):
        bodies.append(json.loads(wire.content))
        if len(bodies) == 1:
            return httpx.Response(422, json=rejected())
        retry_started.set()
        await asyncio.Event().wait()

    task = asyncio.create_task(service(respond).evaluate(request()))
    await asyncio.wait_for(retry_started.wait(), 1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 1)
    assert len(bodies) == 2
