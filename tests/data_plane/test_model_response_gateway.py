import httpx
import pytest

from scripts.model_response_gateway import Recorder, create_app


@pytest.mark.asyncio
async def test_record_budget_survives_restart_and_replay_never_calls_upstream(tmp_path):
    path = tmp_path / "recordings.sqlite"
    calls = []
    def upstream(request):
        calls.append(request)
        return httpx.Response(200, json={"choices": [{"message": {"content": "safe"}}], "debug": "secret-test-only"})
    recorder = Recorder(path, 1)
    payload = {"model": "deepseek-v4-flash", "messages": [{"role": "user", "content": "Synthetic hello"}]}
    route = "/deepseek/v1/chat/completions"
    app = create_app(recorder, live=True, credentials={"deepseek": "secret-test-only"}, transport=httpx.MockTransport(upstream))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        recorded = await client.post(route, json=payload)
        assert recorded.status_code == 200
        assert (await client.post(route, json=payload)).status_code == 429
    assert len(calls) == 1
    assert "secret-test-only" not in path.read_bytes().decode(errors="replace")
    restarted = Recorder(path, 1)
    assert restarted.reserve(route, payload) is None
    offline = create_app(restarted, transport=httpx.MockTransport(lambda _: pytest.fail("Offline replay cannot make requests")))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=offline), base_url="http://test") as client:
        replayed = await client.post(route, json=payload)
        assert replayed.json() == recorded.json()
        assert (await client.post(route, json=payload)).status_code == 409
        assert (await client.post(route, json={**payload, "temperature": 1})).status_code == 409
    with pytest.raises(ValueError, match="budget"):
        Recorder(path, 2)


@pytest.mark.asyncio
async def test_invalid_routes_and_models_do_not_spend_budget(tmp_path):
    recorder = Recorder(tmp_path / "recordings.sqlite", 2)
    app = create_app(recorder, live=True, credentials={"nvidia": "fake"},
        transport=httpx.MockTransport(lambda _: pytest.fail("Invalid request sent")))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/unapproved", json={})).status_code == 404
        assert (await client.post("/nvidia/v1/chat/completions", json={"model": "other"})).status_code == 400
        assert (await client.post("/nvidia/v1/chat/completions", json={"stream": True})).status_code == 400
    assert recorder.rows() == []


@pytest.mark.asyncio
async def test_failed_calls_consume_budget_and_are_replayed_as_failures(tmp_path):
    recorder = Recorder(tmp_path / "recordings.sqlite", 1)
    app = create_app(recorder, live=True, credentials={"nvidia": "fake"},
        transport=httpx.MockTransport(lambda _: httpx.Response(500, json={"error": "Synthetic provider outage"})))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post("/nvidia/v1/classify", json={"input": "Synthetic"})).status_code == 500
    assert len(recorder.rows()) == 1
    async with httpx.AsyncClient(transport=httpx.ASGITransport(create_app(recorder)), base_url="http://test") as client:
        assert (await client.post("/nvidia/v1/classify", json={"input": "Synthetic"})).status_code == 500


@pytest.mark.asyncio
async def test_catalog_discovery_is_counted_and_replayable(tmp_path):
    recorder = Recorder(tmp_path / 'catalog.sqlite', 1)
    def upstream(request):
        assert request.method == 'GET'
        return httpx.Response(200, json={'data':[{'id':'deepseek-v4-flash'}]})
    app = create_app(recorder, live=True, credentials={'deepseek':'fake'}, transport=httpx.MockTransport(upstream))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        assert (await client.post('/deepseek/v1/models', json={})).status_code == 405
        result = await client.get('/deepseek/v1/models')
        assert result.status_code == 200
        assert (await client.get('/deepseek/v1/models')).status_code == 429
    assert len(recorder.rows()) == 1
    async with httpx.AsyncClient(transport=httpx.ASGITransport(create_app(recorder)), base_url='http://test') as client:
        assert (await client.get('/deepseek/v1/models')).json() == result.json()
