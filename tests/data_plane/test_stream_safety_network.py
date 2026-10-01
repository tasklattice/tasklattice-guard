"""Real TCP model and WebSocket: checked delivery, overlap and cancellation."""
import asyncio
import json

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import pytest

from tests.tcp import tcp_server
from tests.stream_client import connection, exchange, released, runner
from tests.data_plane.test_stream_safety_artifact import classification, fragments, safety_providers


@pytest.mark.parametrize("mode", ["interruptible", "window_buffered", "full_buffered"])
@pytest.mark.parametrize("family", ["nvidia", "qwen"])
@pytest.mark.parametrize("scenario", ["safe", "blocked", "failure", "cancel"])
async def test_tcp_checks_before_release_and_cancels_in_flight_work(tmp_path, mode, family, scenario):
    entered, proceed = asyncio.Event(), asyncio.Event()
    calls = []
    app = FastAPI()
    @app.post("/v1/chat/completions")
    async def classify(request: Request):
        payload = await request.json()
        calls.append(payload)
        entered.set()
        await proceed.wait()
        unsafe = "REGRESSION_UNSAFE" in json.dumps(payload["messages"])
        if unsafe and scenario == "failure":
            return JSONResponse({"error": "private backend error"}, status_code=503)
        return classification(family, unsafe)

    async with tcp_server(app) as model_url:
        providers = safety_providers(family, base_url=f"{model_url}/v1")
        async with runner(tmp_path, f"stream-safety-{mode}-v1", providers=providers) as (url, engine, registry, _, store):
            async with connection(url) as (socket, ready):
                events = []
                pending = asyncio.create_task(exchange(socket, fragments(scenario == "safe"), events=events))
                try:
                    await asyncio.wait_for(entered.wait(), 5)
                    assert released(events) == "" and not pending.done()
                    if scenario == "cancel":
                        await socket.close()
                        async with asyncio.timeout(2):
                            while registry.get(store.plan(*store.active_plan_keys()[0])).active_requests:
                                await asyncio.sleep(0.01)
                        assert len(calls) == 1 and released(events) == ""
                    else:
                        proceed.set()
                        await asyncio.wait_for(pending, 10)
                        assert events[-1]["type"] == {"safe": "completed", "blocked": "blocked", "failure": "error"}[scenario]
                        parts = fragments(scenario == "safe")
                        assert released(events) == ("".join(parts) if scenario == "safe" else
                            "" if mode == "full_buffered" else "".join(parts[:200]))
                        assert "private backend" not in json.dumps(events)
                finally:
                    proceed.set()
                    pending.cancel()
                    await asyncio.gather(pending, return_exceptions=True)
