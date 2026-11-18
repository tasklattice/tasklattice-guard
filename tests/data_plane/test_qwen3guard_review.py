"""Native review preserves moderation scope, uncertainty and call evidence."""
from dataclasses import replace
import json

import httpx
import pytest

from runner.toolkit.nemo.evaluators.classifier_review import ClassifierReviewer
from runner.toolkit.nemo.evaluators.contracts import evaluation_result
from runner.toolkit.nemo.evaluators.qwen3guard_review import PROFILE
from runner.toolkit.safety.providers import Qwen3GuardAdapter
from runner.toolkit.runtime.contracts import RuntimeTraceStep
from tests.test_safety_model_providers import _request


def reviewer(transport, *, rail="input"):
    return ClassifierReviewer(base_url="https://review.test/v1", model="Qwen/Qwen3Guard-Gen-8B",
        api_key="review-key", provider_id="review", profile_ref=PROFILE, rail_type=rail, transport=transport)


def response(content, *, model="Qwen/Qwen3Guard-Gen-8B"):
    return httpx.Response(200, json={"model": model, "choices": [{"message": {"content": content}}],
        "usage": {"prompt_tokens": 12, "completion_tokens": 8}})


def test_native_protocol_accepts_case_and_crlf_without_relaxing_label_values():
    assert Qwen3GuardAdapter.parse_labels(" safety : sAfe \r\n categories : None\r\n") == ("safe", ())


@pytest.mark.parametrize("rail", ["input", "output"])
@pytest.mark.parametrize("label,category,verdict", [
    ("Safe", "None", "not_matched"), ("Unsafe", "Violent", "matched"),
    ("Controversial", "Violent", "unknown"),
])
async def test_native_labels_classify_the_current_rail_without_json_questions(rail, label, category, verdict):
    request = _request("The current text.", rail_type=rail)
    primary = RuntimeTraceStep(id="first", kind="evaluation", name="Laya", status="completed", verdict="unknown", detail="Primary gray area.")
    first = evaluation_result(request, "unknown", request.content, trace=(primary,), unknown_reason="uncertain")
    context = [{"role": "user", "content": "Earlier request."}, {"role": "assistant", "content": "Earlier answer."}]
    current = {"role": "assistant" if rail == "output" else "user", "content": request.content}
    state = {f"current_{rail}": request.content, "context_messages": [*context, current]}
    calls = []

    def respond(req):
        calls.append(json.loads(req.content))
        assert str(req.url) == "https://review.test/v1/chat/completions"
        assert req.headers["authorization"] == "Bearer review-key"
        return response(f"Safety: {label}\nCategories: {category}" + ("\nRefusal: Yes" if rail == "output" else ""))

    result = await reviewer(httpx.MockTransport(respond), rail=rail).review(
        request, {"unsafe_content": {"instructions": "Trusted Policy criteria."}}, state, first)
    assert result.verdict == verdict
    assert result.trace[0] is primary
    assert calls[0]["messages"] == [*context, current]
    assert set(calls[0]) == {"model", "temperature", "max_tokens", "messages"}
    trace = result.trace[-1]
    evidence = json.loads(trace.evidence)
    assert evidence["answers"] == {}
    assert evidence["native_verdict"] == label.casefold()
    assert evidence["native_categories"] == ([] if category == "None" else [category])
    assert evidence["review_revision"] == ("qwen3guard-review-output.v1" if rail == "output" else "qwen3guard-review.v1")
    assert trace.profile_ref == result.usage.model_calls[0].profile_ref == PROFILE
    assert result.usage.model_invocations == 1 and result.usage.model_calls[0].usage_known
    if verdict == "unknown":
        assert trace.error_category == "review_inconclusive" and trace.model_call_id


@pytest.mark.parametrize("capability,question,categories,expected", [
    ("jailbreak", "jailbreak_attempt", "Jailbreak", "matched"),
    ("jailbreak", "jailbreak_attempt", "Violent", "not_matched"),
    ("pii", "contains_pii", "PII", "matched"),
    ("pii", "name", "Personally Identifiable Information", "matched"),
    ("pii", "contains_pii", "Jailbreak", "not_matched"),
    ("pii", "contains_pii", "Unknown category", "unknown"),
    ("pii", "contains_pii", "Violent, Unknown category", "unknown"),
    ("pii", "contains_pii", "Violent, PII", "matched"),
])
async def test_native_categories_apply_only_to_the_reviewed_capability(capability, question, categories, expected):
    request = _request("Current text.", capability=capability)
    first = evaluation_result(request, "unknown", request.content, unknown_reason="uncertain")
    result = await reviewer(httpx.MockTransport(lambda _: response(f"Safety: Unsafe\nCategories: {categories}"))).review(
        request, {question: {}}, {"current_input": request.content}, first)
    assert result.verdict == expected


