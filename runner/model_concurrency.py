"""One cancellable admission gate per registered model and Runner event loop.

Gates survive provider/configuration swaps. Lowering the cap lets admitted calls
finish, while new calls wait for the new limit; independent models never share a
permit. HTTP clients may close independently without closing a shared transport.
"""
from __future__ import annotations

import asyncio
from collections import deque
from contextlib import asynccontextmanager
import threading
import time
from weakref import WeakKeyDictionary

import httpx
from opentelemetry import trace

_limits: dict[str, int] = {}
_gates: WeakKeyDictionary = WeakKeyDictionary()
_lock = threading.RLock()


class _ModelGate:
    def __init__(self, limit: int):
        self.limit, self.active = limit, 0
        self.waiters: deque[asyncio.Future] = deque()

    def update(self, limit: int):
        self.limit = limit
        self._wake()

    def _wake(self):
        while self.active < self.limit and self.waiters:
            waiter = self.waiters.popleft()
            if not waiter.done():
                self.active += 1
                waiter.set_result(None)

    async def acquire(self):
        waiter = asyncio.get_running_loop().create_future()
        self.waiters.append(waiter)
        self._wake()
        try:
            await waiter
        except BaseException:
            if waiter.done() and not waiter.cancelled():
                self.active -= 1
            else:
                try:
                    self.waiters.remove(waiter)
                except ValueError:
                    pass
            self._wake()
            raise

    def release(self):
        self.active -= 1
        self._wake()


def configure_model_limit(runtime_id: str, limit: int = 2):
    if type(limit) is not int or not 1 <= limit <= 64:
        raise ValueError("Model concurrency must be an integer from 1 to 64.")
    with _lock:
        _limits[runtime_id] = limit
        for loop, gates in list(_gates.items()):
            if (gate := gates.get(runtime_id)) is not None and not loop.is_closed():
                loop.call_soon_threadsafe(lambda gate=gate: gate.update(_limits[runtime_id]))


def _gate(runtime_id: str):
    with _lock:
        gates = _gates.setdefault(asyncio.get_running_loop(), {})
        if runtime_id not in gates:
            gates[runtime_id] = _ModelGate(_limits.get(runtime_id, 2))
        # Apply a newly lowered cap before any new request is admitted.
        gates[runtime_id].update(_limits.get(runtime_id, 2))
        return gates[runtime_id]


@asynccontextmanager
async def model_slot(runtime_id: str | None):
    if not runtime_id:
        yield 0
        return
    from runner.toolkit.nemo.actions.model_call import record_model_queue
    gate = _gate(runtime_id)
    started = time.perf_counter()
    admitted = False
    try:
        await gate.acquire()
        admitted = True
    finally:
        queue_ms = max(0, round((time.perf_counter() - started) * 1000))
        record_model_queue(queue_ms, admitted)
        span = trace.get_current_span()
        span.set_attribute("guardrail.model.queue_ms", queue_ms)
        span.set_attribute("guardrail.model.request_sent", admitted)
    try:
        yield queue_ms
    finally:
        if admitted:
            gate.release()


class ModelConcurrencyTransport(httpx.AsyncBaseTransport):
    def __init__(self, runtime_id: str, *, timeout_seconds: float,
                 skip_tls_verify: bool = False, transport: httpx.AsyncBaseTransport | None = None):
        self.runtime_id = runtime_id
        self.timeout_seconds = timeout_seconds
        self.skip_tls_verify = skip_tls_verify
        self.transport = transport

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        # The model budget includes queueing, connect and body read. Outer
        # Guardrail deadlines may cancel this operation sooner.
        async with asyncio.timeout(self.timeout_seconds):
            async with model_slot(self.runtime_id):
                if self.transport is not None:
                    return await self._send(self.transport, request)
                async with httpx.AsyncHTTPTransport(verify=not self.skip_tls_verify) as transport:
                    return await self._send(transport, request)

    async def _send(self, transport, request):
        response = await transport.handle_async_request(request)
        try:
            response.request = request
            from runner.model_http_evidence import httpx_response
            await httpx_response(response)
            from runner.model_validation_diagnostics import _httpx_response
            await _httpx_response(response)
            await response.aread()
            return response
        finally:
            await response.aclose()

    async def aclose(self):
        # Per-call owned transports close in handle_async_request. Injected
        # transports remain owned by their caller, not individual HTTP clients.
        pass
