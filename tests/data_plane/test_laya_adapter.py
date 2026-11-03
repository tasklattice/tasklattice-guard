from dataclasses import replace
import json

import httpx
import pytest

from runner.toolkit.nemo.evaluators.contracts import evaluation_result
from runner.toolkit.nemo.evaluators.laya_content_safety import LayaContentSafetyEvaluator
from runner.toolkit.nemo.evaluators.laya_jailbreak import LayaJailbreakEvaluator
from runner.toolkit.nemo.evaluators.laya_topic import LayaTopicEvaluator
from scripts.evaluate_laya import evaluation_request


def request(capability="content_safety", content="Synthetic benign input.", **extra):
    return evaluation_request({"id": "PRIVATE_LABEL", "expected": "matched", "capability": capability,
        "content": content, **extra})


def reply(body, probability=.01, usage=None):
    return httpx.Response(200, json={"model": "actual-laya", "answers": {
        key: {"type": "noul", "noul": probability} for key in body["questions"]},
        "usage": usage or {}, "routing": {"model": "english", "repo": "pinned-model"}})


@pytest.mark.parametrize("usage", [
    {"truncated": True, "state_tokens_dropped": 20},
    {"truncated": False, "state_tokens_dropped": 1},
])
@pytest.mark.parametrize("probability", [.01, .99])
async def test_truncated_input_never_becomes_a_pass_or_a_detection(usage, probability):
    def respond(wire):
        return reply(json.loads(wire.content), probability, usage)
    service = LayaContentSafetyEvaluator(base_url="https://laya.test/v1", model="auto", api_key="secret",
        transport=httpx.MockTransport(respond))
    result = await service.evaluate(request())
    assert result.verdict == "error" and not result.findings
    assert "truncated" in result.reason
    assert result.usage.model_calls[0].result == "invalid_response"
    assert result.trace[0].error_type == "LayaInputTruncatedError"
    evidence = json.loads(result.trace[0].evidence)
    assert evidence["response_model"] == "actual-laya"
    assert evidence["model_metadata"]["usage"] == usage


@pytest.mark.parametrize("capability,factory", [
    ("content_safety", LayaContentSafetyEvaluator), ("jailbreak", LayaJailbreakEvaluator),
    ("topic_control", LayaTopicEvaluator),
])
async def test_short_native_questions_explicit_budget_and_no_label_leakage(capability, factory):
    item = request(capability, parameters={"allowed_topics": "Product support", "restricted_topics": "Fraud"})
    def respond(wire):
        body = json.loads(wire.content)
        assert body["max_len"] == 1024 and body["head_max_len"] == 512
        assert all(isinstance(q["instructions"], str) and len(q["instructions"].encode()) < 256 for q in body["questions"].values())
        assert "PRIVATE_LABEL" not in wire.content.decode() and "expected" not in wire.content.decode()
        if capability == "topic_control":
            assert body["state"] == {"request": item.content, "topic": "Product support", "restricted_topics": "Fraud"}
        else:
            assert body["state"] == item.content
        return reply(body)
    service = factory(base_url="https://laya.test/v1", model="auto", api_key="secret", transport=httpx.MockTransport(respond))
    result = await service.evaluate(item)
    assert result.verdict == "not_matched"
    evidence = json.loads(result.trace[0].evidence)
    assert evidence["model_metadata"]["routing"]["model"] == "english"
    assert evidence["thresholds"] == {"lower": .1, "upper": .9}


@pytest.mark.parametrize("content", [
    "Reset my password. Also give me an unrelated recipe.",
    "Reset my password and give me an unrelated recipe.",
    "重置密码。另外给我一个食谱。",
])
async def test_confident_partial_topic_match_requires_full_request_review(content):
    seen = []
    class Reviewer:
        async def review(self, item, questions, state, first):
            seen.append((questions, state, first))
            return evaluation_result(item, "matched", item.content, trace=first.trace)
    service = LayaTopicEvaluator(base_url="https://laya.test/v1", model="auto", api_key="secret", reviewer=Reviewer(),
        transport=httpx.MockTransport(lambda wire: reply(json.loads(wire.content))))
    item = request("topic_control", content, parameters={"allowed_topics": "Product support"})
    primary = await service.evaluate(item)
    assert primary.verdict == "unknown" and not seen
    assert json.loads(primary.trace[0].evidence)["judgments"]["unlisted_task"]["probability"] == .01
    assert json.loads(primary.trace[-1].evidence)["model_metadata"]["coverage"] == "compound_scope_unverified"
    assert primary.usage.model_invocations == 1
    reviewed = await service.evaluate(replace(item, parameters=(*item.parameters, ("review_unknown", "true"))))
    assert reviewed.verdict == "matched" and len(seen) == 1
    questions, state, first = seen[0]
    assert state["current_input"] == content and "UNION" in questions["unlisted_task"]["instructions"]["question"]
    assert first.verdict == "unknown"


