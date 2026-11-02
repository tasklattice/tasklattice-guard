import asyncio
import json
import time
from dataclasses import replace
from pathlib import Path

import httpx
import pytest

from runner.toolkit.nemo.actions.topic import TopicJudgeActionProvider
from runner.toolkit.nemo.evaluators.jev_topic import JevTopicEvaluator, topic_questions
from scripts.evaluate_topic_control import load_samples, replay
from tests.test_dynamic_model_configuration import _topic_request


def evaluator(handler, **kwargs):
    return JevTopicEvaluator(base_url="https://typesafe.test/v1/", model="jev-1.13.0", api_key="synthetic-key",
                             transport=httpx.MockTransport(handler), **kwargs)


def response(**probabilities):
    return httpx.Response(200, json={"model": "jev-1.13.0", "answers": {
        key: {"type": "noul", "noul": value} for key, value in probabilities.items()},
        "usage": {"input_tokens": 34, "output_tokens": 8}})


@pytest.mark.parametrize("denied,unlisted,expected", [
    (0, 0, "not_matched"), (0.1, 0.1, "not_matched"), (0.9, 0, "matched"),
    (0, 0.9, "matched"), (0.99, 0.5, "matched"), (0.5, 0, "unknown"),
    (0, 0.5, "unknown"), (0.10001, 0.89999, "unknown"),
])
async def test_typed_answers_preserve_probabilities_without_inventing_confidence(denied, unlisted, expected):
    request = replace(_topic_request(), context_messages=({"role": "user", "content": "earlier question"},))
    def respond(http_request):
        assert str(http_request.url) == "https://typesafe.test/v1/systemone"
        assert http_request.headers["authorization"] == "Bearer synthetic-key"
        body = json.loads(http_request.content)
        assert set(body) == {"model", "state", "questions"}
        assert body["state"] == {"current_input": request.content, "context_messages": list(request.context_messages)}
        assert set(body["questions"]) == {"denied_task", "unlisted_task"}
        return response(denied_task=denied, unlisted_task=unlisted)
    result = await TopicJudgeActionProvider(evaluator=evaluator(respond)).execute(request)
    assert result.verdict == expected and result.content == request.content
    assert result.confidence is None
    assert bool(result.findings) is (expected == "matched")
    assert all(f.confidence is None and f.risk_severity is None for f in result.findings)
    evidence = json.loads(result.trace[0].evidence)
    assert evidence["judgments"]["denied_task"]["probability"] == denied
    assert evidence["response_model"] == "jev-1.13.0"
    assert result.usage.model_invocations == 1
    assert result.usage.model_calls[0].input_tokens == 34


@pytest.mark.parametrize("bad", [True, "0.2", None, -0.1, 1.1, 10**400, float("nan"), float("inf")])
async def test_invalid_probabilities_are_errors_not_safe_or_unknown(bad):
    # Serialize explicitly to exercise even non-standard JSON NaN/Infinity.
    payload = {"model": "jev-1.13.0", "answers": {
        "denied_task": {"type": "noul", "noul": bad}, "unlisted_task": {"type": "noul", "noul": 0}}}
    result = await evaluator(lambda _: httpx.Response(200, content=json.dumps(payload))).evaluate(_topic_request())
    assert result.verdict == "error" and not result.findings
    assert result.usage.model_calls[0].result == "invalid_response"


@pytest.mark.parametrize("payload", [
    {}, [], {"model": "jev", "answers": {}},
    {"model": "jev", "answers": {"denied_task": {"type": "choice", "noul": 1}, "unlisted_task": {"type": "noul", "noul": 0}}},
])
async def test_missing_or_mismatched_answers_are_errors(payload):
    result = await evaluator(lambda _: httpx.Response(200, json=payload)).evaluate(_topic_request())
    assert result.verdict == "error"


@pytest.mark.parametrize("status", [401, 422, 500, 529])
async def test_http_failures_do_not_become_topic_matches_or_retry_without_budget(status):
    calls = []
    def respond(request):
        calls.append(request)
        return httpx.Response(status, text="synthetic-key must not appear in evidence")
    result = await evaluator(respond).evaluate(_topic_request())
    assert result.verdict == "error" and not result.findings and len(calls) == 1
    assert "synthetic-key" not in result.reason


