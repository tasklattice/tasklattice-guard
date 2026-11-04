"""Bounded provider recovery: connection setup and explicit admission rejection.

These cannot duplicate a completed inference. In addition to HTTP 429, a
provider can recognize its own pre-inference capacity rejection. HTTP success,
unrecognized server errors and invalid model output are never retried."""
from __future__ import annotations

import asyncio
import json
import logging
import random
import socket
import ssl
import time
from collections.abc import Awaitable, Callable
from typing import TypeVar

import httpx

from .model_call import ModelCallTracker, model_error_chain, model_error_diagnostics

_T = TypeVar("_T")
_LOGGER = logging.getLogger("uvicorn.error.tasklattice.model")
def _retry_after_seconds(response: httpx.Response | None) -> float | None:
    if response is None:
        return None
    try:
        value = float(response.headers.get("retry-after", ""))
    except (TypeError, ValueError):
        return None
    # Providers occasionally return a past or absurd value; keep the wait bounded.
    return value if 0 <= value <= 30 else None


def _transient_connection(error: BaseException) -> bool:
    # Certificate and permanent DNS errors need configuration repair. Never
    # retry read/write failures: the provider may already have billed the call.
    return not any(isinstance(e, ssl.SSLCertVerificationError)
                   or (isinstance(e, socket.gaierror) and e.errno != socket.EAI_AGAIN)
                   for e in model_error_chain(error))


async def with_connection_retry(operation: Callable[[], Awaitable[_T]], *,
                                deadline: float, call: ModelCallTracker, rate_limit_attempts: int = 3,
                                retryable_rejection: Callable[[httpx.Response], bool] | None = None) -> _T:
    """Bounded recovery within one shared monotonic deadline.

    Connection establishment retries at most once. An explicit 429 is retried up
    to the configured provider attempts, honouring Retry-After when the provider
    supplies a usable value. The deadline includes connect, response and backoff
    time; cancellation propagates immediately. A provider may additionally
    identify an explicit pre-inference admission rejection. Other server
    failures, malformed responses and uncertain classifications never retry.
    """
    if type(rate_limit_attempts) is not int or not 1 <= rate_limit_attempts <= 10:
        raise ValueError("Model rate-limit attempts must be from 1 to 10.")
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("Model call deadline exceeded")
    async with asyncio.timeout(remaining):
        for attempt in range(max(2, rate_limit_attempts)):
            try:
                return await operation()
            except httpx.HTTPStatusError as error:
                status = error.response.status_code if error.response is not None else None
                if status != 429 and not (error.response is not None and retryable_rejection
                                         and retryable_rejection(error.response)):
                    raise
                hinted = _retry_after_seconds(error.response)
                delay = hinted if hinted is not None else min(8.0, 0.5 * 2 ** attempt) * random.uniform(0.8, 1.2)
                retry = attempt < rate_limit_attempts - 1 and deadline - time.monotonic() > delay + 0.05
                _LOGGER.warning("%s", json.dumps({"event": "model_rate_limited",
                    "http_status": status,
                    "call_id": call.call_id, "attempt": attempt + 1, "will_retry": retry,
                    "planned_backoff_ms": round(delay * 1000) if retry else 0,
                    "retry_after_hint": hinted is not None}))
                if not retry:
                    raise
                started = time.monotonic()
                try:
                    await asyncio.sleep(delay)
                finally:
                    call.backoff_ms += max(0, round((time.monotonic() - started) * 1000))
                call.retries += 1
            except (httpx.ConnectError, httpx.ConnectTimeout) as error:
                delay = random.uniform(0.1, 0.2)
                retry = attempt == 0 and _transient_connection(error) and deadline - time.monotonic() > delay + 0.05
                _LOGGER.warning("%s", json.dumps({"event": "model_connection_failure",
                    "call_id": call.call_id, "attempt": attempt + 1, "will_retry": retry,
                    "planned_backoff_ms": round(delay * 1000) if retry else 0,
                    **model_error_diagnostics(error)}))
                if not retry:
                    raise
                started = time.monotonic()
                try:
                    await asyncio.sleep(delay)
                finally:
                    call.backoff_ms += max(0, round((time.monotonic() - started) * 1000))
                call.retries += 1
    raise AssertionError("Unreachable connection retry state")
