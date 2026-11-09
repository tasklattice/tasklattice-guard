"""The Controller declares one Laya deployment; the Runner never negotiates.

Native laya-serve accepts the System One ``head_max_len`` field; the strict
1Panel-dev FastAPI schema rejects it as ``extra_forbidden``. The mode is fixed
once at model registration and arrives through the data-plane plan, so every
request body is deterministic and the Runner never probes the schema.
"""
import asyncio
from dataclasses import replace
import json
import time

import httpx
import pytest

from runner.providers import dynamic_runtime_action_providers
from runner.toolkit.nemo.actions.evaluate import EvaluationActionProvider
from runner.toolkit.nemo.evaluators.laya import (
    DEFAULT_REQUEST_MODE, LAYA_REQUEST_MODES, normalize_request_mode,
)
from runner.toolkit.nemo.evaluators.laya_content_safety import LayaContentSafetyEvaluator
from runner.toolkit.nemo.evaluators.laya_jailbreak import LayaJailbreakEvaluator
from runner.toolkit.nemo.evaluators.laya_topic import LayaTopicEvaluator
from runner.toolkit.safety.providers import ModelRuntimeConfig
from scripts.evaluate_laya import evaluation_request
from tests.control_plane.test_capability_validation import candidate


NATIVE_BUDGET = {"max_len": 1024, "head_max_len": 512}
COMPATIBLE_BUDGET = {"max_len": 1024}
NATIVE_BODY = {"model", "state", "questions", "max_len", "head_max_len"}
COMPATIBLE_BODY = {"model", "state", "questions", "max_len"}

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


def test_request_mode_is_normalized_once():
    assert DEFAULT_REQUEST_MODE == "compatible"
    assert LAYA_REQUEST_MODES == {"native", "compatible"}
    assert normalize_request_mode("") == "compatible"
    assert normalize_request_mode("compatible") == "compatible"
    assert normalize_request_mode("native") == "native"


@pytest.mark.parametrize("value", ["legacy", "NATIVE", "native ", "compat", None, 1])
def test_unknown_request_mode_is_rejected_before_any_call(value):
    with pytest.raises(ValueError, match="request mode"):
        normalize_request_mode(value)
    with pytest.raises(ValueError, match="request mode"):
        LayaContentSafetyEvaluator(base_url="https://laya.test/v1", model="auto",
                                   api_key="synthetic", request_mode=value)


@pytest.mark.parametrize("value", ["", "native", "compatible"])
def test_runtime_config_keeps_the_declared_mode(value):
    base = dict(id="laya", base_url="https://laya.test/v1", model="auto")
    assert ModelRuntimeConfig(**base).laya_request_mode == "compatible"
    assert ModelRuntimeConfig(**base, laya_request_mode=value).laya_request_mode == value
    for invalid in ("legacy", "NATIVE", None):
        with pytest.raises(ValueError, match="request mode"):
            ModelRuntimeConfig(**base, laya_request_mode=invalid)


