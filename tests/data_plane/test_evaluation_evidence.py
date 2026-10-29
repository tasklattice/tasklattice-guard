import json
from dataclasses import replace

import httpx
import pytest
from fastapi import FastAPI

from runner.api import RunnerAPI
from runner.evaluation_evidence import evaluation_evidence, MAX_HEADER_BYTES
from runner.toolkit.runtime.contracts import ProtectionDecision, RuntimeTraceStep, AppliedIntervention, RuntimeUsage
from tests.test_runner_api import Store, Metrics, Runtime, Telemetry


def decision(verdict="unknown", mode="enforce"):
    native = {"question_revision": "jailbreak-input.v3", "thresholds": {"lower": 0.1, "upper": 0.9},
              "judgments": {"jailbreak_attempt": {"probability": 0.4}, "unsafe_pretext": {"probability": 0.5}},
              "raw_input": "private content must not leave the runtime"}
    trace = RuntimeTraceStep(id="jb:jev", kind="evaluation", name="Jev", status="completed", detail="private reason",
                             evaluator_id="typesafe-jev-jailbreak", capability="jailbreak", verdict=verdict,
                             model_name="jev-1.13.0", policy_id="builtin-jailbreak", evidence=json.dumps(native),
                             content_block_id="input:0")
    return ProtectionDecision(decision="block", action="block", guardrail_id="guard", trace=(trace,), protection_mode=mode,
         interventions=(AppliedIntervention(kind="block",module_id="jb",fragment_id="nemo:jb:block",content_block_id="input:0"),))


@pytest.mark.parametrize("native_verdict,verdict,action", [("safe", "not_matched", "allow"), ("unsafe", "matched", "block"), (None, "error", "block")])
def test_native_classification_keeps_its_label_action_and_model_without_fabricated_probabilities(native_verdict, verdict, action):
    original = decision()
    classifier = replace(original.trace[0], id="cs:native-safety", evaluator_id="model-safety", capability="content_safety",
        verdict=verdict, policy_id="builtin-content-safety", model_name="native-model", evidence=json.dumps({
            "native_verdict": native_verdict, "requested_model": "native-model", "response_model": "actual-model",
            "raw_output": "private provider output"}))
    action_step = replace(classifier, kind="action", id="nemo:action:cs", evidence=json.dumps({"policy_action": action}))
    evidence = json.loads(evaluation_evidence(replace(original, trace=(classifier, action_step, *original.trace))))
    row, = evidence["classifications"]
    assert row["nativeVerdict"] == native_verdict and row["verdict"] == verdict and row["policyAction"] == action
    assert row["responseModel"] == "actual-model"
    assert "probabilities" not in row and "thresholds" not in row and "private" not in json.dumps(evidence)
    assert len(evidence["evaluations"]) == 1


def test_native_classifier_outer_timeout_retains_requested_model_and_error_without_a_fabricated_label():
    original = decision()
    step = replace(original.trace[0], id="nemo:action:cs", kind="action", evaluator_id=None, capability="content_safety",
        profile_ref="tali.nemotron-content-safety.v1", model_name="native-model", verdict="error", timed_out=True,
        evidence=None, status="error")
    body = json.loads(evaluation_evidence(replace(original, trace=(step,))))
    row, = body["classifications"]
    assert body["execution"]["status"] == "error"
    assert row["verdict"] == "error" and row["requestedModel"] == "native-model"
    assert row["nativeVerdict"] is None and row["responseModel"] is None


def test_native_classification_monitor_and_truncation_preserve_the_evidence_contract():
    original = decision(mode="monitor")
    classifier = replace(original.trace[0], id="cs:native-safety", evaluator_id="model-safety", capability="content_safety",
        verdict="matched", model_name="native-model", evidence=json.dumps({"native_verdict":"unsafe"}))
    raw = evaluation_evidence(replace(original, trace=(classifier,)))
    assert json.loads(raw)["classifications"][0]["enforcedAction"] is None
    body = json.loads(evaluation_evidence(replace(original, trace=(classifier,)*100)))
    assert not body["complete"] and len(json.dumps(body,separators=(",",":")))<=MAX_HEADER_BYTES


@pytest.mark.parametrize("verdict", ["matched", "unknown", "not_matched", "error"])
def test_evidence_preserves_verdict_and_native_operating_point_without_source_text(verdict):
    raw=evaluation_evidence(decision(verdict)); body=json.loads(raw); row=body["evaluations"][0]
    assert row["verdict"] == verdict and row["enforcedAction"] == "block"
    assert row["questionRevision"] == "jailbreak-input.v3"
    assert row["probabilities"] == {"jailbreak_attempt":0.4,"unsafe_pretext":0.5}
    assert "private" not in raw and body["complete"]


def test_content_safety_evidence_uses_its_own_capability_and_question():
    original = decision()
    trace = replace(original.trace[0], evaluator_id="typesafe-jev-content-safety", capability="content_safety",
        policy_id="builtin-content-safety", evidence=json.dumps({"question_revision": "content-safety-input.v1",
            "thresholds": {"lower": .1, "upper": .9}, "judgments": {"unsafe_content": {"probability": .4},
            "jailbreak_attempt": {"probability": .8}}, "raw_input": "private"}))
    raw = evaluation_evidence(replace(original, trace=(trace,)))
    row = json.loads(raw)["evaluations"][0]
    assert row["evaluatorId"] == "typesafe-jev-content-safety" and row["capability"] == "content_safety"
    assert row["probabilities"] == {"unsafe_content": .4}
    assert row["verdict"] == "unknown" and row["enforcedAction"] == "block"
    assert "private" not in raw


