"""Fail closed when the Controller can no longer attest the pool allocation."""
from __future__ import annotations

import asyncio
from typing import Protocol

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send


class _ControlState(Protocol):
    @property
    def synchronized(self) -> bool: ...

    @property
    def synchronization_lost(self) -> asyncio.Event: ...


class _SynchronizationLost(RuntimeError):
    pass


class RuntimeSynchronizationMiddleware:
    """Fence new and active runtime traffic across control-stream disconnects.

    Health/metrics remain accessible. Restoring cached artifacts alone does not
    authorize traffic, including Controller-owned internal evaluation endpoints.
    """

    def __init__(self, app: ASGIApp, control: _ControlState) -> None:
        self.app = app
        self.control = control

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in {"http", "websocket"} or not scope.get("path", "").startswith(("/runtime/", "/internal/")):
            await self.app(scope, receive, send)
            return
        revoked = self.control.synchronization_lost
        if not self.control.synchronized or revoked.is_set():
            await self._unavailable(scope, receive, send)
            return
        started = complete = False

        async def checked_send(message):
            nonlocal started, complete
            # A watchdog can be delayed by a stalled event loop. Recheck the
            # authority synchronously before releasing headers, bytes or frames.
            if not self.control.synchronized or revoked.is_set():
                raise _SynchronizationLost("Runner allocation synchronization was lost.")
            if message["type"] in {"http.response.start", "websocket.accept"}:
                started = True
            if message["type"] == "websocket.close" or message["type"] == "http.response.body" and not message.get("more_body", False):
                complete = True
            await send(message)

        worker = asyncio.create_task(self.app(scope, receive, checked_send))
        lost = asyncio.create_task(revoked.wait())
        try:
            done, _ = await asyncio.wait((worker, lost), return_when=asyncio.FIRST_COMPLETED)
            if lost not in done and not revoked.is_set():
                await worker
                return
            worker.cancel()
            await asyncio.gather(worker, return_exceptions=True)
            if not complete:
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 1013, "reason": "Runner requires Controller synchronization."})
                elif not started:
                    await self._unavailable(scope, receive, send)
                else:
                    # The status cannot be changed after headers were sent.
                    # Abort the transport instead of completing a misleading
                    # successful response with an empty body.
                    raise _SynchronizationLost("Runner allocation synchronization was lost after response headers.")
        finally:
            worker.cancel()
            lost.cancel()
            await asyncio.gather(worker, lost, return_exceptions=True)

    @staticmethod
    async def _unavailable(scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1013, "reason": "Runner requires Controller synchronization."})
        else:
            await JSONResponse(status_code=503, content={"detail": "Runner requires current Controller synchronization."},
                               headers={"Retry-After": "1"})(scope, receive, send)
