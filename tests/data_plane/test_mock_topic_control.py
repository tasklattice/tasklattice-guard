"""Synthetic Topic endpoint contracts and frozen NeMo IORails TCP execution."""
import asyncio
from pathlib import Path

import httpx
import pytest

from runner.toolkit.nemo.native_models import NativeRailModel
from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext
from runner.toolkit.runtime.service import GuardrailRuntimeService
from scripts.mock_topic_control import MODEL, create_app
from tests.data_plane.test_artifact_execution import _runtime
from tests.data_plane.test_stream_safety_network import tcp_server


def payload(text='How can I reset my product password?', scope='Product support'):
    return {'model':MODEL, 'messages':[{'role':'system','content':scope}, {'role':'user','content':text}]}


@pytest.mark.asyncio
async def test_mock_catalog_scope_and_no_fallback():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(create_app()), base_url='http://mock') as client:
        assert (await client.get('/v1/models')).json()['data'][0]['id'] == MODEL
        for text, scope, expected in [
            ('How can I reset my product password?', 'Product support', 'on-topic'),
            ('Give me a recipe for chocolate cake.', 'Product support', 'off-topic'),
            ('How can I reset my product password?', 'Cooking and recipes only', 'off-topic')]:
            result = await client.post('/v1/chat/completions', json=payload(text,scope))
            assert result.status_code == 200
            assert result.json()['choices'][0]['message']['content'] == expected
            assert result.json()['mock'] is True
        for body in [payload('unknown'), payload(scope='unknown')]:
            assert (await client.post('/v1/chat/completions', json=body)).status_code == 409
        for body in [{}, [], {**payload(), 'stream':True}, {**payload(),'model':'real/model'}, {**payload(),'messages':None}]:
            assert (await client.post('/v1/chat/completions', json=body)).status_code == 400
        assert (await client.post('/v1/chat/completions', content='not json')).status_code == 400
        assert (await client.get('/health')).json()['external_calls'] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize('scenario', ['http-error','invalid-response','timeout'])
async def test_mock_failure_scenarios(scenario):
    async with tcp_server(create_app(scenario=scenario, delay_seconds=0.1)) as url:
        async with httpx.AsyncClient(base_url=url, timeout=0.02 if scenario=='timeout' else 2) as client:
            if scenario=='timeout':
                with pytest.raises(httpx.ReadTimeout):
                    await client.post('/v1/chat/completions', json=payload())
            else:
                result = await client.post('/v1/chat/completions', json=payload())
                if scenario=='http-error': assert result.status_code==500
                else: assert result.json()['choices'][0]['message']['content']=='invalid-topic-verdict'


@pytest.mark.asyncio
@pytest.mark.parametrize('scenario,text,expected', [
    ('normal','How can I reset my product password?','allow'),
    ('normal','Give me a recipe for chocolate cake.','block'),
    ('normal','unknown request','failure'),
    ('http-error','How can I reset my product password?','failure'),
    ('invalid-response','How can I reset my product password?','failure'),
    ('timeout','How can I reset my product password?','failure'),
])
async def test_signed_native_topic_artifact_against_tcp_mock(tmp_path,scenario,text,expected):
    async with tcp_server(create_app(scenario=scenario, delay_seconds=0.1)) as url:
        native = NativeRailModel(type='topic_control', profile_ref='tali.nemoguard-topic-control.v1',
            runtime_id='mock-topic', model=MODEL, base_url=url+'/v1', api_key='synthetic-key',
            timeout_seconds=0.02 if scenario=='timeout' else 1, max_tokens=16)
        fixture = Path(__file__).resolve().parents[1]/'fixtures/artifacts/topic-control-native-v1'
        store,registry,engine = _runtime(tmp_path,fixture,native_models=(native,))
        try:
            result = await asyncio.wait_for(GuardrailRuntimeService(engine,store).evaluate(ProtectionRequest(
                phase='input',texts=(text,),call_id='topic-mock',
                context=RequestContext(protocol='litellm',integration_id='fixture-integration'))), 8)
            assert registry.readiness()['ready']
            assert result.effective_release_id
            assert result.usage and result.usage.model_invocations >= 1
            if expected=='failure':
                assert result.decision=='block'
                assert result.usage.fail_closed is True
            else:
                assert result.decision==expected, result.reason
                assert result.usage.fail_closed is False
                if expected=='block': assert any(f.verdict=='unsafe' for f in result.findings)
        finally:
            await engine.shutdown()
