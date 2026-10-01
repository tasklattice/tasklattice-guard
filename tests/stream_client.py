"""Small real-WebSocket peer for the Runner output protocol (no engine mocks)."""
from contextlib import asynccontextmanager
from uuid import uuid4

import aiohttp


@asynccontextmanager
async def connection(base_url, *, credential="fixture-runtime-secret", protocol="litellm", endpoint="fixture-endpoint", **metadata):
    async with aiohttp.ClientSession() as client:
        async with client.ws_connect(f"{base_url}/runtime/v1/endpoints/{endpoint}/guardrails/output-stream",
                                     headers={"x-api-key": credential}) as socket:
            await socket.send_json({"type": "start", "version": 1, "stream_id": str(uuid4()),
                                    "protocol": protocol, **metadata})
            ready = await socket.receive_json(timeout=5)
            yield socket, ready


async def exchange(socket, fragments, *, events=None):
    events = events if events is not None else []
    frames = [{"type": "delta", "sequence": i, "text": text} for i, text in enumerate(fragments)]
    frames.append({"type": "end", "sequence": len(frames)})
    for frame in frames:
        await socket.send_json(frame)
        while True:
            event = await socket.receive_json(timeout=10)
            events.append(event)
            if event["type"] in {"blocked", "error", "completed"}:
                return events
            if event["type"] == "ack":
                assert event["sequence"] == frame["sequence"]
                break
    while True:
        event = await socket.receive_json(timeout=10)
        events.append(event)
        if event["type"] in {"blocked", "error", "completed"}:
            return events


def released(events):
    return "".join(event["text"] for event in events if event["type"] == "delta")


@asynccontextmanager
async def runner(tmp_path, fixture_name="local-secrets-v1", *, providers=None, contexts=None):
    from pathlib import Path
    from fastapi import FastAPI
    from runner.api import RunnerAPI
    from runner.metrics import RunnerMetrics
    from runner.toolkit.runtime.service import GuardrailRuntimeService
    from tests.data_plane.test_artifact_execution import _runtime, Telemetry
    from tests.tcp import tcp_server
    fixture = Path(__file__).parent / "fixtures" / "artifacts" / fixture_name
    store, registry, engine = _runtime(tmp_path, fixture, providers=providers)
    telemetry = Telemetry()
    service = GuardrailRuntimeService(engine, store, contexts=contexts)
    app = FastAPI()
    app.include_router(RunnerAPI(service, store, RunnerMetrics(4), telemetry, "stream-test", "internal-test").router)
    try:
        async with tcp_server(app) as url:
            yield url, engine, registry, telemetry, store
    finally:
        await engine.shutdown()


async def service_stream(service, request, parts):
    """Exercise full-response fallback without re-resolving each input frame."""
    delivered, decisions, selected = [], [], []
    async def source():
        for part in parts:
            if selected and selected[0][0].effective_mode == "full_buffered":
                assert delivered == [], "Full-response policy released an unchecked prefix"
            yield part
    async def ready(contract, resolution): selected.append((contract, resolution))
    async def emit(text): delivered.append(text)
    async def observe(decision): decisions.append(decision)
    result = await service.stream_output(request, source(), ready=ready, emit=emit,
                                         observe=observe, allow_new_output=True)
    return result, "".join(delivered), decisions, selected[0][0]
