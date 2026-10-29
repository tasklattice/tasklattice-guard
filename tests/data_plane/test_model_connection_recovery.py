import asyncio
import json
import logging
import socket
import ssl
import time
from dataclasses import replace

import httpcore
import httpx
import pytest

from runner.toolkit.nemo.actions.model_call import (
    begin_cost_collection, classify_model_error, end_cost_collection,
)
from runner.toolkit.nemo.evaluators.safety_model import SafetyModelEvaluator
from runner.toolkit.safety.providers import build_safety_model_provider
from tests.data_plane.test_jailbreak_detect import config
from tests.data_plane.test_jev_jailbreak import evaluator, jailbreak_request


@pytest.fixture(autouse=True)
def fixed_backoff(monkeypatch):
    monkeypatch.setattr('runner.toolkit.nemo.actions.model_retry.random.uniform', lambda *_: 0.1)


@pytest.fixture(autouse=True)
def capture_model_logs(caplog):
    # Network fixtures set Uvicorn's parent logger to ERROR and stop root
    # propagation. Set both capture level and handler for this test's logger.
    logger = logging.getLogger('uvicorn.error.tasklattice.model')
    caplog.set_level(logging.WARNING, logger=logger.name)
    logger.addHandler(caplog.handler)
    try:
        yield
    finally:
        logger.removeHandler(caplog.handler)


def service(kind, handler, timeout=20):
    if kind == 'jev':
        return evaluator(handler, timeout_seconds=timeout)
    provider = build_safety_model_provider(replace(config(), timeout_seconds=timeout),
                                          transport=httpx.MockTransport(handler))
    return SafetyModelEvaluator((provider,))


def answer(request, matched=False):
    body = json.loads(request.content)
    if 'questions' in body:
        return httpx.Response(200, json={'model': 'jev-1.13.0', 'answers': {
            key: {'type': 'noul', 'noul': 0.95 if matched else 0.05} for key in body['questions']}})
    return httpx.Response(200, json={'jailbreak': matched, 'score': 0.95 if matched else -0.95})


def connect_error(cause=None):
    error = httpx.ConnectError('SECRET request text or credential must never enter logs')
    error.__cause__ = cause or httpcore.ConnectError('SECRET lower-level detail')
    return error


@pytest.mark.parametrize('kind', ['nvidia', 'jev'])
@pytest.mark.parametrize('matched', [False, True])
async def test_transient_connect_recovers_once_without_changing_model_input(kind, matched, caplog):
    calls = []
    def handler(request):
        calls.append(request.content)
        if len(calls) == 1:
            raise connect_error()
        return answer(request, matched)
    result = await service(kind, handler).evaluate(jailbreak_request())
    assert result.verdict == ('matched' if matched else 'not_matched')
    assert len(calls) == 2 and calls[0] == calls[1]
    assert result.usage.model_invocations == 1
    usage = result.usage.model_calls[0]
    assert usage.result == 'success' and usage.error_type == 'none'
    assert usage.retries == 1 and 90 <= usage.backoff_ms < 300
    assert 'model_connection_failure' in caplog.text and 'SECRET' not in caplog.text


@pytest.mark.parametrize('kind', ['nvidia', 'jev'])
async def test_exhausted_connect_stays_execution_error_with_bounded_attempts(kind, caplog):
    calls = []
    def handler(request):
        calls.append(request)
        raise connect_error()
    result = await service(kind, handler).evaluate(jailbreak_request())
    assert result.verdict == 'error' and not result.findings
    assert len(calls) == 2
    usage = result.usage.model_calls[0]
    assert (usage.result, usage.error_type, usage.retries) == ('transport_error', 'ConnectError', 1)
    assert 'model_call_failed' in caplog.text and 'SECRET' not in caplog.text


@pytest.mark.parametrize('kind', ['nvidia', 'jev'])
@pytest.mark.parametrize('failure', ['401', '403', '503', 'malformed', 'read', 'certificate', 'dns'])
async def test_does_not_repeat_billable_or_permanent_failures(kind, failure):
    calls = []
    def handler(request):
        calls.append(request)
        if failure.isdigit():
            return httpx.Response(int(failure))
        if failure == 'malformed':
            return httpx.Response(200, text='invalid json')
        if failure == 'read':
            raise httpx.ReadTimeout('response may already have been billed')
        if failure == 'certificate':
            raise connect_error(ssl.SSLCertVerificationError('bad certificate'))
        raise connect_error(socket.gaierror(socket.EAI_NONAME, 'permanent DNS failure'))
    result = await service(kind, handler).evaluate(jailbreak_request())
    assert result.verdict == 'error' and len(calls) == 1
    assert result.usage.model_calls[0].retries == 0


