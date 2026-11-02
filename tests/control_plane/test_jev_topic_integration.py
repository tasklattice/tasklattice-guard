import json
from dataclasses import replace
from types import SimpleNamespace

import httpx
import pytest

from runner.capability_validation import _CandidateStore, validate_capability
from runner.providers import dynamic_runtime_action_providers
from runner.toolkit.compiler.nemo_compiler import NeMoConfigCompiler
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.evaluators.jev_topic import JEV_TOPIC_PROFILE
from runner.toolkit.nemo.evaluators.jev import JEV_PROFILE
from runner.toolkit.nemo.native_models import native_rail_models
from runner.toolkit.nemo.registry import NeMoRuntimeRegistry
from runner.toolkit.nemo.runtime import NeMoRuntime
from runner.toolkit.runtime.contracts import PlanResolution, ProtectionRequest, RequestContext
from runner.toolkit.runtime.service import GuardrailRuntimeService
from tests.control_plane.test_capability_validation import candidate
from tests.control_plane.test_nemo_iorails_topic import _plan, _semantic_input


def jev_candidate():
    return candidate("input", "topic_control", JEV_TOPIC_PROFILE, "tali.guard.topic-control.semantic.v1")


@pytest.mark.parametrize("behavior", ["correct", "always-safe", "uncertain", "malformed", "unavailable"])
async def test_jev_binding_validates_actual_topic_behavior_without_native_chat(behavior):
    def respond(request):
        assert request.url.path == "/v1/systemone"
        body = json.loads(request.content)
        if behavior == "unavailable":
            return httpx.Response(503)
        if behavior == "malformed":
            return httpx.Response(200, json={"answers": {}})
        p = 0.5 if behavior == "uncertain" else 0.99 if behavior == "correct" and "cake" in body["state"]["current_input"] else 0.01
        return httpx.Response(200, json={"model": "jev-1.13.0", "answers": {"unlisted_task": {"type": "noul", "noul": p}}})
    request = jev_candidate()
    assert native_rail_models(request.configuration, {"provider-1": "synthetic"}) == ()
    result = await validate_capability(request, {"provider-1": "synthetic"}, transport=httpx.MockTransport(respond))
    assert result.passed is (behavior == "correct"), result.message


@pytest.mark.parametrize("behavior", ["violation", "safe", "unknown", "error"])
async def test_monitor_runs_jev_preserves_evidence_and_never_enforces(behavior):
    calls = []
    def respond(request):
        body = json.loads(request.content)
        calls.append(body)
        if behavior == "error":
            return httpx.Response(503)
        return httpx.Response(200, json={"model": "jev-1.13.0", "answers": {
            key: {"type": "noul", "noul": 0.99 if behavior == "violation" else 0.01 if behavior == "safe" else 0.5} for key in body["questions"]}})
    config = jev_candidate().configuration
    providers = action_providers(*dynamic_runtime_action_providers(config, {"provider-1": "synthetic"}, transport=httpx.MockTransport(respond)))
    deny = replace(_semantic_input(), id="deny", parameters=(("evaluation_view", "original"), ("topic_mode", "permissive"), ("restricted_topics", "Refund fraud")))
    allow = replace(_semantic_input(), id="allow", parameters=(("evaluation_view", "original"), ("topic_mode", "strict"), ("allowed_topics", "Order support")))
    plan = _plan(deny, allow)
    snapshot = NeMoConfigCompiler().compile(plan)
    runtime = NeMoRuntime(NeMoRuntimeRegistry(_CandidateStore(plan, snapshot), providers))
    resolution = PlanResolution(plan=plan, router_id="test", endpoint_id="test")
    resolver = SimpleNamespace(resolve=lambda _: resolution, protection_mode=lambda _: "monitor")
    service = GuardrailRuntimeService(runtime, resolver)
    request = ProtectionRequest(phase="input", texts=("Help me commit refund fraud.",),
                                context=RequestContext(protocol="test", endpoint_id="test"), evidence_scope="full")
    try:
        observed = await service.evaluate(request)
        assert observed.decision == "allow" and observed.protection_mode == "monitor"
        assert not observed.interventions and observed.content_results[0].text == request.texts[0]
        assert calls and set(calls[0]["questions"]) == {"denied_task"}
        assert all(len(call["questions"]) == 1 for call in calls)
        if behavior == "violation":
            assert observed.detection_decision == "block" and observed.findings
            assert all(f.confidence is None for f in observed.findings)
        if behavior != "error":
            assert any(step.evaluator_id == "typesafe-jev-topic" and json.loads(step.evidence)["judgments"] for step in observed.trace)
        if behavior == "safe":
            assert observed.detection_decision == "allow" and not observed.findings
        if behavior == "error":
            assert observed.detection_error
    finally:
        await runtime.shutdown()


