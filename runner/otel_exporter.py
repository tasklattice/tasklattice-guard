"""Bound OTLP export attempts across batches during a Collector outage."""
from __future__ import annotations

import logging
from collections.abc import Sequence
from contextvars import ContextVar
from dataclasses import dataclass
from random import uniform
from threading import Lock
from time import monotonic

from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult


_LOGGER = logging.getLogger(__name__)
_SDK_LOGGER = logging.getLogger("opentelemetry.exporter.otlp.proto.http.trace_exporter")
_INITIAL_BACKOFF_SECONDS = 30.0
_MAX_BACKOFF_SECONDS = 300.0


@dataclass
class _ExportFailure:
    reason: str = "export_failure"


_EXPORT_FAILURE: ContextVar[_ExportFailure | None] = ContextVar("otlp_export_failure", default=None)


class _CaptureExporterLogs(logging.Filter):
    """Capture bounded diagnostics only inside our export call, on its thread."""

    def filter(self, record: logging.LogRecord) -> bool:
        failure = _EXPORT_FAILURE.get()
        if failure is None:
            return True
        # Do not repeat SDK retry messages or log URLs, headers or response text.
        args = record.args.values() if isinstance(record.args, dict) else record.args or ()
        for value in args:
            if isinstance(value, BaseException):
                failure.reason = type(value).__name__
            elif type(value) is int and 400 <= value < 600:
                failure.reason = f"HTTP {value}"
        return False


class BackoffSpanExporter(SpanExporter):
    """Keep the SDK's per-batch budget and back off subsequent failed batches.

    This runs on BatchSpanProcessor's worker. During cooldown batches fail
    immediately without sleeping, buffering, or making another network call.
    """

    def __init__(self, exporter: SpanExporter) -> None:
        self._exporter = exporter
        self._lock = Lock()
        self._shutdown = False
        self._unavailable = False
        self._retry_after = 0.0
        self._backoff = _INITIAL_BACKOFF_SECONDS
        self._log_filter = _CaptureExporterLogs()
        _SDK_LOGGER.addFilter(self._log_filter)

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        with self._lock:
            if self._shutdown or monotonic() < self._retry_after:
                return SpanExportResult.FAILURE

            failure = _ExportFailure()
            token = _EXPORT_FAILURE.set(failure)
            try:
                result = self._exporter.export(spans)
            except Exception as error:
                # Telemetry failure must not escape into the processor or Guard.
                failure.reason = type(error).__name__
                result = SpanExportResult.FAILURE
            finally:
                _EXPORT_FAILURE.reset(token)

            if result == SpanExportResult.SUCCESS:
                if self._unavailable:
                    _LOGGER.info("OpenTelemetry trace export recovered; normal export resumed.")
                self._unavailable = False
                self._retry_after = 0.0
                self._backoff = _INITIAL_BACKOFF_SECONDS
                return result

            delay = min(self._backoff * uniform(0.8, 1.2), _MAX_BACKOFF_SECONDS)
            self._retry_after = monotonic() + delay
            self._backoff = min(self._backoff * 2, _MAX_BACKOFF_SECONDS)
            if not self._unavailable:
                _LOGGER.error(
                    "OpenTelemetry trace export failed (%s); retrying after %.1fs "
                    "with exponential backoff up to %.0fs. "
                    "Trace batches are dropped while export is paused.",
                    failure.reason, delay, _MAX_BACKOFF_SECONDS,
                )
            self._unavailable = True
            return SpanExportResult.FAILURE

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        with self._lock:
            return self._shutdown or self._exporter.force_flush(timeout_millis)

    def shutdown(self) -> None:
        with self._lock:
            if self._shutdown:
                return
            self._shutdown = True
            try:
                self._exporter.shutdown()
            finally:
                _SDK_LOGGER.removeFilter(self._log_filter)
