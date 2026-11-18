"""Published Policy definitions -> runtime group -> one built-in forward -> scoped reviewers."""
from copy import deepcopy
import json
from types import SimpleNamespace

import httpx
import pytest

from runner.builtin_laya import BuiltinLaya
from runner.compiler import DefaultRunnerCompiler
from runner.draft_preview import DraftPreviewRuntime
from runner.evaluation_evidence import evaluation_evidence
from runner import laya_native_batch
from runner.providers import dynamic_runtime_action_providers
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.evaluators.classifier_review import REVIEW_CONTRACT
from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext
from tests.control_plane.classifier_chain import CONTRACTS, build_controller_plan
from tests.control_plane.test_capability_validation import candidate


@pytest.fixture(scope="module")
def grouped_plan():
    return build_controller_plan()


@pytest.mark.parametrize("scores,review_topic,truncated,expected", [
    ({}, True, False, "allow"),
    ({"content_safety": .5, "topic_control": .5}, True, False, "block"),
    ({"topic_control": .5}, False, False, "allow"),
    ({}, True, True, "allow"),
])
async def test_runtime_batches_primaries_but_preserves_independent_reviews(tmp_path, monkeypatch, grouped_plan,
        scores, review_topic, truncated, expected):
    revision = "d" * 40
    model = BuiltinLaya(tmp_path)
    forwards, remote_calls = [], []
    text = "An ordinary synthetic request."

    def many(agent, items):
        forwards.append(items)
        results = []
        for index, item in enumerate(items):
            keys = set(item.questions)
            capability = "jailbreak" if "jailbreak_attempt" in keys else "content_safety" if "unsafe_content" in keys else "topic_control"
            result = {"model": "local-laya", "answers": {key: {"type": "noul", "noul": scores.get(capability, .01)} for key in keys},
                "usage": {"input_tokens": 20, "output_tokens": 0, "truncated": truncated and capability == "content_safety",
                    "state_tokens_dropped": 100 if truncated and capability == "content_safety" else 0},
                "inference_batch": {"id": "e" * 32, "size": len(items), "index": index,
                    "question_count": sum(len(i.questions) for i in items)}}
            results.append(result)
        return results

    monkeypatch.setattr(laya_native_batch, "predict_native_batch", many)
    monkeypatch.setattr(model, "_load", lambda: (revision, SimpleNamespace(
        system_one=lambda *_a, **_kw: pytest.fail("Independent primary unexpectedly bypassed the runtime batch"))))
    await model.start()
    configuration = candidate("input", "jailbreak", "tali.laya.v1", CONTRACTS["jailbreak"]).configuration
    for capability in ("content_safety", "topic_control"):
        configuration.bindings.extend(candidate("input", capability, "tali.laya.v1", CONTRACTS[capability]).configuration.bindings)
    native = configuration.runtimes[0]
    native.backend, native.checkpoint_revision, native.credential_ref, native.base_url, native.laya_request_mode = (
        "builtin_laya", revision, "", "", "")
    credentials = {}
    for capability, profile in [("content_safety", "tali.qwen3guard.v1"),
                                *([("topic_control", "generic-chat")] if review_topic else [])]:
        review = candidate("input", "classifier_review", profile, REVIEW_CONTRACT, review_capability=capability).configuration
        runtime = review.runtimes[0]
        runtime.id = review.bindings[0].model_ref = "review-" + capability
        runtime.model = runtime.id
        runtime.credential_ref = "key-" + capability
        credentials[runtime.credential_ref] = "synthetic"
        configuration.runtimes.extend(review.runtimes)
        configuration.bindings.extend(review.bindings)

    def remote(request):
        body = json.loads(request.content)
        remote_calls.append(body)
        if body["model"] == "review-content_safety":
            assert body["messages"][-1] == {"role": "user", "content": text}
            output = "Safety: Safe\nCategories: None"
        else:
            assert body["model"] == "review-topic_control"
            target = json.loads(body["messages"][-1]["content"])
            assert target["state"]["current_input"] == text
            assert "denied_task" in target["questions"]
            output = json.dumps({"answers": {key: "yes" for key in target["questions"]}})
        return httpx.Response(200, json={"model": body["model"], "choices": [{"message": {"content": output}}]})

    providers = action_providers(*dynamic_runtime_action_providers(configuration, credentials,
        builtin_laya=model, transport=httpx.MockTransport(remote)))
    preview = DraftPreviewRuntime(DefaultRunnerCompiler(), providers)
    try:
        result = await preview.evaluate(ProtectionRequest(phase="input", texts=(text,), evidence_scope="full",
            execution_purpose="validation", context=RequestContext(protocol="validation")),
            preview_id="builtin-batch", guardrail_id=grouped_plan["guardrail_id"], draft_revision=1,
            candidate_version=grouped_plan["guardrail_version"], plan=deepcopy(grouped_plan), runtime_profile="auto")
    finally:
        await preview.shutdown()
        await model.close()

    assert result.decision == expected, result.reason
    assert len(forwards) == 1 and len(forwards[0]) == 3
    assert forwards[0][0].state == text and forwards[0][1].state == text
    assert forwards[0][2].state == {"request": text, "restricted_topics": "Synthetic forbidden task"}
    evidence = json.loads(evaluation_evidence(result))
    rows = {row["capability"]: row for row in evidence["layaEvaluations"]}
    assert set(rows) == {"content_safety", "jailbreak", "topic_control"}
    assert {row["inferenceBatch"]["id"] for row in rows.values()} == {"e" * 32}
    assert all(row["inferenceBatch"]["size"] == 3 for row in rows.values())
    expected_calls = ["review-content_safety"] if truncated else (
        ["review-content_safety", "review-topic_control"] if scores.get("content_safety") == .5 else [])
    assert sorted(call["model"] for call in remote_calls) == expected_calls
    if scores.get("content_safety") == .5:
        assert rows["content_safety"]["review"]["profileRef"] == "tali.qwen3guard.v1"
        assert rows["topic_control"]["review"]["requestedModel"] == "review-topic_control"
    if not review_topic:
        assert rows["topic_control"]["verdict"] == "unknown" and "review" not in rows["topic_control"]
