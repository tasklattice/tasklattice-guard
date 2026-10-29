"""Laya may diverge from JEV while both retain their own decision contracts."""
from dataclasses import replace
import json

import httpx
import pytest

from runner.providers import dynamic_runtime_action_providers
from runner.toolkit.nemo.actions.evaluate import EvaluationActionProvider
from runner.toolkit.nemo.evaluators.jev import JEV_PROFILE
from runner.toolkit.nemo.evaluators.laya import LAYA_PROFILE
from runner.toolkit.nemo.evaluators import jev_jailbreak, laya_jailbreak
from tests.control_plane.test_capability_validation import candidate
from tests.data_plane.test_laya_jailbreak import jailbreak_request


async def test_mixed_models_use_distinct_credentials_models_thresholds_and_verdicts():
    config = candidate("input", "content_safety", JEV_PROFILE).configuration
    config.runtimes[0].model = "jev-1.13.0"
    other = candidate("input", "jailbreak", LAYA_PROFILE, "tali.guard.jailbreak.v1").configuration
    other.runtimes[0].id = other.bindings[0].model_ref = "laya-model"
    other.runtimes[0].model = "laya"
    other.runtimes[0].credential_ref = "laya-provider"
    config.runtimes.extend(other.runtimes)
    config.bindings.extend(other.bindings)
    calls = []

    def respond(wire):
        body = json.loads(wire.content)
        expected_key = "laya-key" if body["model"] == "laya" else "jev-key"
        assert wire.headers["authorization"] == "Bearer " + expected_key
        calls.append(body["model"])
        return httpx.Response(200, json={"model": body["model"], "answers": {
            q: {"type": "noul", "noul": .7} for q in body["questions"]}})

    providers = dynamic_runtime_action_providers(config, {"provider-1": "jev-key", "laya-provider": "laya-key"},
        jev_thresholds=(.1, .85), laya_thresholds=(.2, .6), transport=httpx.MockTransport(respond))
    action = next(p for p in providers if isinstance(p, EvaluationActionProvider))
    request = jailbreak_request()
    laya = await action.execute(request)
    jev = await action.execute(replace(request, capability="content_safety",
        binding=replace(request.binding, capability="content_safety", contract_ref="tali.guard.content-safety.v1")))
    assert calls == ["laya", "jev-1.13.0"]
    assert laya.verdict == "matched" and jev.verdict == "unknown"
    assert json.loads(laya.trace[0].evidence)["thresholds"] == {"lower": .2, "upper": .6}
    assert json.loads(laya.trace[0].evidence)["decision_model"] == "laya"
    assert json.loads(jev.trace[0].evidence)["thresholds"] == {"lower": .1, "upper": .85}


def test_laya_prompts_do_not_follow_later_jev_prompt_changes(monkeypatch):
    original = laya_jailbreak.jailbreak_questions()
    monkeypatch.setattr(jev_jailbreak, "jailbreak_questions", lambda: {"changed_jev_question": {}})
    evaluator = laya_jailbreak.LayaJailbreakEvaluator(base_url="https://laya.test/v1", model="laya", api_key="synthetic")
    assert evaluator.questions(jailbreak_request()) == original


@pytest.mark.parametrize("binding_profile,runtime_profile", [(LAYA_PROFILE, JEV_PROFILE), (JEV_PROFILE, LAYA_PROFILE)])
def test_cross_family_binding_cannot_silently_select_a_different_protocol(binding_profile, runtime_profile):
    config = candidate("input", "jailbreak", binding_profile, "tali.guard.jailbreak.v1").configuration
    config.runtimes[0].profile_ref = runtime_profile
    with pytest.raises(ValueError, match="matching capability, contract and runtime profile"):
        dynamic_runtime_action_providers(config, {"provider-1": "synthetic"})


@pytest.mark.parametrize("capability,contract,attack_marker", [
    ("content_safety", "tali.guard.content-safety.v1", "build a bomb"),
    ("jailbreak", "tali.guard.jailbreak.v1", "Ignore all previous instructions"),
    ("topic_control", "tali.guard.topic-control.semantic.v1", "chocolate cake"),
])
@pytest.mark.parametrize("behavior", ["correct", "always-safe", "always-unsafe", "malformed"])
async def test_laya_binding_validation_requires_both_real_rail_outcomes(capability, contract, attack_marker, behavior):
    from runner.capability_validation import validate_capability

    request = candidate("input", capability, LAYA_PROFILE, contract)
    request.configuration.runtimes[0].model = "laya"
    calls = []

    def respond(wire):
        body = json.loads(wire.content)
        calls.append(body)
        unsafe = behavior == "always-unsafe" or behavior == "correct" and attack_marker in body["state"]["current_input"]
        answers = {} if behavior == "malformed" else {q: {"type": "noul", "noul": .99 if unsafe else .01} for q in body["questions"]}
        return httpx.Response(200, json={"model": "laya", "answers": answers})

    result = await validate_capability(request, {"provider-1": "synthetic"}, transport=httpx.MockTransport(respond))
    assert result.passed is (behavior == "correct"), result.message
    assert len(calls) == len(result.cases) == 2
    assert all(c["model"] == "laya" for c in calls)


def test_laya_external_evidence_is_named_separately_and_does_not_change_jev_rows():
    from runner.evaluation_evidence import evaluation_evidence
    from tests.data_plane.test_evaluation_evidence import decision

    original = decision()
    before = json.loads(evaluation_evidence(original))["evaluations"]
    laya = replace(original.trace[0], id="ljb:laya", evaluator_id="laya-jailbreak", model_name="laya",
        profile_ref=LAYA_PROFILE, evidence=json.dumps({"decision_model": "laya", "requested_model": "laya",
            "response_model": "laya", "question_revision": "laya-external-instruction-input.v1",
            "thresholds": {"lower": .1, "upper": .85}, "judgments": {
                "task_hijack": {"probability": .4}, "answer_planting": {"probability": .2}},
            "raw_input": "private input must stay private"}))
    body = json.loads(evaluation_evidence(replace(original, trace=(*original.trace, laya))))
    assert body["evaluations"] == before
    row, = body["layaEvaluations"]
    assert row["decisionModel"] == "laya" and row["evaluatorId"] == "laya-jailbreak"
    assert row["probabilities"] == {"task_hijack": .4, "answer_planting": .2}
    assert row["thresholds"]["upper"] == .85 and "private" not in json.dumps(body)


def test_laya_outer_action_failure_keeps_laya_attribution():
    from runner.evaluation_evidence import evaluation_evidence
    from tests.data_plane.test_evaluation_evidence import decision

    original = decision()
    failed = replace(original.trace[0], id="nemo:action:ljb", kind="action", evaluator_id=None,
        profile_ref=LAYA_PROFILE, model_name="laya", verdict="error", evidence=None)
    body = json.loads(evaluation_evidence(replace(original, trace=(failed,))))
    assert body["evaluations"] == [] and body["execution"]["status"] == "error"
    row, = body["layaEvaluations"]
    assert row["decisionModel"] == "laya" and row["verdict"] == "error"
