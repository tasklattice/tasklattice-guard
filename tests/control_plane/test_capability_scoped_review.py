"""Each optional reviewer belongs to exactly one capability and stage."""
from copy import deepcopy
import json

import httpx
import pytest

from runner.capability_validation import validate_capability
from runner.providers import dynamic_runtime_action_providers
from runner.toolkit.nemo.evaluators.classifier_review import REVIEW_CONTRACT
from tests.control_plane.classifier_chain import build_controller_plan, scan
from tests.control_plane.test_capability_validation import candidate


@pytest.fixture(scope="module")
def input_plan():
    return build_controller_plan()


@pytest.mark.parametrize("security_answer,topic_answer,outcome", [
    ("no", "no", "cleared"), ("yes", "no", "blocked"),
    ("no", "yes", "blocked"), ("no", "unknown", "blocked"),
])
async def test_security_and_topic_use_separate_review_models(classifier_backend, input_plan, security_answer, topic_answer, outcome):
    response, calls, evidence = await scan(input_plan, {"content_safety":.5, "topic_control":.5},
        backend=classifier_backend, reviewer_profile="tali.qwen3guard.v1", topic_reviewer_profile="generic-chat",
        review={"content_safety":security_answer, "topic_control":topic_answer})
    assert response.status_code == 200, response.text
    assert response.json()["result"]["outcome"] == outcome
    assert calls.count("review:content_safety") == calls.count("review:topic_control") == 1
    rows = {row["capability"]:row for row in evidence[classifier_backend.evidence_key]}
    security, topic = rows["content_safety"]["review"], rows["topic_control"]["review"]
    assert security["requestedModel"] == "review-model-v1" and security["profileRef"] == "tali.qwen3guard.v1"
    assert topic["requestedModel"] == "topic-review-model-v1" and topic["answers"]
    assert "nativeVerdict" not in topic
    assert rows["content_safety"]["verdict"] == rows["topic_control"]["verdict"] == "unknown"
    assert evidence["execution"]["status"] == "complete"


@pytest.mark.parametrize("score,on_unknown,outcome,verdict", [
    (.01,"block","cleared","not_matched"), (.9,"allow","blocked","matched"),
    (.5,"allow","cleared","unknown"), (.5,"block","blocked","unknown"),
])
async def test_missing_topic_reviewer_keeps_laya_or_jev_as_final_classifier(classifier_backend, input_plan, score, on_unknown, outcome, verdict):
    plan = deepcopy(input_plan)
    for step in plan["steps"]:
        if step["capability"] == "topic_control":
            step["parameters"] = [[key, on_unknown if key == "on_unknown" else value] for key,value in step["parameters"]]
    response, calls, evidence = await scan(plan, {"topic_control":score}, backend=classifier_backend,
        reviewer_profile="tali.qwen3guard.v1", review={"topic_control":"yes"})
    assert response.status_code == 200, response.text
    assert response.json()["result"]["outcome"] == outcome
    assert not any(call.startswith("review:") for call in calls)
    row = next(row for row in evidence[classifier_backend.evidence_key] if row["capability"] == "topic_control")
    assert row["verdict"] == verdict and "review" not in row
    assert set(row["probabilities"].values()) == {score}


async def test_a_topic_reviewer_does_not_review_security_gray_areas(classifier_backend, input_plan):
    response, calls, evidence = await scan(input_plan, {"content_safety":.5, "topic_control":.5},
        backend=classifier_backend, reviewer_capabilities=["topic_control"], review={"topic_control":"no"})
    assert response.status_code == 200 and response.json()["result"]["outcome"] == "cleared"
    assert calls.count("review:topic_control") == 1 and "review:content_safety" not in calls
    row = next(row for row in evidence[classifier_backend.evidence_key] if row["capability"] == "content_safety")
    assert row["verdict"] == "unknown" and "review" not in row


@pytest.mark.parametrize("profile", ["generic-chat", "tali.classifier-review.v1"])
@pytest.mark.parametrize("behavior", ["correct", "always-safe", "always-unsafe", "malformed"])
async def test_topic_review_validation_uses_real_topic_examples_and_questions(profile, behavior):
    request = candidate("input", "classifier_review", profile, REVIEW_CONTRACT, review_capability="topic_control")
    calls = []
    def respond(req):
        data = json.loads(json.loads(req.content)["messages"][-1]["content"])
        calls.append(data)
        assert "unlisted_task" in data["questions"]
        assert "Product support and password reset" in json.dumps(data["questions"])
        unsafe = behavior == "always-unsafe" or behavior == "correct" and "chocolate cake" in data["state"]["current_input"]
        answers = {key:"yes" if unsafe else "no" for key in data["questions"]} if behavior != "malformed" else {}
        return httpx.Response(200,json={"model":"topic-review", "choices":[{"message":{"content":json.dumps({"answers":answers})}}]})
    result = await validate_capability(request, {"provider-1":"synthetic"}, transport=httpx.MockTransport(respond))
    assert result.passed is (behavior == "correct"), result.message
    assert len(calls) == len(result.cases) == 2
    assert [case.input_content for case in result.cases] == ["How can I reset my product password?", "Give me a recipe for chocolate cake."]


def test_runner_rejects_qwen_topic_review_even_if_the_controller_is_bypassed():
    configuration = candidate("input", "classifier_review", "tali.qwen3guard.v1", REVIEW_CONTRACT,
        review_capability="topic_control").configuration
    with pytest.raises(ValueError, match="Topic Control review requires a chat"):
        dynamic_runtime_action_providers(configuration, {"provider-1":"synthetic"})


@pytest.mark.parametrize("scope,rail", [("topic_control","output"), ("jailbreak","output"), ("unknown","input")])
def test_runner_rejects_unimplemented_review_capability_or_stage(scope, rail):
    configuration = candidate(rail, "classifier_review", "generic-chat", REVIEW_CONTRACT, review_capability=scope).configuration
    with pytest.raises(ValueError, match="matching Rail binding"):
        dynamic_runtime_action_providers(configuration, {"provider-1":"synthetic"})


@pytest.mark.parametrize("scope,rail,category,unsafe_fragment", [
    ("jailbreak","input","Jailbreak","DAN Mode"),
    ("pii_semantic","input","PII","Social Security number"),
    ("pii_semantic","output","PII","Social Security number"),
])
async def test_native_review_validation_exercises_the_selected_security_capability(scope, rail, category, unsafe_fragment):
    request = candidate(rail, "classifier_review", "tali.qwen3guard.v1", REVIEW_CONTRACT, review_capability=scope)
    calls = []
    def respond(req):
        message = json.loads(req.content)["messages"][-1]
        calls.append(message)
        assert message["role"] == ("assistant" if rail == "output" else "user")
        unsafe = unsafe_fragment in message["content"]
        content = f"Safety: Unsafe\nCategories: {category}" if unsafe else "Safety: Safe\nCategories: None"
        return httpx.Response(200,json={"model":"qwen-review", "choices":[{"message":{"content":content}}]})
    result = await validate_capability(request, {"provider-1":"synthetic"}, transport=httpx.MockTransport(respond))
    assert result.passed, result.message
    assert len(calls) == 2
