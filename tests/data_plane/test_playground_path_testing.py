from dataclasses import replace
from threading import RLock
from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi import FastAPI
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
    c = RequestContext(protocol='http', endpoint_id='endpoint', call_id='call', business_request=(('x-channel', 'partner'),))
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
    api = SimpleNamespace(router=FastAPI(), _metrics=Metrics(), _emit_telemetry=AsyncMock(), _runtime=runtime, _store=store(), _runner_id='runner-1', _controller_token='secret')
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
        runtime.evaluate.return_value = ProtectionDecision(decision='block', action='reject', route_assignment=response.json()['assignment'])
        executed = await client.post('/internal/v1/playground/routers/router/test', json={**body, 'action': 'execute'}, headers={'authorization': 'Bearer secret'})
        assert executed.status_code == 200
        assert executed.json()['decision']['decision'] == 'block'
        assert runtime.evaluate.call_args.args[0].texts == ('hello',)
        verify = runtime.evaluate.call_args.kwargs['on_resolved']
        with pytest.raises(RoutingError):
            verify(SimpleNamespace(router_id='router', route_assignment={'routerRevision': 2}))

@pytest.mark.asyncio
async def test_router_execution_runs_signed_artifact_in_real_nemo_runtime(tmp_path):
    import base64
    from runner import generated as protocol
    from runner.api import RunnerAPI
    from runner.metrics import RunnerMetrics
    from runner.toolkit.runtime.service import GuardrailRuntimeService
    from tests.data_plane.test_artifact_execution import _runtime
    from tests.data_plane.test_composed_routing import FIXTURE
    from tests.test_runner_api import Telemetry
    s, _, engine = _runtime(tmp_path)
    desired = protocol.DesiredState.FromString(base64.b64decode((FIXTURE / 'desired-state.pb.b64').read_text()))
    artifact = desired.artifacts[0]
    r = router()
    del r.routes[:2]
    target = r.routes[0].targets[0]
    target.guardrail_id, target.guardrail_version, target.artifact_id = artifact.guardrail_id, artifact.guardrail_version, artifact.artifact_id
    desired.router_revisions.append(r)
    desired.endpoints[0].router_id = r.router_id
    desired.endpoints[0].adapter = 'generic-http-guard'
    desired.generation += 1
    s.apply(desired)
    app = FastAPI()
    app.include_router(RunnerAPI(GuardrailRuntimeService(engine, s), s, RunnerMetrics(4), Telemetry(), 'real-runner', 'secret').router)
    body = dict(revision=1, endpoint_id=desired.endpoints[0].endpoint_id, action='execute', call_id='real-call', fields={}, business_request={}, text='Hello')
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://runner') as client:
            result = await client.post('/internal/v1/playground/routers/router/test', json=body, headers={'authorization': 'Bearer secret'})
            assert result.status_code == 200, result.text
            data = result.json()
            assert data['simulation'] is False
            assert data['decision']['guardrail_id'] == artifact.guardrail_id
            assert data['decision']['usage']['runtime_engine'] == 'llmrails'
            assert data['assignment']['guardrailVersion'] == artifact.guardrail_version
    finally:
        await engine.shutdown()
