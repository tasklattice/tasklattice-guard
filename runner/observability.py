from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import TYPE_CHECKING

import pyroscope
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.trace.sampling import ParentBased, TraceIdRatioBased
from pyroscope.otel import PyroscopeSpanProcessor

from . import __version__
from .config import RunnerSettings

if TYPE_CHECKING:
    from fastapi import FastAPI


_LOGGER = logging.getLogger(__name__)
_EXCLUDED_HTTP_URLS = r".*/metrics,.*/health/live,.*/health/ready"


@dataclass(slots=True)
class RunnerObservability:
    """Own framework instrumentation and exporter lifecycle for one Runner app."""

    tracer_provider: TracerProvider | None = None
    httpx_instrumented: bool = False
    app: FastAPI | None = None

    def instrument_app(self, app: FastAPI) -> None:
        if self.tracer_provider is None:
            return
        FastAPIInstrumentor.instrument_app(
            app,
            tracer_provider=self.tracer_provider,
            excluded_urls=_EXCLUDED_HTTP_URLS,
            # ASGI receive/send spans obscure the GuardRail stages without
            # adding useful latency attribution for this request/response API.
            exclude_spans=["receive", "send"],
        )
        self.app = app

    def shutdown(self) -> None:
        if self.app is not None:
            FastAPIInstrumentor.uninstrument_app(self.app)
            self.app = None
        if self.httpx_instrumented:
            HTTPXClientInstrumentor().uninstrument()
            self.httpx_instrumented = False
        if self.tracer_provider is not None:
            self.tracer_provider.force_flush()
            self.tracer_provider.shutdown()


def configure_observability(settings: RunnerSettings) -> RunnerObservability:
    """Configure optional OpenTelemetry and Pyroscope endpoints.

    OTLP endpoint parsing and signal-path handling are delegated to the official
    exporter. ``GUARD_OTEL_EXPORTER_OTLP_ENDPOINT`` remains a compatibility
    input, while new deployments use the standard OpenTelemetry environment.
    """

    runtime = RunnerObservability()
    if settings.pyroscope_server_address:
        pyroscope.configure(
            application_name="tasklattice.guard-runner",
            server_address=settings.pyroscope_server_address,
            sample_rate=settings.pyroscope_sample_rate,
            cpu_enabled=True,
            mem_enabled=False,
            enable_logging=False,
            tags={
                "service_name": "tasklattice.guard-runner",
                "runner_id": settings.runner_id,
                "pool": settings.pool_id,
            },
        )

    if not settings.otel_exporter_otlp_endpoint:
        if settings.pyroscope_server_address:
            _LOGGER.warning(
                "Pyroscope profiling is enabled without tracing; span profiles are unavailable."
            )
        return runtime

    if not (
        os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
        or os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
    ):
        os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"] = settings.otel_exporter_otlp_endpoint

    provider = TracerProvider(
        resource=Resource.create({
            "service.name": "tasklattice.guard-runner",
            "service.namespace": "tasklattice",
            "service.version": __version__,
            "runner.id": settings.runner_id,
            "runner.pool": settings.pool_id,
        }),
        sampler=ParentBased(TraceIdRatioBased(settings.otel_trace_sample_ratio)),
    )
    if settings.pyroscope_server_address:
        provider.add_span_processor(PyroscopeSpanProcessor())
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(provider)
    HTTPXClientInstrumentor().instrument(tracer_provider=provider)
    runtime.tracer_provider = provider
    runtime.httpx_instrumented = True
    return runtime


def current_trace_id() -> str | None:
    context = trace.get_current_span().get_span_context()
    if not context.is_valid:
        return None
    return f"{context.trace_id:032x}"


def current_exemplar() -> dict[str, str] | None:
    context = trace.get_current_span().get_span_context()
    if not context.is_valid or not context.trace_flags.sampled:
        return None
    return {"trace_id": f"{context.trace_id:032x}"}
