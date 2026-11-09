import base64
import json
from dataclasses import replace

import httpx
import pytest

from runner.model_validation_diagnostics import validation_http_hooks
from runner.toolkit.nemo.actions.model_call import observe_model_call
from runner.toolkit.runtime.failures import ModelResponseError
from tests.classifier_cases import jailbreak_request
from tests.test_runner_api import Runtime


def content(record):
    return base64.b64decode(record['bodyBase64'])


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