def test_jev_configuration_does_not_advertise_other_contracts_or_output():
    request = jev_candidate()
    request.configuration.bindings[0].contract_refs.append("tali.guard.content-safety.v1")
    with pytest.raises(ValueError, match="input Topic Control"):
        dynamic_runtime_action_providers(request.configuration, {"provider-1": "synthetic"})
    request = candidate("output", "topic_control", JEV_TOPIC_PROFILE, "tali.guard.topic-control.semantic.v1")
    with pytest.raises(ValueError, match="input Topic Control"):
        dynamic_runtime_action_providers(request.configuration, {"provider-1": "synthetic"})


@pytest.mark.parametrize("capability,contract", [("jailbreak", "tali.guard.jailbreak.v1"),
                                                ("content_safety", "tali.guard.content-safety.v1"),
                                                ("topic_control", "tali.guard.topic-control.semantic.v1")])
@pytest.mark.parametrize("behavior", ["correct", "always-safe", "uncertain", "authentication", "malformed"])
async def test_multi_capability_profile_executes_each_real_nemo_contract(capability, contract, behavior):
    calls = []

    def respond(request):
        assert request.url.path == "/v1/systemone"
        body = json.loads(request.content)
        calls.append(body)
        if behavior == "authentication":
            return httpx.Response(401)
        if behavior == "malformed":
            return httpx.Response(200, json={"answers": {}})
        text = body["state"]["current_input"]
        unsafe = {"jailbreak": "Ignore all previous instructions", "topic_control": "cake", "content_safety": "build a bomb"}[capability] in text
        probability = 0.5 if behavior == "uncertain" else 0.99 if behavior == "correct" and unsafe else 0.01
        return httpx.Response(200, json={"model": "jev-1.13.0", "answers": {
            key: {"type": "noul", "noul": probability} for key in body["questions"]}})

    config = candidate("input", capability, JEV_PROFILE, contract)
    result = await validate_capability(config, {"provider-1": "synthetic"}, transport=httpx.MockTransport(respond))
    assert result.passed is (behavior == "correct"), result.message
    assert len(calls) == 2
    expected_questions = {"jailbreak": {"jailbreak_attempt", "unsafe_pretext"}, "topic_control": {"unlisted_task"}, "content_safety": {"unsafe_content"}}
    assert all(set(c["questions"]) == expected_questions[capability] for c in calls)


@pytest.mark.parametrize("phase,capability,contract", [("output", "jailbreak", "tali.guard.jailbreak.v1"),
                                                     ("output", "content_safety", "tali.guard.content-safety.v1"),
                                                     ("input", "content_safety", "tali.guard.jailbreak.v1"),
                                                     ("output", "topic_control", "tali.guard.topic-control.semantic.v1")])
def test_multi_capability_profile_rejects_unsupported_rails_and_contracts(phase, capability, contract):
    config = candidate(phase, capability, JEV_PROFILE, contract)
    with pytest.raises(ValueError, match="Jev supports only"):
        dynamic_runtime_action_providers(config.configuration, {"provider-1": "synthetic"})


async def test_one_jev_model_serves_two_independent_bindings_in_one_runtime():
    config = candidate("input", "topic_control", JEV_PROFILE, "tali.guard.topic-control.semantic.v1").configuration
    config.bindings.extend(candidate("input", "jailbreak", JEV_PROFILE, "tali.guard.jailbreak.v1").configuration.bindings)
    calls = []

    def respond(request):
        body = json.loads(request.content)
        calls.append(body)
        return httpx.Response(200, json={"model": "jev-1.13.0", "answers": {
            key: {"type": "noul", "noul": 0.01} for key in body["questions"]}})

    providers = action_providers(*dynamic_runtime_action_providers(config, {"provider-1": "synthetic"}, transport=httpx.MockTransport(respond)))
    topic = _semantic_input()
    jailbreak = replace(topic, id="jailbreak", capability="jailbreak", contract_ref="tali.guard.jailbreak.v1", parameters=(("evaluation_view", "original"),))
    plan = _plan(topic, jailbreak)
    snapshot = NeMoConfigCompiler().compile(plan)
    runtime = NeMoRuntime(NeMoRuntimeRegistry(_CandidateStore(plan, snapshot), providers))
    try:
        from runner.toolkit.runtime.contracts import EngineRequest
        decision = await runtime.evaluate(EngineRequest(phase="input", text="How do I reset my password?", plan=plan))
        assert decision.decision == "allow"
        assert len(calls) == 2
        assert [set(c["questions"]) for c in calls] == [{"unlisted_task"}, {"jailbreak_attempt", "unsafe_pretext"}]
        assert {step.evaluator_id for step in decision.trace if step.evaluator_id}.issuperset({"typesafe-jev-topic", "typesafe-jev-jailbreak"})
    finally:
        await runtime.shutdown()