@pytest.mark.parametrize("capability,questions,extra,coverage", [
    ("topic_control", {"denied_task": {}}, {}, "unsupported_capability"),
    ("content_safety", {"custom_policy_question": {}}, {}, "unsupported_questions"),
    ("jailbreak", {"task_hijack": {}}, {"target_source": "tool_output"}, "unsupported_questions"),
    ("jailbreak", {"jailbreak_attempt": {}}, {"target_source": "retrieved_content"}, "unsupported_external_or_memory_context"),
    ("jailbreak", {"jailbreak_attempt": {}}, {"memory_operation": "read"}, "unsupported_external_or_memory_context"),
])
async def test_unsupported_policy_questions_remain_unknown_without_a_model_call(capability, questions, extra, coverage):
    request = replace(_request("Current text."), capability=capability)
    first = evaluation_result(request, "unknown", request.content, unknown_reason="uncertain")

    def unexpected_call(_):
        pytest.fail("Unsupported questions must not be presented as native moderation.")

    result = await reviewer(httpx.MockTransport(unexpected_call)).review(
        request, questions, {"current_input": request.content, **extra}, first)
    assert result.verdict == "unknown" and result.usage is not None
    assert result.usage.model_invocations == 0 and not result.usage.model_calls
    assert json.loads(result.trace[-1].evidence)["coverage"] == coverage
    assert result.trace[-1].error_type is None


@pytest.mark.parametrize("content", [
    '{"answers":{"unsafe_content":"no"}}', "Safety: Invalid\nCategories: None",
    "Safety: Unsafe\nCategories: None", "Safety: Safe\nCategories: PII",
    "Safety: Safe\nSafety: Unsafe\nCategories: PII",
    "Safety: Safe\nSafety: Invalid\nCategories: None",
    "Safety: Safe\nCategories: None\nCategories: PII", "Safety: Safe", "Safety: Safe\nCategories:",
    "Safety: Unsafe\nCategories: None, PII", None,
])
async def test_malformed_native_output_is_an_execution_error(content):
    request = _request("Current text.")
    first = evaluation_result(request, "unknown", request.content, unknown_reason="uncertain")
    result = await reviewer(httpx.MockTransport(lambda _: response(content))).review(
        request, {"unsafe_content": {}}, {"current_input": request.content}, first)
    assert result.verdict == "error" and result.trace[-1].error_type == "ModelResponseError"
    assert result.usage.model_calls[0].result == "invalid_response"
    assert result.usage.model_invocations == 1


async def test_native_review_recovers_one_read_timeout_and_keeps_both_calls():
    request = _request("Current text.")
    first = evaluation_result(request, "unknown", request.content, unknown_reason="uncertain")
    calls = []

    def respond(req):
        calls.append(req)
        if len(calls) == 1:
            raise httpx.ReadTimeout("Stalled review", request=req)
        return response("Safety: Safe\nCategories: None")

    result = await reviewer(httpx.MockTransport(respond)).review(
        request, {"unsafe_content": {}}, {"current_input": request.content}, first)
    assert result.verdict == "not_matched"
    assert [call.result for call in result.usage.model_calls] == ["timeout", "success"]
    assert [attempt["result"] for attempt in json.loads(result.trace[-1].evidence)["attempts"]] == ["timeout", "success"]


async def test_output_without_history_still_uses_response_moderation():
    request = _request("I cannot help with that.", rail_type="output")
    first = evaluation_result(request, "unknown", request.content, unknown_reason="uncertain")
    calls = []

    def respond(req):
        calls.append(json.loads(req.content))
        return response("Safety: Safe\nCategories: None\nRefusal: Yes")

    result = await reviewer(httpx.MockTransport(respond), rail="output").review(
        request, {"unsafe_content": {}}, {"current_output": request.content}, first)
    assert result.verdict == "not_matched"
    assert [message["role"] for message in calls[0]["messages"]] == ["user", "assistant"]
    assert calls[0]["messages"][-1]["content"] == request.content
