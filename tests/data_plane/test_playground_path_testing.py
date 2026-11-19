from dataclasses import replace
import json
from threading import RLock
from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi import Response
import httpx
import pytest

from runner.artifact_store import ArtifactStore
from runner.path_testing import register_path_testing
from runner.routing import RoutingError, select
from runner.toolkit.runtime.contracts import ProtectionDecision, RequestContext
from tests.data_plane.test_composed_routing import router, artifacts


def store():
    result = object.__new__(ArtifactStore)
    result._lock = RLock()
    result._router_revisions = {'router': router()}
    result._endpoints = {'endpoint': {'_router_id': 'router'}}
    result._artifacts = artifacts()
    result._generation = 4
    return result


def test_preview_uses_the_same_runtime_assignment_and_fallback():
    s = store()
    c = RequestContext(protocol='litellm', endpoint_id='endpoint', call_id='call', business_request=(('x-channel', 'partner'),))
    result = s.preview_router('router', 1, c)
    target, _ = select(router(), c)
    assert result['assignment']['targetId'] == target.target_id
    assert [r['state'] for r in result['rules']] == ['selected', 'not_evaluated', 'not_evaluated']
    assert result['rules'][0]['children'][0]['matched'] is True
    fallback = s.preview_router('router', 1, replace(c, business_request=(('x-channel', 'other'),)))
    assert fallback['assignment']['routeId'] == 'fallback'
    with pytest.raises(RoutingError):
        s.preview_router('router', 2, c)
    with pytest.raises(RoutingError):
        s.preview_router('router', 1, replace(c, endpoint_id='other'))


@pytest.mark.asyncio
async def test_internal_probe_requires_auth_and_does_not_execute_for_simulation():
    runtime = SimpleNamespace(evaluate=AsyncMock())
    from tests.test_runner_api import Metrics
    api = SimpleNamespace(router=FastAPI(), _metrics=Metrics(), _emit_telemetry=AsyncMock(), _runtime=runtime, _store=store(), _runner_id='runner-1', _controller_http_token='secret')
    register_path_testing(api)
    body = dict(revision=1, endpoint_id='endpoint', action='simulate', call_id='call', fields={}, business_request={'x-channel': ['partner']}, text='hello')
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api.router), base_url='http://runner') as client:
        denied = await client.post('/internal/v1/playground/routers/router/test', json=body)
        assert denied.status_code == 401
        response = await client.post('/internal/v1/playground/routers/router/test', json=body, headers={'authorization': 'Bearer secret'})
        assert response.status_code == 200
        assert response.json()['runnerId'] == 'runner-1'
        assert response.json()['assignment']['routeId'] == 'first'
        runtime.evaluate.assert_not_called()
        runtime.evaluate.return_value = ProtectionDecision(decision='block', action='block', route_assignment=response.json()['assignment'])
        executed = await client.post('/internal/v1/playground/routers/router/test', json={**body, 'action': 'execute'}, headers={'authorization': 'Bearer secret'})
        assert executed.status_code == 200
        assert executed.json()['decision']['decision'] == 'block'
        assert runtime.evaluate.call_args.args[0].texts == ('hello',)
        verify = runtime.evaluate.call_args.kwargs['on_resolved']
        with pytest.raises(RoutingError):
            verify(SimpleNamespace(router_id='router', route_assignment={'routerRevision': 2}))


@pytest.mark.asyncio
async def test_internal_routing_capability_is_not_exposed_in_user_responses():
    from runner.api import RunnerAPI
    from tests.test_runner_api import Metrics

    secret = 'private-allocation-capability'
    s = store()
    original_preview = s.preview_router

    def preview(*args):
        result = original_preview(*args)
        result['assignment']['internalCapability'] = secret
        return result

    s.preview_router = preview
    runtime = SimpleNamespace(evaluate=AsyncMock(return_value=ProtectionDecision(
        decision='allow', action='allow', route_assignment={'routeId': 'first', 'internalCapability': secret},
    )))
    api = SimpleNamespace(router=FastAPI(), _metrics=Metrics(), _emit_telemetry=AsyncMock(), _runtime=runtime,
                          _store=s, _runner_id='runner-1', _controller_http_token='secret')
    register_path_testing(api)
    body = dict(revision=1, endpoint_id='endpoint', action='execute', call_id='call', fields={},
                business_request={'x-channel': ['partner']}, text='hello')
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api.router), base_url='http://runner') as client:
        result = await client.post('/internal/v1/playground/routers/router/test', json=body,
                                   headers={'authorization': 'Bearer secret'})
        def reject(*args):
            raise RoutingError('no_match', {'routeId': 'first', 'internalCapability': secret})
        s.preview_router = reject
        rejected = await client.post('/internal/v1/playground/routers/router/test', json=body,
                                     headers={'authorization': 'Bearer secret'})
    assert result.status_code == 200
    assert secret not in result.text
    assert result.json()['assignment']['routeId'] == 'first'
    assert result.json()['decision']['route_assignment']['routeId'] == 'first'
    assert rejected.status_code == 409
    assert secret not in rejected.text
    assert rejected.json()['detail']['assignment'] == {'routeId': 'first'}

    runner = object.__new__(RunnerAPI)
    runner._runner_id = 'runner-1'
    response = Response()
    runner._path_response_headers(response, ProtectionDecision(
        decision='allow', action='allow', route_assignment={'routeId': 'first', 'internalCapability': secret},
    ))
    assert secret not in response.headers['x-guard-route-assignment']
    assert 'first' in response.headers['x-guard-route-assignment']

