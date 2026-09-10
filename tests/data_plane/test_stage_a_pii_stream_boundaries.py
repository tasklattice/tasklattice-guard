"""A/ST02: fixed expected PII output across every character cut and UTF-8 HTTP chunks.

Signed fixtures, actual TCP Runner endpoint and local NeMo actions. No compiler,
model backend or Controller writes. This is transport correctness, not PII recall.
"""
import asyncio
import json
from pathlib import Path

from fastapi import FastAPI
import httpx
import pytest

from runner.api import RunnerAPI
from runner.metrics import RunnerMetrics
from runner.toolkit.runtime.service import GuardrailRuntimeService
from tests.data_plane.test_artifact_execution import _runtime, RUNTIME_CREDENTIAL, Telemetry
from tests.data_plane.test_stream_safety_network import tcp_server

RELEASES = ['default-local-v1', *[f'preset-{p}-v1' for p in (
    'common-baseline', 'banking-assistant', 'securities-assistant',
    'internet-customer-support', 'singapore-financial-assistant')]]
CASES = [
    ('passport', '中文 Passport: E12345678', 'E12345678'),
    ('email', '中文 Email: alice@example.com', 'alice@example.com'),
    ('card', '中文 Card: 4111 1111 1111 1111', '4111 1111 1111 1111'),
]


@pytest.mark.parametrize('release', RELEASES)
@pytest.mark.parametrize('kind,text,sensitive', CASES)
async def test_pii_full_buffering_all_character_and_utf8_boundaries(tmp_path, release, kind, text, sensitive):
    expected = {
        'passport': '中文 Passport: [passport_china_REDACTED]' if release == 'default-local-v1' else '中文 [REDACTED]',
        'email': '中文 Email: [email_REDACTED]',
        'card': '中文 Card: [credit_card_REDACTED]',
    }[kind]
    store, registry, engine = _runtime(tmp_path, Path(__file__).resolve().parents[1]/'fixtures/artifacts'/release)
    app = FastAPI()
    app.include_router(RunnerAPI(GuardrailRuntimeService(engine,store),store,RunnerMetrics(4),
        Telemetry(),'stage-a-boundary','synthetic-controller-key').router)
    endpoint = '/runtime/v1/endpoints/fixture-endpoint/guardrails/output-stream'
    try:
        async with tcp_server(app) as url, httpx.AsyncClient(base_url=url,trust_env=False,timeout=10) as client:
            async def check(parts, label, utf8_cut=0):
                for sequence, part in enumerate(parts):
                    payload = {'stream_id':f'{kind}-{label}', 'sequence':sequence, 'text':part,
                        'final':sequence==len(parts)-1, 'protocol':'litellm'}
                    raw=json.dumps(payload,ensure_ascii=False).encode()
                    async def chunks():
                        if utf8_cut and '中'.encode() in raw:
                            cut=raw.index('中'.encode())+utf8_cut
                            yield raw[:cut]
                            await asyncio.sleep(0)
                            yield raw[cut:]
                        else:
                            yield raw
                    response=await client.post(endpoint,headers={'x-api-key':RUNTIME_CREDENTIAL,
                        'content-type':'application/json'},content=chunks())
                    assert response.status_code==200, (release,kind,label,response.status_code)
                    result=response.json()
                    assert result['mode']=='full_buffered'
                    assert not result['terminate']
                    if sequence<len(parts)-1:
                        assert result['released_text']=='', 'Unchecked prefix leaked'
                    else:
                        assert result['released_text']==expected, (release,kind,label,result['released_text'])
                        assert sensitive not in result['released_text']
                        assert result['decision']['decision']=='transform'
                        assert result['decision']['usage']['model_invocations']==0
                        assert result['decision']['usage']['fail_closed'] is False
                        assert result['effective_release_id']
            # Empty non-final chunks are intentionally invalid at the API.
            await check([text],'unsplit')
            for cut in range(1,len(text)+1):
                await check([text[:cut],text[cut:]],f'char-{cut}')
            # Split a three-byte character at both internal byte boundaries of
            # an actual chunked HTTP JSON request, plus one-character SSE-like
            # text fragments. No decoding/reassembly is done by the test.
            for cut in (1,2):
                await check(list(text),f'utf8-{cut}',utf8_cut=cut)
        assert registry.readiness()['ready']
    finally:
        await engine.shutdown()