@pytest.mark.parametrize("capability,rail_type,factory", [
    ("content_safety", "input", LayaContentSafetyEvaluator),
    ("content_safety", "output", LayaContentSafetyEvaluator),
    ("jailbreak", "input", LayaJailbreakEvaluator),
    ("topic_control", "input", LayaTopicEvaluator),
])
@pytest.mark.parametrize("request_mode,expected_body,expected_budget", [
    ("native", NATIVE_BODY, NATIVE_BUDGET),
    ("compatible", COMPATIBLE_BODY, COMPATIBLE_BUDGET),
])
async def test_declared_mode_fixes_one_deterministic_body(
        capability, rail_type, factory, request_mode, expected_body, expected_budget):
    bodies = []

    def respond(wire):
        body = json.loads(wire.content)
        bodies.append(body)
        assert wire.url.path == "/v1/systemone"
        assert wire.headers["authorization"] == "Bearer synthetic"
        assert set(body) == expected_body
        assert body["model"] == "auto" and body["max_len"] == 1024
        if request_mode == "native":
            assert body["head_max_len"] == 512
        else:
            assert "head_max_len" not in wire.content.decode()
        return reply(body)

    evaluator = service(respond, factory, rail_type=rail_type, request_mode=request_mode)
    result = await evaluator.evaluate(request(capability, rail_type))
    assert result.verdict == "not_matched" and len(bodies) == 1
    evidence = json.loads(result.trace[0].evidence)
    assert evidence["request_budget"] == expected_budget
    assert evidence["model_metadata"]["laya_request_mode"] == request_mode
    if request_mode == "compatible":
        assert evidence["model_metadata"]["head_max_len_source"] == "server_default"
    else:
        assert "head_max_len_source" not in evidence["model_metadata"]
    assert evidence["response_model"] == "multilingual"
    assert result.usage.model_calls[0].retries == 0

    # The configured evaluator repeats exactly the same body; no cached probe.
    later = await evaluator.evaluate(request(capability, rail_type))
    assert later.verdict == "not_matched" and len(bodies) == 2
    assert bodies[0] == bodies[1]
    assert json.loads(later.trace[0].evidence)["request_budget"] == expected_budget


async def test_absent_mode_defaults_to_compatible():
    bodies = []

    def respond(wire):
        body = json.loads(wire.content)
        bodies.append(body)
        assert set(body) == COMPATIBLE_BODY and "head_max_len" not in wire.content.decode()
        return reply(body)

    result = await service(respond).evaluate(request())
    assert result.verdict == "not_matched" and len(bodies) == 1
    evidence = json.loads(result.trace[0].evidence)
    assert evidence["request_budget"] == COMPATIBLE_BUDGET
    assert evidence["model_metadata"] == {
        "laya_request_mode": "compatible", "head_max_len_source": "server_default",
        "usage": {}, "routing": {"model": "multilingual"}}


@pytest.mark.parametrize("capability,rail_type,factory", [
    ("content_safety", "input", LayaContentSafetyEvaluator),
    ("jailbreak", "input", LayaJailbreakEvaluator),
    ("topic_control", "input", LayaTopicEvaluator),
])
@pytest.mark.parametrize("response", [
    lambda: httpx.Response(422, json=rejected()),
    lambda: httpx.Response(422, json={"detail": [HEAD_ERROR]}),
    lambda: httpx.Response(422, text="head_max_len: extra_forbidden"),
    lambda: httpx.Response(422, json={"detail": {"code": "MODEL_NOT_AVAILABLE", "errors": [HEAD_ERROR]}}),
])
async def test_strict_server_rejection_is_not_retried_or_negotiated(
        capability, rail_type, factory, response):
    bodies = []

    def respond(wire):
        bodies.append(json.loads(wire.content))
        return response()

    evaluator = service(respond, factory, rail_type=rail_type, request_mode="native")
    result = await evaluator.evaluate(request(capability, rail_type))
    assert result.verdict == "error" and not result.findings
    # Exactly one HTTP request: a 422 schema rejection is never replayed without
    # head_max_len and no fallback body is ever cached or sent.
    assert len(bodies) == 1 and set(bodies[0]) == NATIVE_BODY and bodies[0]["head_max_len"] == 512
    call = result.usage.model_calls[0]
    assert call.retries == 0 and call.http_status == 422 and call.result == "client_error"
    evidence = json.loads(result.trace[0].evidence)
    assert evidence["request_budget"] == NATIVE_BUDGET
    assert evidence["model_metadata"]["laya_request_mode"] == "native"
    assert evidence["requested_model"] == "auto"

    # Re-evaluating does not learn a fallback: the same native body is sent again.
    again = await evaluator.evaluate(request(capability, rail_type))
    assert again.verdict == "error" and len(bodies) == 2 and bodies[1] == bodies[0]


def test_no_schema_negotiation_state_exists():
    import runner.toolkit.nemo.evaluators.laya as laya
    evaluator = service(lambda wire: pytest.fail("No call expected"))
    assert not hasattr(laya, "head_max_len_rejected")
    assert not hasattr(evaluator, "_head_max_len_supported")
    assert not hasattr(evaluator, "_head_max_len_rejected")