@pytest.mark.parametrize("verdict,action", [("unknown", "block"), ("unknown", None), ("matched", "block"), ("error", None)])
def test_topic_evidence_explains_its_own_action_without_leaking_topic_text(verdict, action):
    original = decision()
    topic = replace(original.trace[0], id="topic:jev", evaluator_id="typesafe-jev-topic", capability="topic_control",
        policy_id="builtin-topic-safety", verdict=verdict, evidence=json.dumps({"question_revision": "topic-input.v1",
            "thresholds": {"lower": .1, "upper": .9}, "judgments": {"denied_task": {"probability": .4},
            "unlisted_task": {"probability": .5}, "unsafe_content": {"probability": .8}}, "denied_topics": "private"}))
    safe_jailbreak = replace(original.trace[0], verdict="not_matched")
    interventions = (replace(original.interventions[0], fragment_id="nemo:topic:block"),) if action else ()
    raw = evaluation_evidence(replace(original, trace=(safe_jailbreak, topic), interventions=interventions))
    rows = json.loads(raw)["evaluations"]
    assert rows[0]["verdict"] == "not_matched" and rows[0]["enforcedAction"] is None
    assert rows[1]["capability"] == "topic_control" and rows[1]["enforcedAction"] == action
    assert rows[1]["verdict"] == verdict
    assert rows[1]["probabilities"] == {"denied_task": .4, "unlisted_task": .5}
    assert "private" not in raw


@pytest.mark.parametrize("profile", ["tali.typesafe-jev.v1", "tali.typesafe-jev-topic.v1"])
def test_topic_failure_without_evaluator_step_keeps_capability_attribution(profile):
    original = decision()
    trace = replace(original.trace[0], kind="action", evaluator_id=None, capability="topic_control",
        profile_ref=profile, verdict="error", evidence=None)
    row = json.loads(evaluation_evidence(replace(original, trace=(trace,))))["evaluations"][0]
    assert row["evaluatorId"] == "typesafe-jev-topic" and row["verdict"] == "error"


def test_monitor_nonterminal_unknown_other_content_and_truncation_do_not_claim_enforcement():
    original=decision()
    for modified in [decision(mode="monitor"),replace(original,interventions=()),
                     replace(original,interventions=(replace(original.interventions[0],content_block_id="input:1"),))]:
        assert json.loads(evaluation_evidence(modified))["evaluations"][0]["enforcedAction"] is None
    bounded=json.loads(evaluation_evidence(replace(original,trace=original.trace*40)))
    assert not bounded["complete"] and len(json.dumps(bounded,separators=(",",":")))<=MAX_HEADER_BYTES
    assert json.loads(evaluation_evidence(replace(original,trace=())))['evaluations']==[]


async def test_litellm_opt_in_evidence_keeps_standard_body_and_default_contract():
    class JevRuntime(Runtime):
        async def evaluate(self,*args,**kwargs):return decision()
    app=FastAPI();app.include_router(RunnerAPI(JevRuntime(),Store(),Metrics(),Telemetry(),"runner","token").router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url="http://runner") as client:
        for opt_in in (False,True):
            response=await client.post('/runtime/v1/endpoints/endpoint-1/beta/litellm_basic_guardrail_api',
                headers={"x-api-key":"valid-secret",**({"x-guard-evidence":"evaluations-v1"} if opt_in else {})},
                json={"input_type":"request","texts":["benign"]})
            assert response.status_code==200 and response.json()=={"action":"BLOCKED"}
            assert ('x-guard-evaluation-evidence' in response.headers) is opt_in


def test_execution_failure_is_separate_from_jailbreak_verdict_and_contains_no_reason():
    safe = decision('not_matched')
    failed = replace(safe, usage=RuntimeUsage(fail_closed=True), trace=(*safe.trace,
        RuntimeTraceStep(id='cs', kind='action', name='Content safety', status='error',
                         verdict='error', error_type='http_5xx', detail='private upstream response')))
    body = json.loads(evaluation_evidence(failed))
    assert body['execution'] == {'status': 'error', 'failClosed': True, 'errorTypes': ['http_5xx']}
    assert body['evaluations'][0]['verdict'] == 'not_matched'
    assert 'private' not in json.dumps(body)
    assert json.loads(evaluation_evidence(decision()))['execution']['status'] == 'complete'
    assert json.loads(evaluation_evidence(decision(mode='bypass')))['execution']['status'] == 'bypassed'
    recovered = replace(safe, trace=(*safe.trace, RuntimeTraceStep(id='provider-attempt', kind='model',
        name='Recovered provider attempt', status='error', detail='Fallback succeeded', error_type='http_5xx')))
    assert json.loads(evaluation_evidence(recovered))['execution']['status'] == 'complete'


def test_missing_context_is_incomplete_even_when_unknown_is_observed():
    from runner.toolkit.runtime.contracts import ModuleAssessment, RuntimeCoverage
    missing = replace(decision(), decision="allow", action="allow", interventions=(),
        assessments=(ModuleAssessment(module_id="topic", module="business_assurance", status="needs_context",
            fragments=(), coverage=RuntimeCoverage(status="partial")),))
    evidence = json.loads(evaluation_evidence(missing))
    assert evidence["execution"]["status"] == "error"
    assert evidence["evaluations"][0]["verdict"] == "unknown"
    assert evidence["evaluations"][0]["enforcedAction"] is None