@pytest.mark.parametrize('kind', ['nvidia', 'jev'])
@pytest.mark.parametrize('attempts', [1, 3])
async def test_rate_limit_exhaustion_is_bounded_and_remains_an_error(kind, attempts, monkeypatch):
    monkeypatch.setattr('runner.toolkit.nemo.actions.model_retry._rate_limit_attempts', attempts)
    calls = []

    def handler(request):
        calls.append(request.content)
        return httpx.Response(429, headers={'Retry-After': '0'})

    result = await service(kind, handler).evaluate(jailbreak_request())
    assert result.verdict == 'error' and not result.findings
    assert len(calls) == attempts and all(body == calls[0] for body in calls)
    usage = result.usage.model_calls[0]
    assert (usage.result, usage.error_type, usage.retries) == (
        'rate_limited', 'http_429', attempts - 1,
    )


@pytest.mark.parametrize('kind', ['nvidia', 'jev'])
async def test_rate_limit_recovery_preserves_request_and_model_verdict(kind, monkeypatch):
    monkeypatch.setattr('runner.toolkit.nemo.actions.model_retry._rate_limit_attempts', 3)
    calls = []

    def handler(request):
        calls.append(request.content)
        if len(calls) == 1:
            return httpx.Response(429, headers={'Retry-After': '0'})
        return answer(request, matched=True)

    result = await service(kind, handler).evaluate(jailbreak_request())
    assert result.verdict == 'matched'
    assert len(calls) == 2 and calls[0] == calls[1]
    usage = result.usage.model_calls[0]
    assert (usage.result, usage.error_type, usage.retries) == ('success', 'none', 1)


@pytest.mark.parametrize('kind', ['nvidia', 'jev'])
async def test_retry_and_response_share_one_total_timeout(kind):
    calls = []
    async def handler(request):
        calls.append(request)
        if len(calls) == 1:
            raise httpx.ConnectTimeout('connect timeout')
        await asyncio.sleep(2)
        return answer(request)
    start = time.monotonic()
    result = await service(kind, handler, timeout=0.3).evaluate(jailbreak_request())
    assert 0.25 <= time.monotonic() - start < 0.8
    assert result.verdict == 'error' and len(calls) == 2
    usage = result.usage.model_calls[0]
    assert usage.result == 'timeout' and usage.retries == 1


@pytest.mark.parametrize('kind', ['nvidia', 'jev'])
async def test_deadline_and_cancellation_prevent_extra_traffic(kind):
    started = asyncio.Event()
    calls = []
    def handler(request):
        calls.append(request)
        started.set()
        raise connect_error()
    instance = service(kind, handler)
    result = await instance.evaluate(replace(jailbreak_request(), deadline=time.monotonic()-1))
    assert result.verdict == 'error' and not calls
    observed, token = begin_cost_collection()
    try:
        task = asyncio.create_task(instance.evaluate(jailbreak_request()))
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    finally:
        end_cost_collection(token)
    assert len(calls) == 1 and len(observed) == 1
    assert observed[0].result == 'timeout' and observed[0].retries == 0


def test_classification_preserves_httpx_boundary_and_handles_wrapper_cycles():
    error = connect_error()
    assert classify_model_error(error) == ('transport_error', 'ConnectError')
    wrapped = RuntimeError('NeMo wrapper')
    wrapped.__cause__ = error
    assert classify_model_error(wrapped) == ('transport_error', 'ConnectError')
    timeout = httpx.ConnectTimeout('timeout')
    timeout.__cause__ = httpcore.ConnectTimeout('lower-level timeout')
    assert classify_model_error(timeout) == ('timeout', 'ConnectTimeout')
    error = RuntimeError('cycle')
    error.__cause__ = error
    assert classify_model_error(error) == ('unknown_error', 'RuntimeError')