@pytest.mark.parametrize("payload,status", [
    (rejected([MODEL_ERROR]), 422),
    (rejected([MODEL_ERROR, HEAD_ERROR]), 422),
    (rejected([{**HEAD_ERROR, "loc": ["body", "max_len"]}]), 422),
    (rejected([HEAD_ERROR, None]), 422),
    (rejected([]), 422),
    ({"detail": "head_max_len is unsupported"}, 422),
    (rejected(), 400),
    (rejected(), 503),
    ([], 422),
])
async def test_other_errors_never_change_the_declared_body(payload, status):
    bodies = []

    def respond(wire):
        bodies.append(json.loads(wire.content))
        return httpx.Response(status, json=payload)

    evaluator = service(respond, model="laya", request_mode="native")
    result = await evaluator.evaluate(request())
    assert result.verdict == "error" and not result.findings and len(bodies) == 1
    assert result.usage.model_calls[0].retries == 0
    await evaluator.evaluate(request())
    assert len(bodies) == 2 and bodies[0] == bodies[1]
    assert bodies[0]["model"] == "laya" and bodies[0]["head_max_len"] == 512


@pytest.mark.parametrize("request_mode,expected_budget", [
    ("native", NATIVE_BUDGET), ("compatible", COMPATIBLE_BUDGET),
])
async def test_rate_limit_and_admission_retries_reuse_the_declared_body(request_mode, expected_budget):
    bodies = []

    def respond(wire):
        body = json.loads(wire.content)
        bodies.append(body)
        if len(bodies) == 1:
            return httpx.Response(429, headers={"retry-after": "0"})
        if len(bodies) == 2:
            return httpx.Response(503, headers={"retry-after": "0"},
                                  json={"detail": "server busy, try again later"})
        return reply(body)

    result = await service(respond, request_mode=request_mode).evaluate(request())
    assert result.verdict == "not_matched" and len(bodies) == 3
    assert bodies[1] == bodies[2] == bodies[0]
    if request_mode == "native":
        assert bodies[0]["head_max_len"] == 512
    else:
        assert "head_max_len" not in bodies[0]
    call = result.usage.model_calls[0]
    assert call.result == "success" and call.retries == 2
    assert json.loads(result.trace[0].evidence)["request_budget"] == expected_budget


async def test_retry_does_not_reset_the_shared_deadline():
    bodies = []

    async def respond(wire):
        bodies.append(json.loads(wire.content))
        if len(bodies) == 1:
            return httpx.Response(429, headers={"retry-after": "0"})
        await asyncio.sleep(1)
        return reply(bodies[-1])

    result = await service(respond, request_mode="native").evaluate(
        replace(request(), deadline=time.monotonic() + .1))
    assert result.verdict == "error" and result.trace[0].timed_out and len(bodies) == 2
    assert bodies[0] == bodies[1] and bodies[0]["head_max_len"] == 512
    assert json.loads(result.trace[0].evidence)["request_budget"] == NATIVE_BUDGET


async def test_cancellation_propagates_during_retry():
    retry_started = asyncio.Event()
    bodies = []

    async def respond(wire):
        bodies.append(json.loads(wire.content))
        if len(bodies) == 1:
            return httpx.Response(429, headers={"retry-after": "0"})
        retry_started.set()
        await asyncio.Event().wait()

    task = asyncio.create_task(service(respond, request_mode="native").evaluate(request()))
    await asyncio.wait_for(retry_started.wait(), 1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 1)
    assert len(bodies) == 2 and bodies[1] == bodies[0] and set(bodies[1]) == NATIVE_BODY


