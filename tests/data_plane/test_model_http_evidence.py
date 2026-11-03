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


async def test_capability_validation_full_failure_evidence_survives_protected_report_output(caplog):
    from runner.capability_validation import validate_capability
    from tests.control_plane.test_capability_validation import candidate
    body = b'provider failure ' + b'x' * 70000
    request = candidate('input', 'jailbreak', 'tali.nemoguard-jailbreak-detect.v1', 'tali.guard.jailbreak.v1')
    result = await validate_capability(request, {'provider-1': 'synthetic-secret'}, transport=httpx.MockTransport(
        lambda _: httpx.Response(503, content=body, headers=[('x-provider-debug', 'kept'), ('set-cookie', 'private-cookie')])
    ))
    assert not result.passed
    evidence = json.loads(result.cases[0].output_content)['model_http_evidence'][0]
    assert content(evidence['response']) == body
    assert ['x-provider-debug', 'kept'] in evidence['response']['headers']
    assert 'private-cookie' not in json.dumps(evidence)
    assert 'synthetic-secret' not in json.dumps(evidence)
    assert b'x' * 1000 not in caplog.text.encode()


async def test_formal_validation_uses_full_trace_evidence_channel():
    from runner.validator import DefaultRunnerValidator
    from runner.protocol_codec import validation_case_result_to_proto
    body = b'malformed provider response' + b'x' * 70000
    class FailingModelRuntime(Runtime):
        async def evaluate(self, request, **kwargs):
            with pytest.raises(ModelResponseError):
                with observe_model_call(jailbreak_request(), provider='p', model='m', operation='classify'):
                    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, content=body, headers={'x-debug-id':'formal'})), event_hooks=validation_http_hooks()) as client:
                        await client.post('https://model.test/chat', json={'prompt':'formal input'})
                        raise ModelResponseError('response_schema', 'BadResponse')
            return replace(await super().evaluate(request), execution_status='error')
    validator = object.__new__(DefaultRunnerValidator)
    result = await validator._evaluate(FailingModelRuntime(), jailbreak_request().plan, {'id':'formal-case','name':'provider failure','content':'formal input','expectedDecision':'block'})
    evidence = next(item for item in result['trace'] if item['kind'] == 'model_http_evidence')
    assert content(json.loads(evidence['evidence'])['response']) == body
    wire = validation_case_result_to_proto(result)
    encoded = next(item for item in wire.trace if item.kind == 'model_http_evidence')
    assert encoded.evidence == evidence['evidence']
