"""Group allocations must fence both new and in-flight runtime requests."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import MagicMock

import httpx
import pytest
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route

from runner.control_client import RunnerControlClient
from runner.generated import runner_control_pb2 as protocol
from runner.synchronization import RuntimeSynchronizationMiddleware


class Control:
    def __init__(self, ready: bool = False):
        self.synchronized = ready
        self.synchronization_lost = asyncio.Event()
        if not ready:
            self.synchronization_lost.set()


@pytest.mark.asyncio
async def test_runtime_requires_current_controller_sync_but_health_remains_accessible():
    control = Control()
    async def ok(_request):
        return JSONResponse({"ok": True})
    app = Starlette(routes=[Route("/health/live", ok), Route("/runtime/v1/endpoints/a/verify", ok, methods=["POST"]),
                            Route("/internal/v1/playground/test", ok, methods=["POST"])])
    app.add_middleware(RuntimeSynchronizationMiddleware, control=control)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://runner") as client:
        assert (await client.get("/health/live")).status_code == 200
        assert (await client.post("/runtime/v1/endpoints/a/verify")).status_code == 503
        assert (await client.post("/internal/v1/playground/test")).status_code == 503
        control.synchronization_lost = asyncio.Event()
        control.synchronized = True
        assert (await client.post("/runtime/v1/endpoints/a/verify")).status_code == 200


@pytest.mark.asyncio
async def test_disconnect_cancels_an_inflight_http_request():
    control = Control(True)
    started, cancelled = asyncio.Event(), asyncio.Event()
    async def slow(_request):
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()
        return JSONResponse({"unsafe": True})
    app = Starlette(routes=[Route("/runtime/v1/endpoints/a/verify", slow, methods=["POST"])])
    app.add_middleware(RuntimeSynchronizationMiddleware, control=control)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://runner") as client:
        request = asyncio.create_task(client.post("/runtime/v1/endpoints/a/verify"))
        await asyncio.wait_for(started.wait(), 1)
        control.synchronized = False
        control.synchronization_lost.set()
        response = await asyncio.wait_for(request, 1)
        assert response.status_code == 503
        assert cancelled.is_set()


@pytest.mark.asyncio
async def test_websocket_fences_disconnected_and_inflight_streams():
    control = Control()
    messages = []
    started = asyncio.Event()
    async def app(_scope, _receive, send):
        await send({"type": "websocket.accept"})
        started.set()
        await asyncio.Event().wait()
    async def receive():
        return {"type": "websocket.connect"}
    async def send(message):
        messages.append(message)
    middleware = RuntimeSynchronizationMiddleware(app, control)
    scope = {"type": "websocket", "path": "/runtime/v1/endpoints/a/guardrails/output-stream"}
    await middleware(scope, receive, send)
    assert messages == [{"type": "websocket.close", "code": 1013, "reason": "Runner requires Controller synchronization."}]
    messages.clear()
    control.synchronized = True
    control.synchronization_lost = asyncio.Event()
    task = asyncio.create_task(middleware(scope, receive, send))
    await asyncio.wait_for(started.wait(), 1)
    control.synchronized = False
    control.synchronization_lost.set()
    await asyncio.wait_for(task, 1)
    assert messages[0]["type"] == "websocket.accept"
    assert messages[-1]["type"] == "websocket.close" and messages[-1]["code"] == 1013


@pytest.mark.asyncio
async def test_disconnect_aborts_an_http_response_after_headers():
    control = Control(True)
    started = asyncio.Event()
    messages = []
    async def app(_scope, _receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        started.set()
        await asyncio.Event().wait()
    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}
    async def send(message):
        messages.append(message)
    task = asyncio.create_task(RuntimeSynchronizationMiddleware(app, control)(
        {"type": "http", "path": "/runtime/v1/endpoints/a/verify"}, receive, send))
    await asyncio.wait_for(started.wait(), 1)
    control.synchronized = False
    control.synchronization_lost.set()
    with pytest.raises(RuntimeError, match="after response headers"):
        await asyncio.wait_for(task, 1)
    assert [message["type"] for message in messages] == ["http.response.start"]


@pytest.mark.asyncio
async def test_restored_state_and_late_apply_cannot_reauthorize_after_disconnect(monkeypatch):
    settings = SimpleNamespace(compiler_capable=False)
    store = SimpleNamespace(generation=3, apply=MagicMock())
    metrics = MagicMock()
    control = RunnerControlClient(settings, store, metrics)
    assert not control.synchronized
    started, resume = asyncio.Event(), asyncio.Event()
    async def delayed_prepare(*_args, **_kwargs):
        started.set()
        await resume.wait()
    monkeypatch.setattr("runner.control_client.prepare", delayed_prepare)
    task = asyncio.create_task(control._apply_desired_state(protocol.DesiredState(generation=4)))
    await asyncio.wait_for(started.wait(), 1)
    control._revoke_synchronization()
    resume.set()
    await asyncio.wait_for(task, 1)
    assert not control.synchronized
    assert control.synchronization_lost.is_set()
    control._allow_synchronized_serving()
    assert control.synchronized and not control.synchronization_lost.is_set()
    control._revoke_synchronization()
    assert not control.synchronized and control.synchronization_lost.is_set()
