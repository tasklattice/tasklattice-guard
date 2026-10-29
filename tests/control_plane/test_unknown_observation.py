"""An observation-only model Rule cannot enforce its unknown verdict."""
import json
from dataclasses import replace
from datetime import UTC, datetime
from types import SimpleNamespace

import httpx
import pytest

from runner.capability_validation import _CandidateStore
from runner.scan import ScanFailure, ScanRequest, scan_response
from runner.providers import dynamic_runtime_action_providers
from runner.toolkit.compiler.nemo_compiler import NeMoConfigCompiler
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.evaluators.jev import JEV_PROFILE
from runner.toolkit.nemo.registry import NeMoRuntimeRegistry
from runner.toolkit.nemo.runtime import NeMoRuntime
from runner.toolkit.runtime.contracts import EvaluationTrigger, PlanResolution, ProtectionRequest, RequestContext
from runner.toolkit.runtime.service import GuardrailRuntimeService
from tests.control_plane.test_capability_validation import candidate
from tests.control_plane.test_nemo_iorails_topic import _plan, _semantic_input


@pytest.mark.parametrize('on_unknown', ['default', 'allow', 'block', 'invalid'])
@pytest.mark.parametrize('action', ['allow', 'block'])
@pytest.mark.parametrize('mode', ['enforce', 'monitor'])
@pytest.mark.parametrize('result', ['unknown', 'matched', 'not_matched', 'error'])
@pytest.mark.parametrize('profile', ['standard', 'programmable'])
@pytest.mark.parametrize('capability,contract,evaluator', [
    ('jailbreak', 'tali.guard.jailbreak.v1', 'typesafe-jev-jailbreak'),
    ('content_safety', 'tali.guard.content-safety.v1', 'typesafe-jev-content-safety'),
    ('topic_control', 'tali.guard.topic-control.semantic.v1', 'typesafe-jev-topic'),
])
async def test_observation_respects_action_without_relabeling_model_verdict(action, mode, result, profile, on_unknown, capability, contract, evaluator):
    calls = []

    def respond(request):
        body = json.loads(request.content)
        calls.append(body)
        if result == 'error':
            return httpx.Response(503)
        p = {'unknown': 0.5, 'matched': 0.99, 'not_matched': 0.01}[result]
        return httpx.Response(200, json={'model': 'jev-1.13.0', 'answers': {
            key: {'type': 'noul', 'noul': p} for key in body['questions']}})

    config = candidate('input', capability, JEV_PROFILE, contract).configuration
    providers = action_providers(*dynamic_runtime_action_providers(
        config, {'provider-1': 'synthetic'}, transport=httpx.MockTransport(respond)))
    parameters = (("evaluation_view", "original"),)
    if capability == 'topic_control':
        parameters += (("topic_mode", "permissive"), ("restricted_topics", "Synthetic denied task"))
    step = replace(_semantic_input(), id=capability, capability=capability,
                   contract_ref=contract, on_unsafe=action, parameters=parameters + (() if on_unknown == "default" else (("on_unknown", on_unknown),)))
    if profile == 'programmable':
        prerequisite = replace(step, id='prerequisite', on_unsafe='allow')
        step = replace(step, trigger=EvaluationTrigger(type='on_result', step_ref='prerequisite',
            verdicts=('matched', 'not_matched', 'unknown')))
        plan = _plan(prerequisite, step)
    else:
        plan = _plan(step)
    runtime = NeMoRuntime(NeMoRuntimeRegistry(_CandidateStore(plan, NeMoConfigCompiler().compile(plan)), providers))
    resolver = SimpleNamespace(resolve=lambda _: PlanResolution(plan=plan, router_id='test', endpoint_id='test'),
                               protection_mode=lambda _: mode)
    service = GuardrailRuntimeService(runtime, resolver)
    try:
        decision = await service.evaluate(ProtectionRequest(phase='input', texts=('An ordinary test request.',),
            context=RequestContext(protocol='test', endpoint_id='test'), evidence_scope='full'))
        assert len(calls) == (2 if profile == 'programmable' and result != 'error' else 1)
        traces = [s for s in decision.trace if s.evaluator_id == evaluator]
        if result != 'error':
            assert traces and traces[0].verdict == result
        if result == 'unknown':
            assert all(a.status == 'uncertain' for a in decision.assessments)
            assert not any(s.status == 'needs_context' for s in decision.trace)
        if mode == 'monitor':
            assert decision.decision == 'allow' and not decision.interventions
            if result == 'unknown':
                expected = 'allow' if action == 'allow' or on_unknown == 'allow' else 'block'
                assert decision.detection_decision == expected
                assert decision.detection_error is None
        elif result == 'not_matched' or action == 'allow' and result != 'error' or result == 'unknown' and on_unknown == 'allow':
            assert decision.decision == 'allow' and not decision.interventions
            if result == 'matched':
                assert not any(s.kind == 'rail' and s.status == 'blocked' for s in decision.trace)
                assert all(s.route != 'enforce' for s in decision.trace if s.kind in {'rail', 'action'})
                if profile == 'programmable':
                    assert any(s.kind == 'rail' and s.status == 'observed' for s in decision.trace)
        elif result == 'unknown':
            assert decision.decision == 'block'
            assert any(i.kind == 'block' for i in decision.interventions)
            assert not decision.findings  # abstention is not a positive match
        elif result == 'error':
            assert decision.decision == 'block' and decision.usage.fail_closed
        elif action == 'block':
            assert decision.decision == 'block' and decision.findings
        if mode == 'enforce':
            payload = ScanRequest(input='An ordinary test request.', flagOnly=False)
            now = datetime.now(UTC)
            if result == 'error':
                with pytest.raises(ScanFailure):
                    scan_response(payload, decision, '00000000-0000-4000-8000-000000000001', now, now)
            else:
                scan = scan_response(payload, decision, '00000000-0000-4000-8000-000000000001', now, now)
                expected = ('blocked' if decision.decision == 'block' else
                            'flagged' if any(a.status == 'intervene' for a in decision.assessments) else 'cleared')
                assert scan.result.outcome == expected
    finally:
        await runtime.shutdown()


def test_unknown_observation_is_scoped_to_supported_classifiers():
    from runner.toolkit.nemo.runtime import _runtime_action
    for capability in ["pii", "secrets", "contextual_grounding"]:
        item = SimpleNamespace(binding=SimpleNamespace(on_unsafe="block", capability=capability, parameter=lambda _: "allow"),
                               result=SimpleNamespace(verdict="unknown"))
        assert _runtime_action(item) == "block"
