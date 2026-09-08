"""Exact offline replay of the tali acceptance round, including the recorded outage."""
import json
from pathlib import Path
import httpx
import pytest
from scripts.model_response_gateway import ReplayFixtures, create_app

@pytest.mark.asyncio
@pytest.mark.parametrize('name,count,first_status', [
    ('20260908-tali-acceptance.json', 32, 502),
    ('20260908-tali-expanded.json', 67, 200),
])
async def test_tali_recordings_replay_without_network_or_live_fallback(name, count, first_status):
    fixture=Path(__file__).resolve().parents[1]/'fixtures/model_responses'/name
    rows=json.loads(fixture.read_text())['cases']
    assert len(rows)==count
    assert rows[0]['status']==first_status
    assert all(r['status']==200 for r in rows[1:])
    recorder=ReplayFixtures(fixture)
    app=create_app(recorder,transport=httpx.MockTransport(lambda _:pytest.fail('Live network forbidden')))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://offline') as client:
        for row in rows:
            response=await client.post('/'+row['route'],json=row['request'])
            assert response.status_code==row['status']
            assert response.json()==row['response']
        assert (await client.post('/'+rows[-1]['route'],json=rows[-1]['request'])).status_code==409
    with pytest.raises(ValueError,match='cannot call a live'):
        create_app(recorder,live=True)
