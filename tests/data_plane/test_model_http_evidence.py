import base64
import json
from dataclasses import replace

import httpx
import pytest
from fastapi import FastAPI

from runner.api import RunnerAPI
from runner.model_http_evidence import capture_model_http_evidence, failed_model_http_evidence
from runner.model_validation_diagnostics import validation_http_hooks
from runner.toolkit.nemo.actions.model_call import observe_model_call
from runner.toolkit.runtime.failures import ModelResponseError
from runner.toolkit.runtime.contracts import RuntimeUsage
from tests.classifier_cases import jailbreak_request
from tests.test_runner_api import Runtime, Store, Metrics, Telemetry
from tests.data_plane.test_runtime_log_capture import KEY, decode


def content(record):
    return base64.b64decode(record['bodyBase64'])


@pytest.mark.parametrize('status,body', [(429, b'quota exceeded'), (200, b'not valid JSON')])
async def test_full_exchange_and_all_response_headers_are_preserved_without_plaintext_telemetry(status, body):
    text = b'private input' * 4000
    response_body = body + b'\xff' + b'x' * 40000
    def response(request):
        return httpx.Response(status, content=response_body, headers=[('x-ratelimit-remaining', '0'), ('x-debug', 'one'), ('x-debug', 'two'), ('set-cookie', 'private-cookie')])
    with capture_model_http_evidence():
        with pytest.raises(Exception):
            with observe_model_call(jailbreak_request(), provider='provider', model='judge', operation='classify') as call:
                async with httpx.AsyncClient(transport=httpx.MockTransport(response), event_hooks=validation_http_hooks()) as client:
                    result = await client.post('https://model.test/v1/chat/completions', content=text, headers={'authorization': 'Bearer private-key'})
                    result.raise_for_status()
                    raise ModelResponseError('json_decode', 'JSONDecodeError')
        evidence = failed_model_http_evidence()
        assert len(evidence) == 1 and evidence[0]['modelCallId'] == call.call_id
        assert content(evidence[0]['request']) == text
        assert content(evidence[0]['response']) == response_body
        assert ['x-ratelimit-remaining', '0'] in evidence[0]['response']['headers']
        assert [v for k,v in evidence[0]['response']['headers'] if k=='x-debug'] == ['one','two']
        assert 'private-key' not in json.dumps(evidence) and 'private-cookie' not in json.dumps(evidence)
        runtime = RunnerAPI(Runtime(), Store('info'), Metrics(), Telemetry(), 'runner', 'internal', KEY)
        decision = replace(await Runtime().evaluate(None), usage=RuntimeUsage(model_calls=(call.usage,)), execution_status='error')
        await runtime._emit_telemetry(request_id='e', call_id='c', endpoint_id='endpoint-1', phase='input', protocol='litellm', mode='enforce', started=0, decision=decision)
        event = runtime._telemetry.events[0]
        assert event['metadata']['runtimeLogCaptured'] is True
        assert event['metadata']['modelEvidenceStatus'] == 'captured'
        assert 'private input' not in json.dumps(event) and 'modelExchanges' not in event['metadata']
        assert decode(event)['modelExchanges'] == evidence
        assert decode(event)['contentBefore'] == []


async def test_recovered_attempt_is_kept_and_healthy_final_response_is_discarded():
    with capture_model_http_evidence():
        with observe_model_call(jailbreak_request(), provider='p', model='m', operation='classify') as call:
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(503 if req.url.path=='/failed' else 200, text='response')), event_hooks=validation_http_hooks()) as client:
                await client.get('https://model.test/failed')
                await client.get('https://model.test/ok')
            call.complete(payload={})
        evidence = failed_model_http_evidence()
        assert len(evidence) == 1 and evidence[0]['response']['status'] == 503
        assert evidence[0]['result'] == 'recovered_failure'
    with capture_model_http_evidence():
        assert failed_model_http_evidence() == []