async def test_explicit_rate_limiting_is_retried_up_to_the_configured_budget():
    from runner.toolkit.nemo.actions.model_retry import rate_limit_retry_attempts
    calls = []
    def respond(request):
        calls.append(request)
        return httpx.Response(429, headers={"retry-after": "0"}, text="synthetic-key must not appear in evidence")
    result = await evaluator(respond).evaluate(_topic_request())
    assert result.verdict == "error" and not result.findings
    assert len(calls) == rate_limit_retry_attempts()
    assert result.usage.model_calls[0].retries == rate_limit_retry_attempts() - 1
    assert "synthetic-key" not in result.reason


async def test_a_rate_limit_that_clears_produces_a_real_classification():
    calls = []
    def respond(request):
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(429, headers={"retry-after": "0"})
        return response(denied_task=0, unlisted_task=0)
    result = await evaluator(respond).evaluate(_topic_request())
    assert len(calls) == 2 and result.usage.model_calls[0].result == "success"
    assert result.verdict == "not_matched"


async def test_timeouts_missing_credentials_and_unsupported_rails():
    def timeout(request):
        raise httpx.ReadTimeout("timeout", request=request)
    result = await evaluator(timeout).evaluate(_topic_request())
    assert result.verdict == "error" and result.usage.model_calls[0].result == "timeout"
    def unexpected(_):
        pytest.fail("Must not call a provider for unsupported or expired requests")
    for request in [replace(_topic_request(), rail_type="output"), replace(_topic_request(), capability="content_safety"),
                    replace(_topic_request(), deadline=time.monotonic() - 1)]:
        assert (await evaluator(unexpected).evaluate(request)).verdict == "error"
    no_key = JevTopicEvaluator(base_url="https://typesafe.test/v1", model="jev", api_key="", transport=httpx.MockTransport(unexpected))
    assert (await no_key.evaluate(_topic_request())).verdict == "error"


async def test_total_call_deadline_is_bounded_and_caller_cancellation_propagates():
    async def slow(_):
        await asyncio.sleep(1)
        return response(denied_task=0, unlisted_task=0)
    result = await evaluator(slow, timeout_seconds=0.01).evaluate(_topic_request())
    assert result.verdict == "error" and result.usage.model_calls[0].result == "timeout"
    async def cancelled(_):
        raise asyncio.CancelledError
    with pytest.raises(asyncio.CancelledError):
        await evaluator(cancelled).evaluate(_topic_request())


async def test_split_rule_questions_are_isolated_and_empty_permissive_rules_skip_calls():
    allow = (("topic_mode", "strict"), ("allowed_topics", "Order support"), ("restricted_topics", ""))
    deny = (("topic_mode", "permissive"), ("allowed_topics", ""), ("restricted_topics", "Refund fraud"))
    assert set(topic_questions(allow)) == {"unlisted_task"}
    assert set(topic_questions(deny)) == {"denied_task"}
    result = await evaluator(lambda _: pytest.fail("No model call required")).evaluate(
        replace(_topic_request(), parameters=(("topic_mode", "permissive"),)))
    assert result.verdict == "not_matched" and result.usage.model_invocations == 0


async def test_offline_replay_excludes_labels_and_keeps_unknown_errors_separate():
    path = Path("docs/examples/topic-control-lora/examples.jsonl")
    assert not load_samples(path)[0]  # Sample labels are proposed, not approved.
    samples, skipped = load_samples(path, include_proposed=True)
    assert skipped["output"] == 2 and skipped["needs_review"] == 1
    responses = iter([0.5, 0.99])
    def respond(request):
        body = json.loads(request.content)
        assert set(body["state"]) == {"current_input", "context_messages"}
        assert "review_status" not in request.content.decode() and "off-topic" not in request.content.decode()
        value = next(responses)
        return response(**{key: value for key in body["questions"]})
    report = await replay(samples[:2], evaluator(respond), 5)
    assert report["outcomes"] == {"unknown": 1, "correct": 1}
    assert report["label_agreement"] == 0.5


@pytest.mark.parametrize("mode", ["allowlist", "unsupported"])
def test_topic_questions_reject_unsupported_modes(mode):
    with pytest.raises(ValueError, match="Unsupported topic mode"):
        topic_questions((("topic_mode", mode),))
