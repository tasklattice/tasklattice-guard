from __future__ import annotations

import logging
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest
import requests
from fastapi import FastAPI
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SpanExporter, SpanExportResult

import runner.observability as observability
import runner.otel_exporter as otel


@pytest.fixture
def clock(monkeypatch):
    now = [0.0]
    monkeypatch.setattr(otel, "monotonic", lambda: now[0])
    monkeypatch.setattr(otel, "uniform", lambda _lower, _upper: 1.0)
    return now


@pytest.fixture
def wrap(clock):
    exporters = []

    def create(delegate=None):
        if delegate is None:
            delegate = Mock(spec=SpanExporter)
            delegate.export.return_value = SpanExportResult.FAILURE
        exporter = otel.BackoffSpanExporter(delegate)
        exporters.append(exporter)
        return exporter, delegate

    yield create
    for exporter in exporters:
        exporter.shutdown()


def errors(caplog):
    return [record for record in caplog.records if record.levelno >= logging.ERROR]


def test_failed_batches_back_off_across_requests_without_log_flooding(wrap, clock, caplog):
    exporter, delegate = wrap()
    for delay in (30, 60, 120, 240, 300, 300):
        assert exporter.export([]) == SpanExportResult.FAILURE
        calls = delegate.export.call_count
        clock[0] += delay - 0.01
        for _ in range(100):
            assert exporter.export([]) == SpanExportResult.FAILURE
        assert delegate.export.call_count == calls
        clock[0] += 0.01
    assert delegate.export.call_count == 6
    assert len(errors(caplog)) == 1


def test_recovery_resets_backoff_and_a_later_outage_logs_once(wrap, clock, caplog):
    caplog.set_level(logging.INFO)
    exporter, delegate = wrap()
    delegate.export.side_effect = [
        SpanExportResult.FAILURE, SpanExportResult.SUCCESS,
        SpanExportResult.FAILURE, SpanExportResult.SUCCESS,
    ]
    exporter.export([])
    clock[0] = 30
    assert exporter.export([]) == SpanExportResult.SUCCESS
    assert "export recovered" in caplog.text
    exporter.export([])
    clock[0] = 59
    exporter.export([])
    assert delegate.export.call_count == 3
    clock[0] = 60
    assert exporter.export([]) == SpanExportResult.SUCCESS
    assert len(errors(caplog)) == 2


@pytest.mark.parametrize("error", [requests.ConnectionError, requests.Timeout, ValueError])
def test_export_exceptions_do_not_escape_or_expose_endpoint_details(wrap, error, caplog):
    exporter, delegate = wrap()
    delegate.export.side_effect = error("https://user:secret@collector.invalid/?token=private")
    for _ in range(10):
        assert exporter.export([]) == SpanExportResult.FAILURE
    assert delegate.export.call_count == 1
    assert len(errors(caplog)) == 1
    assert error.__name__ in caplog.text
    assert "secret" not in caplog.text
    assert "private" not in caplog.text


def test_sdk_retry_logs_are_scoped_to_the_wrapped_export(wrap, caplog):
    exporter, delegate = wrap()

    def fail(_spans):
        otel._SDK_LOGGER.warning("Retrying %s", requests.ConnectionError("private-url"))
        otel._SDK_LOGGER.error("Failure %s: %s", 401, "private-response")
        return SpanExportResult.FAILURE

    delegate.export.side_effect = fail
    exporter.export([])
    assert len(errors(caplog)) == 1
    assert "HTTP 401" in caplog.text
    assert "private" not in caplog.text
    otel._SDK_LOGGER.error("Unrelated exporter error")
    assert "Unrelated exporter error" in caplog.text


@pytest.mark.parametrize("jitter", [0.8, 1.2])
def test_retry_jitter_does_not_exceed_the_five_minute_cap(wrap, clock, monkeypatch, jitter):
    monkeypatch.setattr(otel, "uniform", lambda _lower, _upper: jitter)
    exporter, delegate = wrap()
    for base in (30, 60, 120, 240, 300, 300):
        exporter.export([])
        calls = delegate.export.call_count
        clock[0] += min(base * jitter, 300) - 0.01
        exporter.export([])
        assert delegate.export.call_count == calls
        clock[0] += 0.01


