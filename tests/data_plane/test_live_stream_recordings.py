"""Replay the exact ordered NVIDIA responses from the real SSE round, offline."""
import json
from pathlib import Path

import httpx
import pytest

from scripts.model_response_gateway import ReplayFixtures, create_app

FIXTURE = Path(__file__).resolve().parents[1] / 'fixtures/model_responses/20260908-live-stream-round2.json'


@pytest.mark.asyncio
async def test_entire_live_sse_detector_recording_replays_without_external_access():
    cases = json.loads(FIXTURE.read_text())['cases']
    assert len(cases) == 29
    assert all(case['route'] == 'nvidia/v1/chat/completions' for case in cases)
    assert all(case['request']['model'] == 'nvidia/llama-3.1-nemotron-safety-guard-8b-v3' for case in cases)
    fixtures = ReplayFixtures(FIXTURE)
    app = create_app(fixtures, transport=httpx.MockTransport(lambda _: pytest.fail('Unexpected real API call')))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://offline') as client:
        for case in cases:
            actual = await client.post('/' + case['route'], json=case['request'])
            assert actual.status_code == case['status'] == 200
            assert actual.json() == case['response']
        assert (await client.post('/' + cases[0]['route'], json=cases[0]['request'])).status_code == 409
        assert (await client.post('/nvidia/v1/chat/completions', json={'model':'not-recorded'})).status_code == 400
        assert (await client.post('/nvidia/v1/chat/completions', json={
            **cases[0]['request'], 'messages':[{'role':'user','content':'Unrecorded synthetic input'}],
        })).status_code == 409
    with pytest.raises(ValueError, match='cannot call a live'):
        create_app(fixtures, live=True)