@pytest.mark.asyncio
async def test_router_execution_runs_signed_artifact_in_real_nemo_runtime(tmp_path):
    from runner.api import RunnerAPI
    from runner.metrics import RunnerMetrics
    from runner.toolkit.runtime.service import GuardrailRuntimeService
    from tests.data_plane.test_artifact_execution import RUNTIME_CREDENTIAL, Telemetry, _desired_state, _runtime
    s, _, engine = _runtime(tmp_path)
    desired = _desired_state()
    artifact = desired.artifacts[0]
    r = router()
    del r.routes[:2]
    target = r.routes[0].targets[0]
    target.guardrail_id, target.guardrail_version, target.artifact_id = artifact.guardrail_id, artifact.guardrail_version, artifact.artifact_id
    desired.router_revisions.append(r)
    desired.endpoints[0].router_id = r.router_id
    desired.endpoints[0].adapter = 'litellm-generic-guardrail'
    desired.endpoints[0].telemetry_context_id = 'fixture-telemetry-context'
    desired.generation += 1
    s.apply(desired)
    telemetry = Telemetry()
    app = FastAPI()
    app.include_router(RunnerAPI(GuardrailRuntimeService(engine, s), s, RunnerMetrics(4), telemetry, 'real-runner', 'secret').router)
    endpoint_id = desired.endpoints[0].endpoint_id
    body = dict(revision=1, endpoint_id=endpoint_id, action='execute', call_id='real-call', fields={}, business_request={}, text='Hello')
    probe_path = '/internal/v1/playground/routers/router/test'
    probe_headers = {'authorization': 'Bearer secret'}
    endpoint_path = f'/runtime/v1/endpoints/{endpoint_id}/beta/litellm_basic_guardrail_api'
    endpoint_headers = {'x-api-key': RUNTIME_CREDENTIAL}
    endpoint_body = {'litellm_call_id': body['call_id'], 'texts': ['Hello']}
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://runner') as client:
            result = await client.post(probe_path, json=body, headers=probe_headers)
            assert result.status_code == 200, result.text
            data = result.json()
            assert data['simulation'] is False
            assert data['decision']['guardrail_id'] == artifact.guardrail_id
            assert data['decision']['usage']['runtime_engine'] == 'llmrails'
            assert data['assignment']['guardrailVersion'] == artifact.guardrail_version
            live_input = await client.post(endpoint_path, headers=endpoint_headers,
                                           json={**endpoint_body, 'input_type': 'request'})
            live_output = await client.post(endpoint_path, headers=endpoint_headers,
                                            json={**endpoint_body, 'input_type': 'response'})
            repeat_probe = await client.post(probe_path, json=body, headers=probe_headers)

        assert live_input.status_code == live_output.status_code == repeat_probe.status_code == 200
        live_assignment = json.loads(live_input.headers['x-guard-route-assignment'])
        assert json.loads(live_output.headers['x-guard-route-assignment']) == live_assignment
        assert repeat_probe.json()['assignment'] == data['assignment']
        assert data['assignment']['decisionId'] != live_assignment['decisionId']
        assert data['assignment']['targetId'] == live_assignment['targetId']

        live_events = [event for event in telemetry.routing_events if event['decisionId'] == live_assignment['decisionId']]
        assert {event['eventType'] for event in live_events} == {'route_assignment', 'completion'}
        assert all(event['allocationContextId'] == 'fixture-telemetry-context' for event in live_events)
        assert {event['callId'] for event in telemetry.routing_events} == {f'{endpoint_id}:real-call'}
    finally:
        await engine.shutdown()
