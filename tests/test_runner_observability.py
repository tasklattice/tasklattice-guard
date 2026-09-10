from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import NonRecordingSpan, SpanContext, SpanKind, TraceFlags, TraceState
from prometheus_client import CollectorRegistry, generate_latest

from runner.http_metrics import instrument_http_metrics
from runner.observability import RunnerObservability, current_exemplar, current_trace_id


def _span(trace_flags: TraceFlags) -> NonRecordingSpan:
    return NonRecordingSpan(SpanContext(
        trace_id=0x1234567890ABCDEF1234567890ABCDEF,
        span_id=0x1234567890ABCDEF,
        is_remote=False,
        trace_flags=trace_flags,
        trace_state=TraceState(),
    ))


def test_prometheus_exemplars_only_reference_exported_sampled_traces() -> None:
    with trace.use_span(_span(TraceFlags(0)), end_on_exit=False):
        assert current_trace_id() == "1234567890abcdef1234567890abcdef"
        assert current_exemplar() is None

    with trace.use_span(_span(TraceFlags(TraceFlags.SAMPLED)), end_on_exit=False):
        assert current_exemplar() == {
            "trace_id": "1234567890abcdef1234567890abcdef",
        }


@pytest.mark.asyncio
async def test_fastapi_instrumentation_continues_the_inbound_trace() -> None:
    exporter = InMemorySpanExporter()
    provider = TracerProvider(resource=Resource.create({"service.name": "runner-test"}))
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    observability = RunnerObservability(tracer_provider=provider)
    app = FastAPI()

    @app.get("/runtime/v1/check")
    async def check():
        return {"trace_id": current_trace_id()}

    observability.instrument_app(app)
    inbound_trace_id = "0af7651916cd43dd8448eb211c80319c"
    inbound_parent_id = "b7ad6b7169203331"
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://runner",
    ) as client:
        response = await client.get(
            "/runtime/v1/check",
            headers={"traceparent": f"00-{inbound_trace_id}-{inbound_parent_id}-01"},
        )

    assert response.json() == {"trace_id": inbound_trace_id}
    server_span = next(
        span for span in exporter.get_finished_spans() if span.kind is SpanKind.SERVER
    )
    assert f"{server_span.context.trace_id:032x}" == inbound_trace_id
    assert f"{server_span.parent.span_id:016x}" == inbound_parent_id
    assert server_span.attributes["http.route"] == "/runtime/v1/check"
    observability.shutdown()


@pytest.mark.asyncio
async def test_fastapi_red_metrics_use_route_templates_not_request_ids() -> None:
    registry = CollectorRegistry()
    app = FastAPI()

    @app.get("/runtime/v1/endpoints/{endpoint_id}/verify")
    async def verify(endpoint_id: str):
        return {"endpoint_id": endpoint_id}

    instrument_http_metrics(app, registry)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://runner",
    ) as client:
        response = await client.get(
            "/runtime/v1/endpoints/caller-controlled-id/verify",
        )

    assert response.status_code == 200
    rendered = generate_latest(registry).decode()
    assert (
        'guard_runner_http_requests_total{handler="/runtime/v1/endpoints/'
        '{endpoint_id}/verify",method="GET",status="2xx"} 1.0'
    ) in rendered
    assert "caller-controlled-id" not in rendered
