"""Local integration: real adapter normalization -> selector -> artifact resolution.

Only policy execution is replaced by a recorder: these tests require no model,
Controller, Redis or network. Router matching and target selection are real.
"""
from __future__ import annotations

import base64
from collections import Counter
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from starlette.requests import Request

from runner import generated as protocol
from runner.api import EvaluateRequest, LiteLLMGuardrailRequest, _http_protection_request, _litellm_protection_request
from runner.artifact_store import ArtifactStore
from runner.protocol_codec import plan_from_proto, traffic_scope_to_proto
from runner.routing import RoutingError, validate_router
from runner.serialization import plan_from_dict
from runner.toolkit.runtime.contracts import ProtectionDecision
from runner.toolkit.runtime.service import GuardrailRuntimeService

FIXTURE = Path(__file__).parents[1] / 'fixtures/artifacts/local-secrets-v1'
VERSION = '20260912-120000.000Z'


def condition(field, value, **extra):
    return {'field': field, 'operator': 'equals', 'value': value, **extra}


def http_request(headers=None, path='/evaluate'):
    return Request({'type': 'http', 'method': 'POST', 'scheme': 'https',
                    'server': ('guard.local', 443), 'path': path, 'query_string': b'',
                    'headers': [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]})


def incoming(adapter, *, outer=None, business=None, team=None, call='call', model=None):
    request = http_request(outer)
    if adapter == 'litellm':
        return _litellm_protection_request(LiteLLMGuardrailRequest(
            input_type='request', texts=['hello'], litellm_call_id=call, model=model,
            request_headers=business, request_data={'user_api_key_team_id': team} if team else {}),
            'lite-endpoint', request)
    return _http_protection_request(EvaluateRequest(
        phase='input', texts=['hello'], call_id=call, model=model, business_request=business),
        request, 'http-endpoint')


class RecordingExecution(GuardrailRuntimeService):
    """Record the exact plan entering the policy execution boundary."""
    def __init__(self, store):
        super().__init__(None, store)
        self.executions = []

    async def _evaluate_resolved(self, request, resolution, stored):
        self.executions.append((resolution.plan.guardrail_id, resolution.plan.guardrail_version, request.texts))
        return ProtectionDecision(decision='allow', action='pass',
            guardrail_id=resolution.plan.guardrail_id, guardrail_version=resolution.plan.guardrail_version,
            route_assignment=resolution.route_assignment)


@pytest.fixture
def dispatch(tmp_path):
    state = protocol.DesiredState()
    state.ParseFromString(base64.b64decode((FIXTURE / 'desired-state.pb.b64').read_text()))
    template = plan_from_dict(plan_from_proto(state.artifacts[0].plan))
    store = ArtifactStore(FIXTURE / 'public-key.pem', tmp_path / 'state.pb')
    identities = ['header', 'team', 'http', 'model', 'fallback', 'split-a', 'split-b']
    # Seed a loaded snapshot, bypassing compilation/signature transport only.
    store._artifacts = {g: SimpleNamespace(plan=replace(template, guardrail_id=g, guardrail_version=VERSION)) for g in identities}

    def route(name, conditions, targets=None, combinator='and'):
        return protocol.ComposedRoute(route_id=name, name=name, kind='fallback' if name == 'fallback' else 'normal',
            enabled=True, all_endpoints=True,
            traffic_scope=traffic_scope_to_proto({'combinator': combinator, 'conditions': conditions}),
            targets=[protocol.WeightedTarget(target_id=g, guardrail_id=g, guardrail_version=VERSION,
                         artifact_id=g, weight_bps=weight) for g, weight in (targets or [(name, 10000)])])

    revision = protocol.RouterRevision(router_id='shared-router', revision=1,
        assignment_algorithm='hmac-sha256-v1', assignment_key_id='test', assignment_key=b'k'*32,
        routes=[
            route('header', [condition('http.header', 'partner', key='X-Channel', requestSource='business_request')]),
            route('team', [condition('protocol', 'litellm'), condition('litellm.team_id', 'team-red')]),
            route('http', [condition('http.method', 'POST', requestSource='endpoint_request'),
                           condition('http.path', '/evaluate', requestSource='endpoint_request'),
                           condition('http.header', 'dev', key='X-Environment', requestSource='endpoint_request')]),
            route('model', [condition('model', 'special-model'), condition('endpoint.id', 'special-endpoint')], combinator='or'),
            route('split', [condition('http.header', 'split', key='x-channel', requestSource='business_request')],
                  targets=[('split-a', 7000), ('split-b', 3000)]),
            route('fallback', []),
        ])
    validate_router(revision, store._artifacts)
    store._router_revisions = {'shared-router': revision}
    store._endpoints = {e: {'_router_id': 'shared-router'} for e in ['lite-endpoint', 'http-endpoint']}
    return RecordingExecution(store), store


@pytest.mark.parametrize('adapter,kwargs,expected', [
    ('http', {'business': {'X-Channel': 'partner'}}, 'header'),
    ('litellm', {'business': {'x-channel': 'partner'}}, 'header'),
    ('litellm', {'team': 'team-red'}, 'team'),
    ('litellm', {'business': {'x-channel': 'partner'}, 'team': 'team-red'}, 'header'),  # first match
    ('http', {'outer': {'X-Environment': 'dev'}}, 'http'),
    ('http', {'outer': {'X-Channel': 'partner'}}, 'fallback'),  # outer != business headers
    ('http', {'business': {'X-Environment': 'dev'}}, 'fallback'),
    ('http', {}, 'fallback'),  # no LiteLLM fields and no business source
    ('litellm', {'team': 'team-blue'}, 'fallback'),
    ('http', {'model': 'special-model'}, 'model'),
    ('litellm', {'model': 'special-model'}, 'model'),
])
async def test_adapter_fields_select_the_plan_that_is_executed(dispatch, adapter, kwargs, expected):
    service, _ = dispatch
    decision = await service.evaluate(incoming(adapter, **kwargs))
    assert decision.guardrail_id == expected
    assert decision.guardrail_version == VERSION
    assert decision.route_assignment['routeId'] == expected
    assert decision.route_assignment['endpointId'] == ('lite-endpoint' if adapter == 'litellm' else 'http-endpoint')
    assert service.executions == [(expected, VERSION, ('hello',))]


async def test_weighted_dispatch_executes_exactly_one_target_and_pins_output(dispatch):
    service, _ = dispatch
    counts = Counter()
    for i in range(1000):
        before = len(service.executions)
        request = incoming('litellm', business={'x-channel': 'split'}, call=f'weighted-{i}')
        decision = await service.evaluate(request)
        assert len(service.executions) == before + 1
        assert decision.route_assignment['routeId'] == 'split'
        assert service.executions[-1][:2] == (decision.guardrail_id, VERSION)
        counts[decision.guardrail_id] += 1
    assert set(counts) == {'split-a', 'split-b'}
    assert 640 <= counts['split-a'] <= 760  # weighted hashing, not an exact per-batch quota
    output = replace(request, phase='output', context=replace(request.context, business_request=None))
    repeated = await service.evaluate(output)
    assert repeated.route_assignment == decision.route_assignment
    assert service.executions[-1][:2] == (decision.guardrail_id, VERSION)
    print(f'1000 LiteLLM calls: {dict(counts)}; one GuardRail per call, input/output pinned')


async def test_missing_selected_artifact_does_not_execute_fallback(dispatch):
    service, store = dispatch
    del store._artifacts['header']
    with pytest.raises(RoutingError, match='target_unavailable'):
        await service.evaluate(incoming('http', business={'x-channel': 'partner'}))
    assert service.executions == []