async def test_network_failure_has_no_fabricated_response():
    def fail(request): raise httpx.ConnectError('private-key', request=request)
    with capture_model_http_evidence():
        with pytest.raises(httpx.ConnectError):
            with observe_model_call(jailbreak_request(), provider='p', model='m', operation='classify'):
                async with httpx.AsyncClient(transport=httpx.MockTransport(fail), event_hooks=validation_http_hooks()) as client:
                    await client.get('https://user:password@model.test/path?api_key=secret', headers={'authorization':'Bearer private-key'})
        evidence = failed_model_http_evidence()[0]
        assert evidence['response'] is None
        assert all(secret not in json.dumps(evidence) for secret in ('password', 'private-key', 'secret'))


async def test_validation_retains_success_and_retry_payloads_with_redaction():
    with capture_model_http_evidence(include_success=True):
        with observe_model_call(jailbreak_request(), provider='laya', model='auto', operation='classify') as call:
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(422 if req.url.path == '/retry' else 200, json={'unsafe_content': 0.95})), event_hooks=validation_http_hooks()) as client:
                await client.post('https://model.test/retry', json={'text': 'sample', 'head_max_len': 512}, headers={'authorization': 'Bearer private-key'})
                await client.post('https://model.test/ok', json={'text': 'sample'}, headers={'authorization': 'Bearer private-key'})
            call.complete(payload={})
        evidence = failed_model_http_evidence()
        assert [item['response']['status'] for item in evidence] == [422, 200]
        assert [item['result'] for item in evidence] == ['recovered_failure', 'success']
        assert json.loads(content(evidence[0]['request']))['head_max_len'] == 512
        assert json.loads(content(evidence[1]['response']))['unsafe_content'] == 0.95
        assert 'private-key' not in json.dumps(evidence)
        assert ['authorization', '[REDACTED]'] in evidence[1]['request']['headers']
    with capture_model_http_evidence():
        with observe_model_call(jailbreak_request(), provider='laya', model='auto', operation='classify') as call:
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json={})), event_hooks=validation_http_hooks()) as client:
                await client.get('https://model.test/ok')
            call.complete(payload={})
        assert failed_model_http_evidence() == []


async def test_router_dependency_captures_failures_at_info_without_sampling():
    class ModelRuntime(Runtime):
        async def evaluate(self, request, **kwargs):
            with pytest.raises(httpx.HTTPStatusError):
                with observe_model_call(jailbreak_request(), provider='p', model='m', operation='classify') as call:
                    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(401, text='unauthorized')), event_hooks=validation_http_hooks()) as client:
                        (await client.post('https://model.test/chat', json={'prompt':'private input'}, headers={'authorization':'Bearer private-key'})).raise_for_status()
            return replace(await super().evaluate(request), usage=RuntimeUsage(model_calls=(call.usage,)), execution_status='error')
    telemetry = Telemetry()
    api = RunnerAPI(ModelRuntime(), Store('info'), Metrics(), telemetry, 'runner', 'internal', KEY)
    app = FastAPI(); app.include_router(api.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://runner.test') as client:
        response = await client.post('/internal/v1/guardrails/guardrail-1/evaluate', headers={'authorization':'Bearer internal'}, json={'phase':'input','texts':['sample'],'guardrail_version':'20260904-020000.002Z'})
    assert response.status_code == 200
    assert telemetry.events[0]['metadata']['modelEvidenceStatus'] == 'captured'
    assert len(decode(telemetry.events[0])['modelExchanges']) == 1


async def test_capture_unavailable_is_explicit_without_encryption():
    with capture_model_http_evidence(enabled=False):
        with pytest.raises(httpx.ConnectError):
            with observe_model_call(jailbreak_request(), provider='p', model='m', operation='classify') as call:
                raise httpx.ConnectError('cannot connect')
        telemetry = Telemetry()
        api = RunnerAPI(Runtime(), Store('info'), Metrics(), telemetry, 'runner', 'internal', None)
        decision = replace(await Runtime().evaluate(None), usage=RuntimeUsage(model_calls=(call.usage,)), execution_status='error')
        await api._emit_telemetry(request_id='e', call_id='c', endpoint_id='endpoint-1', phase='input', protocol='litellm', mode='enforce', started=0, decision=decision)
    metadata = telemetry.events[0]['metadata']
    assert metadata['modelEvidenceStatus'] == 'encryption_unavailable'
    assert metadata['modelEvidenceCount'] == 0
    assert 'contentCiphertext' not in metadata