@pytest.mark.parametrize("failure", ["connection", "timeout", 401, 503])
def test_real_otlp_exporter_stops_network_calls_during_cooldown(
    wrap, clock, caplog, failure,
):
    # Keep the real SDK encoder, transport configuration and retry handling.
    # A short per-batch timeout avoids waiting through its internal backoffs.
    session = requests.Session()
    session.post = Mock()
    if failure == "connection":
        session.post.side_effect = requests.ConnectionError("private endpoint details")
    elif failure == "timeout":
        session.post.side_effect = requests.Timeout("private endpoint details")
    else:
        response = requests.Response()
        response.status_code = failure
        response.reason = "private response details"
        session.post.return_value = response
    native = OTLPSpanExporter(
        endpoint="http://collector.invalid/v1/traces", timeout=0.001, session=session,
    )
    exporter, _ = wrap(native)
    assert exporter.export([]) == SpanExportResult.FAILURE
    calls = session.post.call_count
    assert calls >= 1
    for _ in range(100):
        exporter.export([])
    assert session.post.call_count == calls
    assert len(errors(caplog)) == 1
    assert "private" not in caplog.text

    response = requests.Response()
    response.status_code = 200
    session.post.side_effect = None
    session.post.return_value = response
    clock[0] = 30
    assert exporter.export([]) == SpanExportResult.SUCCESS
    assert session.post.call_count == calls + 1
    assert session.post.call_args.kwargs["url"] == "http://collector.invalid/v1/traces"


def test_shutdown_does_not_probe_the_collector_again(wrap, clock):
    exporter, delegate = wrap()
    delegate.force_flush.return_value = True
    assert exporter.force_flush(123) is True
    delegate.force_flush.assert_called_once_with(123)
    exporter.export([])
    exporter.shutdown()
    exporter.shutdown()
    clock[0] = 1000
    assert exporter.export([]) == SpanExportResult.FAILURE
    assert exporter.force_flush() is True
    assert delegate.export.call_count == 1
    delegate.shutdown.assert_called_once()


@pytest.mark.asyncio
async def test_collector_failure_keeps_instrumented_http_requests_serving(wrap, caplog):
    exporter, delegate = wrap()
    delegate.export.side_effect = requests.ConnectionError("collector unavailable")
    provider = TracerProvider()
    provider.add_span_processor(BatchSpanProcessor(exporter))
    runtime = observability.RunnerObservability(tracer_provider=provider)
    app = FastAPI()

    @app.get("/runtime/v1/check")
    async def check():
        return {"decision": "allow"}

    runtime.instrument_app(app)
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://runner",
        ) as client:
            for _ in range(2):
                response = await client.get("/runtime/v1/check")
                assert response.status_code == 200
                assert response.json() == {"decision": "allow"}
                assert provider.force_flush(timeout_millis=1000)
        assert delegate.export.call_count == 1
        assert len(errors(caplog)) == 1
    finally:
        runtime.shutdown()


def test_runner_only_installs_backoff_exporter_when_tracing_is_enabled(monkeypatch):
    delegate = Mock(spec=SpanExporter)
    delegate.export.return_value = SpanExportResult.SUCCESS
    factory = Mock(return_value=delegate)
    monkeypatch.setattr(observability, "OTLPSpanExporter", factory)
    monkeypatch.setattr(observability.trace, "set_tracer_provider", Mock())
    instrumentor = Mock()
    monkeypatch.setattr(observability, "HTTPXClientInstrumentor", lambda: instrumentor)
    installed = []

    def processor(exporter):
        installed.append(exporter)
        return BatchSpanProcessor(exporter)

    monkeypatch.setattr(observability, "BatchSpanProcessor", processor)
    settings = SimpleNamespace(
        pyroscope_server_address=None, otel_exporter_otlp_endpoint=None,
        otel_trace_sample_ratio=0.1, runner_id="test-runner", pool_id="default",
    )
    disabled = observability.configure_observability(settings)
    assert disabled.tracer_provider is None
    factory.assert_not_called()
    settings.otel_exporter_otlp_endpoint = "http://collector.invalid:4318"
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", settings.otel_exporter_otlp_endpoint)
    enabled = observability.configure_observability(settings)
    try:
        assert len(installed) == 1
        assert isinstance(installed[0], otel.BackoffSpanExporter)
    finally:
        enabled.shutdown()
    delegate.shutdown.assert_called_once()
