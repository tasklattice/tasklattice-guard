"""Collapse retryable transport outages into a bounded number of log lines.

A Runner is expected to start before its Controller, and to survive Controller
restarts and rollouts. Every failed control-stream attach or telemetry delivery
is therefore retried, and the retry itself is the normal case. Reporting a
traceback per attempt turns that expected reconnect into what looks like an
unrecoverable failure and floods the Pod log, which hides the failures that do
need attention.

One outage is opened with a single line, summarized at a low rate while it
lasts, and closed with a recovery line once the link is back. Tracebacks stay
at DEBUG. Failures that cannot heal on their own - a rejected token, a broken
protocol or a bug - are still reported as errors, once per distinct shape.
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any

import grpc
import httpx


# Uvicorn configures this namespace at INFO even when the root logger is
# WARNING, so lifecycle lines stay visible next to runner_phase_* diagnostics.
logger = logging.getLogger("uvicorn.error.tasklattice.runner.transport")

# Transport outcomes that retry on their own. Everything else is a real
# failure: UNAUTHENTICATED and PERMISSION_DENIED mean the credential is wrong,
# INVALID_ARGUMENT means the stream contract is broken.
_TRANSIENT_GRPC_CODES = frozenset({
    grpc.StatusCode.UNAVAILABLE,
    grpc.StatusCode.DEADLINE_EXCEEDED,
    grpc.StatusCode.CANCELLED,
    grpc.StatusCode.ABORTED,
})
# A gateway or Controller that is still starting answers with these.
_TRANSIENT_HTTP_STATUS = frozenset({502, 503, 504})


def _log(sink: logging.Logger, event: str, level: int, **fields: Any) -> None:
    sink.log(level, "%s", json.dumps({"event": event, **fields}, sort_keys=True))


def is_transient_transport_error(error: BaseException) -> bool:
    """Whether the same call is expected to succeed once the peer is back."""
    if isinstance(error, grpc.RpcError):
        return error.code() in _TRANSIENT_GRPC_CODES
    if isinstance(error, httpx.HTTPStatusError):
        return error.response.status_code in _TRANSIENT_HTTP_STATUS
    return isinstance(error, (httpx.TransportError, ConnectionError, TimeoutError))


def describe_transport_error(error: BaseException) -> str:
    """A short, stable reason. Never includes payloads, tokens or headers."""
    if isinstance(error, grpc.RpcError):
        code = error.code()
        return code.name if isinstance(code, grpc.StatusCode) else type(error).__name__
    if isinstance(error, httpx.HTTPStatusError):
        return f"HTTP {error.response.status_code}"
    return type(error).__name__


class TransportOutage:
    """Log state for one link, so a retry loop stays quiet between its edges."""

    def __init__(
        self,
        subject: str,
        *,
        summary_interval_seconds: float = 60.0,
        log: logging.Logger | None = None,
    ) -> None:
        self._subject = subject
        self._summary_interval = summary_interval_seconds
        self._logger = log or logger
        self._attempts = 0
        self._opened_at = 0.0
        self._last_report_at = 0.0
        self._last_shape: tuple[str, str] | None = None

    @property
    def attempts(self) -> int:
        """Consecutive failures since the last recovery."""
        return self._attempts

    def failed(self, error: BaseException, *, retry_in: float | None = None, **fields: Any) -> None:
        now = time.monotonic()
        if self._attempts == 0:
            self._opened_at = now
            self._last_report_at = 0.0
            self._last_shape = None
        self._attempts += 1
        reason = describe_transport_error(error)
        transient = is_transient_transport_error(error)
        detail = {"subject": self._subject, "reason": reason, "attempts": self._attempts, **fields}
        if retry_in is not None:
            detail["retry_in_s"] = round(float(retry_in), 1)
        # Report the first failure, any change of failure shape, and then only
        # one summary per interval. A retry that is still failing the same way
        # carries no new information.
        shape = (type(error).__name__, reason)
        changed = shape != self._last_shape
        self._last_shape = shape
        if self._attempts > 1 and not changed and now - self._last_report_at < self._summary_interval:
            self._debug(error)
            return
        self._last_report_at = now
        event = "transport_unavailable" if transient else "transport_rejected"
        if self._attempts > 1 and not changed:
            event = "transport_still_unavailable" if transient else "transport_still_rejected"
            detail["elapsed_s"] = round(now - self._opened_at, 1)
        if not transient:
            detail["error_type"] = type(error).__name__
        _log(self._logger, event, logging.WARNING if transient else logging.ERROR, **detail)
        if not transient or self._attempts == 1:
            self._debug(error)

    def recovered(self) -> bool:
        """Close an open outage; returns whether one was open."""
        attempts = self._attempts
        if attempts == 0:
            return False
        self._attempts = 0
        self._last_shape = None
        _log(self._logger, "transport_restored", logging.INFO, subject=self._subject, attempts=attempts,
             elapsed_s=round(time.monotonic() - self._opened_at, 1))
        return True

    def _debug(self, error: BaseException) -> None:
        if self._logger.isEnabledFor(logging.DEBUG):
            self._logger.debug("%s: %s", self._subject, describe_transport_error(error), exc_info=error)
