"""Known live-model miss against signed local Default/business presets.

This proves defense for these exact recorded inputs, not general jailbreak
accuracy. No compiler, model binding or live Provider participates.
"""
import json
from pathlib import Path

import httpx
import pytest

from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext
from runner.toolkit.runtime.service import GuardrailRuntimeService
from tests.data_plane.test_artifact_execution import _desired_state, _runtime

FIXTURES = Path(__file__).resolve().parents[1] / 'fixtures'
RECORDINGS = json.loads((FIXTURES / 'model_responses/20260907-nvidia-smoke.json').read_text())['cases']
RELEASES = ['default-local-v1', *[f'preset-{name}-v1' for name in (
    'common-baseline', 'banking-assistant', 'securities-assistant',
    'internet-customer-support', 'singapore-financial-assistant')]]


@pytest.mark.asyncio
@pytest.mark.parametrize('release', RELEASES)
@pytest.mark.parametrize('attack', [False, True], ids=['recorded-benign', 'recorded-model-miss'])
async def test_local_policy_handles_recorded_classifier_input_without_a_model(tmp_path, monkeypatch, release, attack):
    def unexpected_network(*args, **kwargs):
        pytest.fail('Local baseline attempted an HTTP call')
    monkeypatch.setattr(httpx.AsyncClient, 'send', unexpected_network)
    monkeypatch.setattr(httpx.Client, 'send', unexpected_network)
    case = next(case for case in RECORDINGS if case['id'] == (23 if attack else 22))
    assert case['response']['jailbreak'] is False
    fixture = FIXTURES / 'artifacts' / release
    desired = _desired_state(fixture)
    assert not desired.model_configuration.runtimes
    assert not desired.model_configuration.bindings
    store, registry, engine = _runtime(tmp_path, fixture)
    runtime = GuardrailRuntimeService(engine, store)
    context = RequestContext(protocol='litellm', endpoint_id='fixture-endpoint')
    try:
        result = await runtime.evaluate(ProtectionRequest(phase='input', texts=(case['request']['input'],),
            call_id='observed-classifier-miss', context=context))
        assert result.decision == ('block' if attack else 'allow'), result.reason
        assert result.usage is not None
        assert result.usage.model_invocations == 0
        assert result.usage.fail_closed is False
        assert result.effective_release_id
        assert registry.readiness()['ready']
        if attack:
            findings = [finding for finding in result.findings if finding.verdict == 'unsafe']
            assert findings, 'An infrastructure block is not a detected attack'
            policies = {binding.policy_id for binding in store.resolve(context).plan.policy_bindings}
            assert all(finding.policy_id in policies and finding.rule_id for finding in findings)
        else:
            assert not result.texts or result.texts == (case['request']['input'],)
    finally:
        await engine.shutdown()
