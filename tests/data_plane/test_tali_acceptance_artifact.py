"""Offline contract for the signed Input/Output acceptance artifact, not model quality."""
import json
from pathlib import Path
import httpx
import pytest
from fastapi import FastAPI
from runner import generated as protocol
from runner.api import RunnerAPI
from runner.metrics import RunnerMetrics
from runner.providers import dynamic_runtime_action_providers
from runner.toolkit.runtime.context import CallContextStore
from runner.toolkit.runtime.service import GuardrailRuntimeService
from tests.data_plane.test_artifact_execution import _runtime, Telemetry, RUNTIME_CREDENTIAL

@pytest.mark.asyncio
@pytest.mark.parametrize('phase', ['request', 'response'])
@pytest.mark.parametrize('unsafe', [False, True])
async def test_frozen_acceptance_artifact_checks_both_directions(tmp_path, phase, unsafe):
    calls=[]
    def classify(request):
        calls.append(json.loads(request.content))
        label='unsafe' if unsafe else 'safe'
        content={'User Safety':label,'Response Safety':label,'Safety Categories':'Violence' if unsafe else ''}
        return httpx.Response(200,json={'choices':[{'message':{'content':json.dumps(content)}}]})
    config=protocol.DataPlaneModelConfiguration(runtimes=[protocol.ModelRuntime(id='safety',
        model='nvidia/llama-3.1-nemotron-safety-guard-8b-v3',profile_ref='tali.nemotron-safety-guard-v3.v1',
        base_url='http://offline.invalid/v1',credential_ref='fixture',timeout_seconds=2,max_tokens=256)],
        bindings=[protocol.CapabilityBinding(binding_id='content_safety.'+name,capability_ref='content_safety',
            rail_type=rail,implementation_ref='tali.runtime.safety-model.v1',model_ref='safety',
            profile_ref='tali.nemotron-safety-guard-v3.v1',contract_refs=['tali.guard.content-safety.v1'])
            for name,rail in [('input',protocol.RAIL_TYPE_INPUT),('output',protocol.RAIL_TYPE_OUTPUT)]])
    providers=dynamic_runtime_action_providers(config,{'fixture':'synthetic'},transport=httpx.MockTransport(classify))
    fixture=Path(__file__).resolve().parents[1]/'fixtures/artifacts/content-safety-inout-v1'
    store,registry,engine=_runtime(tmp_path,fixture,providers=providers)
    telemetry=Telemetry()
    app=FastAPI()
    app.include_router(RunnerAPI(GuardrailRuntimeService(engine,store,contexts=CallContextStore()),
        store,RunnerMetrics(4),telemetry,'test','test').router)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://runner') as client:
            result=await client.post('/runtime/v1/integrations/fixture-integration/beta/litellm_basic_guardrail_api',
                headers={'x-api-key':RUNTIME_CREDENTIAL},json={'input_type':phase,'texts':['Synthetic acceptance text.']})
        assert result.status_code==200
        assert result.json()['action']==('BLOCKED' if unsafe else 'NONE')
        assert len(calls)==1
        assert telemetry.events[-1]['metadata']['usage']['fail_closed'] is False
        assert telemetry.events[-1]['metadata']['usage']['model_invocations']==1
    finally:
        await engine.shutdown()