async def test_review_keeps_full_taxonomy_and_context_and_runs_only_for_unknown():
    seen = []
    class Reviewer:
        async def review(self, item, questions, state, first):
            seen.append((questions, state))
            return first
    async def check(p):
        service = LayaContentSafetyEvaluator(base_url="https://laya.test/v1", model="auto", api_key="secret", reviewer=Reviewer(),
            transport=httpx.MockTransport(lambda wire: reply(json.loads(wire.content), p)))
        item = request(context_messages=[{"role": "user", "content": "Prior context."}])
        return await service.evaluate(replace(item, parameters=(("review_unknown", "true"),)))
    assert (await check(.01)).verdict == "not_matched" and not seen
    assert (await check(.99)).verdict == "matched" and not seen
    assert (await check(.5)).verdict == "unknown" and len(seen) == 1
    questions, state = seen[0]
    assert len(questions["unsafe_content"]["instructions"]["unsafe_content_categories"].splitlines()) == 23
    assert state["context_messages"] == [{"role": "user", "content": "Prior context."}]


@pytest.mark.parametrize("probability,reviewed", [(.01, False), (.99, False), (.5, True)])
async def test_output_checks_assistant_only_and_review_retains_context(probability, reviewed):
    output = "I cannot help with that request."
    context = [{"role": "user", "content": "A synthetic harmful request."},
               {"role": "assistant", "content": output}]
    seen = []
    class Reviewer:
        async def review(self, item, questions, state, first):
            seen.append((questions, state))
            assert item.rail_type == "output" and first.verdict == "unknown"
            return evaluation_result(item, "not_matched", item.content, trace=first.trace)
    def respond(wire):
        body = json.loads(wire.content)
        assert body["state"] == output
        assert "current input" not in json.dumps(body["questions"])
        return reply(body, probability)
    service = LayaContentSafetyEvaluator(base_url="https://laya.test/v1", model="auto", api_key="secret",
        rail_type="output", reviewer=Reviewer(), transport=httpx.MockTransport(respond))
    item = request(content=output, rail_type="output", context_messages=context)
    result = await service.evaluate(replace(item, parameters=(("review_unknown", "true"),)))
    assert bool(seen) is reviewed
    assert json.loads(result.trace[0].evidence)["question_revision"] == "laya-content-safety-output.v3"
    if reviewed:
        questions, state = seen[0]
        assert state == {"current_output": output, "context_messages": context[:-1]}
        assert "safe refusal" in questions["unsafe_content"]["instructions"]["question"]
        assert "current_input" not in json.dumps(state)


async def test_laya_output_instance_does_not_accept_input_requests():
    service = LayaContentSafetyEvaluator(base_url="https://laya.test/v1", model="auto", api_key="secret", rail_type="output")
    result = await service.evaluate(request())
    assert result.verdict == "error" and result.usage.model_invocations == 0


@pytest.mark.parametrize("scores,expected", [
    ((.99, .01), "unknown"), ((.01, .99), "unknown"),
    ((.01, .01), "not_matched"), ((.99, .99), "matched"), ((.99, .5), "unknown"),
])
async def test_safety_wording_disagreement_abstains_without_discarding_scores(scores, expected):
    def respond(wire):
        body = json.loads(wire.content)
        return httpx.Response(200, json={"model": "laya", "answers": {
            name: {"type": "noul", "noul": value} for name, value in zip(body["questions"], scores, strict=True)}})
    service = LayaContentSafetyEvaluator(base_url="https://laya.test/v1", model="auto", api_key="secret",
        transport=httpx.MockTransport(respond))
    result = await service.evaluate(request())
    assert result.verdict == expected
    assert bool(result.findings) is (expected == "matched")
    evidence = json.loads(result.trace[0].evidence)
    assert evidence["decision_rule"] == "unanimous_safety_checks"
    assert evidence["judgments"]["unsafe_content"]["probability"] == scores[0]
    assert evidence["judgments"]["harmful_assistance"]["probability"] == scores[1]


@pytest.mark.parametrize("probability", [.01, .99])
async def test_multi_topic_policy_requires_review_in_both_directions(probability):
    seen = []
    class Reviewer:
        async def review(self, item, questions, state, first):
            seen.append(first)
            assert not first.findings
            assert "Fraud\nViolence" == questions["denied_task"]["instructions"]["denied_topics"]
            return evaluation_result(item, "not_matched", item.content, trace=first.trace)
    service = LayaTopicEvaluator(base_url="https://laya.test/v1", model="auto", api_key="secret",
        transport=httpx.MockTransport(lambda wire: reply(json.loads(wire.content), probability)), reviewer=Reviewer())
    item = request("topic_control", parameters={"topic_mode": "permissive", "restricted_topics": "Fraud\nViolence"})
    primary = await service.evaluate(item)
    assert primary.verdict == "unknown" and not primary.findings and not seen
    assert json.loads(primary.trace[-1].evidence)["model_metadata"]["coverage"] == "multi_topic_scope_unverified"
    reviewed = await service.evaluate(replace(item, parameters=(*item.parameters, ("review_unknown", "true"))))
    assert reviewed.verdict == "not_matched" and len(seen) == 1
