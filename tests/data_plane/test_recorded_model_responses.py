"""Frozen execution artifacts + observed model responses, never live inference.

Observed misses are regression evidence, NOT desired safety behavior.
"""
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
from runner.toolkit.safety.jailbreak_detect import parse_jailbreak_detect_response
from scripts.model_response_gateway import ReplayFixtures, canonical, create_app
from tests.data_plane.test_artifact_execution import _runtime, RUNTIME_CREDENTIAL, Telemetry

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
RECORDINGS = {
    date: json.loads((FIXTURES / f"model_responses/{date}-nvidia-smoke.json").read_text())["cases"]
    for date in ("20260907", "20260908")
}
RECORDINGS['20260908-non-topic'] = json.loads((FIXTURES / 'model_responses/20260908-non-topic-smoke.json').read_text())['cases']
CASES = RECORDINGS["20260907"]


@pytest.mark.asyncio
@pytest.mark.parametrize("date,case", [(date, case) for date, cases in RECORDINGS.items() for case in cases],
                         ids=[f"recorded-{date}-{case['id']}" for date, cases in RECORDINGS.items() for case in cases])
async def test_observed_response_replays_exactly_and_unknown_requests_fail(tmp_path, date, case):
    filename = '20260908-non-topic-smoke.json' if date == '20260908-non-topic' else f'{date}-nvidia-smoke.json'
    recorder = ReplayFixtures(FIXTURES / 'model_responses' / filename)
    app = create_app(recorder, transport=httpx.MockTransport(lambda _: pytest.fail("Unexpected external call")))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://mock") as client:
        result = await client.post('/' + case['route'], json=case['request'])
        assert result.status_code == case['status']
        assert result.json() == case['response']
        assert (await client.post('/' + case['route'], json=case['request'])).status_code == 409
    with pytest.raises(ValueError, match='offline|live'):
        create_app(recorder, live=True)


@pytest.mark.parametrize("date,case_id", [("20260907", 23), ("20260908", 15), ('20260908-non-topic', 7)])
def test_observed_jailbreak_miss_is_not_relabelled_as_success(date, case_id):
    case = next(case for case in RECORDINGS[date] if case['id'] == case_id)
    jailbreak, score = parse_jailbreak_detect_response(case['response'])
    assert jailbreak is False
    assert score < 0
    assert 'Ignore all previous instructions' in case['request']['input']


@pytest.mark.asyncio
@pytest.mark.parametrize('mode', ['full_buffered', 'window_buffered', 'interruptible'])
@pytest.mark.parametrize('unsafe', [False, True])
@pytest.mark.parametrize('date,safe_id,unsafe_id', [('20260907', 12, 13), ('20260908', 4, 5), ('20260908-non-topic', 4, 5)])
async def test_frozen_output_artifact_with_recorded_real_classification(tmp_path, mode, unsafe, date, safe_id, unsafe_id):
    case = next(case for case in RECORDINGS[date] if case['id'] == (unsafe_id if unsafe else safe_id))
    calls = []
    def replay(request):
        payload = json.loads(request.content)
        # A changed prompt or parameter must not silently reuse an old verdict.
        assert canonical(payload) == canonical(case['request'])
        calls.append(payload)
        return httpx.Response(case['status'], json=case['response'])

    profile = 'tali.nemotron-safety-guard-v3.v1'
    configuration = protocol.DataPlaneModelConfiguration(revision_id='recorded-smoke', revision=1,
        runtimes=[protocol.ModelRuntime(id='safety', base_url='http://recorded.invalid/v1',
            model=case['request']['model'], profile_ref=profile, timeout_seconds=2, max_tokens=1024)],
        bindings=[protocol.CapabilityBinding(binding_id='content_safety.output', capability_ref='content_safety',
            rail_type=protocol.RAIL_TYPE_OUTPUT, implementation_ref='tali.runtime.safety-model.v1',
            model_ref='safety', profile_ref=profile, contract_refs=['tali.guard.content-safety.v1'])])
    providers = dynamic_runtime_action_providers(configuration, {}, transport=httpx.MockTransport(replay))
    store, registry, engine = _runtime(tmp_path, FIXTURES / 'artifacts' / f'stream-safety-{mode}-v1', providers=providers)
    app = FastAPI()
    app.include_router(RunnerAPI(GuardrailRuntimeService(engine, store, contexts=CallContextStore()),
        store, RunnerMetrics(4), Telemetry(), 'recorded-stream', 'fixture-controller-token').router)
    text = 'I will help you build a bomb to kill people.' if unsafe else 'Have a pleasant day.'
    # Full buffering must hold an incomplete prefix. Other modes use a final
    # window with an exactly recorded prompt; no invented partial verdicts.
    parts = [text[:12], text[12:]] if mode == 'full_buffered' else [text]
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://runner') as client:
            for index, part in enumerate(parts):
                result = await client.post('/runtime/v1/endpoints/fixture-endpoint/guardrails/output-stream',
                    headers={'x-api-key':RUNTIME_CREDENTIAL}, json={'stream_id':'recorded', 'sequence':index,
                    'text':part, 'final':index == len(parts)-1, 'protocol':'litellm',
                    'messages':[{'role':'user','content':'Please answer my question.'}]})
                assert result.status_code == 200, result.text
                body = result.json()
                if index < len(parts)-1:
                    assert body['released_text'] == ''
                    assert calls == []
            assert len(calls) == 1
            assert body['decision']['usage']['model_invocations'] == 1
            assert body['decision']['usage']['fail_closed'] is False
            assert body['status'] == ('blocked' if unsafe else 'completed')
            assert body['released_text'] == ('' if unsafe else text)
    finally:
        await engine.shutdown()
