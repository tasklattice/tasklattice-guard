import json
import time
from dataclasses import replace

import httpx
import pytest

from tests.classifier_cases import jailbreak_request


@pytest.mark.parametrize("probability,verdict", [(0, "not_matched"), (0.1, "not_matched"),
                                               (0.10001, "unknown"), (0.5, "unknown"),
                                               (0.89999, "unknown"), (0.9, "matched"), (1, "matched")])
async def test_jailbreak_has_independent_question_probability_evidence_and_native_usage(classifier_backend, probability, verdict):
    request = jailbreak_request()

    def respond(http_request):
        assert str(http_request.url) == classifier_backend.base_url + "/systemone"
        assert http_request.headers["authorization"] == "Bearer synthetic-key"
        body = json.loads(http_request.content)
        if classifier_backend.name == "laya":
            assert set(body) == {"state", "model", "questions", "max_len", "head_max_len"}
            assert body["state"] == request.content
        else:
            assert set(body) == {"state", "model", "questions"}
            assert body["state"]["current_input"] == request.content
        assert set(body["questions"]) == {"jailbreak_attempt", "unsafe_pretext"}
        question = body["questions"]["jailbreak_attempt"]
        if classifier_backend.name == "laya":
            assert question["type"] == "noul" and len(question["instructions"]) < 120
            question = service.review_questions(request)["jailbreak_attempt"]
        assert question["type"] == "noul" and set(question["criteria"]) == {"true", "false"}
        assert "untrusted" in question["instructions"]
        assert "disguising the real requested behavior" in question["instructions"]
        assert "own formatting preferences" in question["instructions"]
        return httpx.Response(200, json={"model": classifier_backend.model, "answers": {
            key: {"type": "noul", "noul": probability} for key in body["questions"]},
            "usage": {"input_tokens": 40, "output_tokens": 7}})

    service = classifier_backend.evaluator("jailbreak", respond)
    result = await service.evaluate(request)
    assert result.verdict == verdict and result.content == request.content
    assert result.unknown_reason == "uncertain"
    assert result.confidence is None and bool(result.findings) is (verdict == "matched")
    assert all(f.confidence is None and f.risk_severity is None for f in result.findings)
    assert result.usage.model_invocations == 1
    evidence = json.loads(result.trace[0].evidence)
    assert evidence["profile"] == classifier_backend.profile and evidence["question_revision"] == classifier_backend.jailbreak_revision
    assert evidence["judgments"]["jailbreak_attempt"]["probability"] == probability
    assert "synthetic-key" not in result.trace[0].evidence


@pytest.mark.parametrize("override,pretext,verdict", [
    (0.05, 0.05, "not_matched"), (0.05, 0.95, "matched"),
    (0.95, 0.05, "matched"), (0.5, 0.05, "unknown"), (0.05, 0.5, "unknown"),
    (0.95, 0.5, "matched"),
])
async def test_independent_bypass_questions_combine_without_treating_uncertainty_as_safe(classifier_backend, override, pretext, verdict):
    def respond(_request):
        return httpx.Response(200, json={"model": classifier_backend.model, "answers": {
            key: {"type": "noul", "noul": value}
            for key, value in {"jailbreak_attempt": override, "unsafe_pretext": pretext}.items()}})

    result = await classifier_backend.evaluator("jailbreak", respond).evaluate(jailbreak_request())
    assert result.verdict == verdict
    assert result.usage.model_invocations == 1
    assert set(json.loads(result.trace[0].evidence)["judgments"]) == {"jailbreak_attempt", "unsafe_pretext"}


@pytest.mark.parametrize("failure", ["authentication", "rate-limit", "server", "malformed", "wrong-question", "missing-question", "empty-model", "bool"])
async def test_remote_errors_and_invalid_answers_never_become_safe(classifier_backend, failure):
    def respond(_request):
        if failure in {"authentication", "rate-limit", "server"}:
            return httpx.Response({"authentication": 401, "rate-limit": 429, "server": 503}[failure])
        if failure == "malformed":
            return httpx.Response(200, text="not-json")
        answers = {key: {"type": "noul", "noul": True if failure == "bool" else 0}
                   for key in ("jailbreak_attempt", "unsafe_pretext")}
        if failure == "wrong-question":
            answers["denied_task"] = answers.pop("jailbreak_attempt")
        if failure == "missing-question":
            answers.pop("unsafe_pretext")
        return httpx.Response(200, json={"model": "" if failure == "empty-model" else classifier_backend.model, "answers": answers})

    result = await classifier_backend.evaluator("jailbreak", respond).evaluate(jailbreak_request())
    assert result.verdict == "error" and not result.findings
    assert result.usage.model_invocations == 1
    assert "synthetic-key" not in result.reason


async def test_output_wrong_contract_and_expired_deadline_do_not_call_provider(classifier_backend):
    calls = []
    service = classifier_backend.evaluator("jailbreak", lambda request: calls.append(request))
    request = jailbreak_request()
    for invalid in [replace(request, rail_type="output"), replace(request, capability="content_safety"),
                    replace(request, binding=replace(request.binding, contract_ref="tali.guard.content-safety.v1")),
                    replace(request, deadline=time.monotonic() - 1)]:
        assert (await service.evaluate(invalid)).verdict == "error"
    assert not calls