@pytest.mark.parametrize("request_mode,expected_budget", [
    ("native", NATIVE_BUDGET), ("compatible", COMPATIBLE_BUDGET),
])
@pytest.mark.parametrize("overrides", [
    {"content": "Reset my password. Also give me an unrelated recipe."},
    {"parameters": (("allowed_topics", "Support\nBilling"),)},
])
async def test_topic_coverage_evidence_retains_the_mode_budget(overrides, request_mode, expected_budget):
    item = replace(request("topic_control"), **overrides)

    def respond(wire):
        return reply(json.loads(wire.content))

    result = await service(respond, LayaTopicEvaluator, request_mode=request_mode).evaluate(item)
    assert result.verdict == "unknown" and len(result.trace) == 2
    for step in result.trace:
        evidence = json.loads(step.evidence)
        assert evidence["request_budget"] == expected_budget
        assert evidence["model_metadata"]["laya_request_mode"] == request_mode


@pytest.mark.parametrize("request_mode,expected_budget", [
    ("native", NATIVE_BUDGET), ("compatible", COMPATIBLE_BUDGET),
])
async def test_pre_body_trace_budget_is_mode_derived(request_mode, expected_budget):
    evaluator = service(lambda wire: pytest.fail("Must not call a provider"),
                        LayaJailbreakEvaluator, request_mode=request_mode)
    result = await evaluator.evaluate(replace(request("jailbreak"), rail_type="output"))
    assert result.verdict == "error" and result.usage.model_invocations == 0
    evidence = json.loads(result.trace[0].evidence)
    assert evidence["request_budget"] == expected_budget
    assert evidence["model_metadata"]["laya_request_mode"] == request_mode
    if request_mode == "compatible":
        assert evidence["model_metadata"]["head_max_len_source"] == "server_default"


def _plan(mode=None):
    config = candidate("input", "content_safety", "tali.laya.v1",
                       "tali.guard.content-safety.v1").configuration
    if mode is not None:
        config.runtimes[0].laya_request_mode = mode
    return config


async def _execute_through_plan(config, handler):
    providers = dynamic_runtime_action_providers(
        config, {"provider-1": "synthetic"}, transport=httpx.MockTransport(handler))
    action = next(item for item in providers if isinstance(item, EvaluationActionProvider))
    return await action.execute(request())


@pytest.mark.parametrize("mode", ["native", "compatible"])
async def test_plan_mode_reaches_the_wire_body(mode):
    bodies = []

    def respond(wire):
        body = json.loads(wire.content)
        bodies.append(body)
        return httpx.Response(200, json={"model": body["model"], "answers": {
            key: {"type": "noul", "noul": .01} for key in body["questions"]}})

    result = await _execute_through_plan(_plan(mode), respond)
    assert result.verdict == "not_matched" and len(bodies) == 1
    expected_body, expected_budget = ((NATIVE_BODY, NATIVE_BUDGET) if mode == "native"
                                      else (COMPATIBLE_BODY, COMPATIBLE_BUDGET))
    assert set(bodies[0]) == expected_body
    if mode == "native":
        assert bodies[0]["head_max_len"] == 512
    else:
        assert "head_max_len" not in bodies[0]
    evidence = json.loads(result.trace[0].evidence)
    assert evidence["request_budget"] == expected_budget
    assert evidence["model_metadata"]["laya_request_mode"] == mode


async def test_absent_plan_mode_reaches_the_wire_as_compatible():
    bodies = []

    def respond(wire):
        body = json.loads(wire.content)
        bodies.append(body)
        return httpx.Response(200, json={"model": body["model"], "answers": {
            key: {"type": "noul", "noul": .01} for key in body["questions"]}})

    config = _plan()
    assert config.runtimes[0].laya_request_mode == ""
    result = await _execute_through_plan(config, respond)
    assert result.verdict == "not_matched" and len(bodies) == 1
    assert set(bodies[0]) == COMPATIBLE_BODY and "head_max_len" not in bodies[0]
    evidence = json.loads(result.trace[0].evidence)
    assert evidence["model_metadata"]["laya_request_mode"] == "compatible"
    assert evidence["model_metadata"]["head_max_len_source"] == "server_default"


def test_plan_rejects_an_unknown_mode():
    config = _plan("legacy")
    with pytest.raises(ValueError, match="request mode"):
        dynamic_runtime_action_providers(config, {"provider-1": "synthetic"})
