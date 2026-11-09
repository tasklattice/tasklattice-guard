import asyncio
from contextlib import suppress

import httpx
import pytest

from runner.model_concurrency import ModelConcurrencyTransport, configure_model_limit, model_slot
from runner.model_http_evidence import capture_model_http_evidence, failed_model_http_evidence
from runner.model_validation_diagnostics import validation_http_hooks
from runner.toolkit.nemo.actions.model_call import observe_model_call
from tests.classifier_cases import jailbreak_request


async def test_shared_model_limit_across_clients_and_revisions_and_independent_models():
    configure_model_limit('shared-revision-model', 2)
    entered = asyncio.Event()
    release = asyncio.Event()
    active = peak = calls = 0

    async def handler(request):
        nonlocal active, peak, calls
        active += 1
        calls += 1
        peak = max(peak, active)
        if active == 2: entered.set()
        try:
            await release.wait()
            return httpx.Response(200, content=b'ok')
        finally: active -= 1

    # Separate objects emulate old/new registries and independent capabilities.
    async def send(index):
        transport = ModelConcurrencyTransport('shared-revision-model', timeout_seconds=2, transport=httpx.MockTransport(handler))
        async with httpx.AsyncClient(transport=transport) as client:
            return await client.get(f'http://model.test/{index}')
    tasks = [asyncio.create_task(send(i)) for i in range(6)]
    await asyncio.wait_for(entered.wait(), 1)
    assert calls == 2
    tasks[-1].cancel()
    with suppress(asyncio.CancelledError): await tasks[-1]
    # A different registered model has an independent budget.
    async with asyncio.timeout(.2):
        async with model_slot('other-model'):
            pass
    release.set()
    await asyncio.gather(*tasks[:-1])
    assert peak == 2 and calls == 5
    assert (await send('after-cancellation')).status_code == 200


async def test_lowering_concurrency_does_not_admit_new_calls_until_active_calls_drain():
    configure_model_limit('lowered-model', 2)
    first = model_slot('lowered-model')
    second = model_slot('lowered-model')
    await first.__aenter__()
    await second.__aenter__()
    configure_model_limit('lowered-model', 1)
    entered = asyncio.Event()
    async def pending():
        async with model_slot('lowered-model'): entered.set()
    task = asyncio.create_task(pending())
    await asyncio.sleep(0)
    await first.__aexit__(None, None, None)
    await asyncio.sleep(0)
    assert not entered.is_set()
    await second.__aexit__(None, None, None)
    await asyncio.wait_for(task, .5)
    assert entered.is_set()


async def test_queued_timeout_never_dispatches_and_records_queue_evidence():
    configure_model_limit('queued-timeout', 1)
    calls = 0
    async def handler(request):
        nonlocal calls
        calls += 1
        return httpx.Response(200)
    async with model_slot('queued-timeout'):
        with pytest.raises(TimeoutError):
            with observe_model_call(jailbreak_request(), provider='fixture', model='queued-timeout', operation='classify') as call:
                transport = ModelConcurrencyTransport('queued-timeout', timeout_seconds=.02, transport=httpx.MockTransport(handler))
                async with httpx.AsyncClient(transport=transport) as client:
                    await client.get('http://model.test')
        assert calls == 0
        assert call.usage.request_sent is False
        assert call.usage.queue_duration_ms > 0
    # Cancellation and timeout release their waiters and cannot strand a permit.
    async with asyncio.timeout(.2):
        async with model_slot('queued-timeout'): pass


async def test_response_body_failure_preserves_received_headers_and_releases_permit():
    class BrokenBody(httpx.AsyncByteStream):
        async def __aiter__(self):
            raise httpx.ReadTimeout('Response body timed out')
            yield b''

    configure_model_limit('body-timeout', 1)
    transport = ModelConcurrencyTransport('body-timeout', timeout_seconds=1,
        transport=httpx.MockTransport(lambda request: httpx.Response(503, headers={'x-request-id': 'provider-attempt'}, stream=BrokenBody())))
    with capture_model_http_evidence():
        with pytest.raises(httpx.ReadTimeout):
            with observe_model_call(jailbreak_request(), provider='fixture', model='body-timeout', operation='classify'):
                async with httpx.AsyncClient(transport=transport, event_hooks=validation_http_hooks()) as client:
                    await client.get('http://model.test')
        response = failed_model_http_evidence()[0]['response']
        assert response['status'] == 503
        assert ['x-request-id', 'provider-attempt'] in response['headers']
        assert response['bodyComplete'] is False
    async with asyncio.timeout(.2):
        async with model_slot('body-timeout'): pass
