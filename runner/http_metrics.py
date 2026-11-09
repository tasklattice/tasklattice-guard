from __future__ import annotations

from fastapi import FastAPI
from prometheus_client import CollectorRegistry
from prometheus_fastapi_instrumentator import Instrumentator


def instrument_http_metrics(app: FastAPI, registry: CollectorRegistry) -> None:
    """Install the community FastAPI RED middleware on the Runner registry."""

    Instrumentator(
        should_group_status_codes=True,
        should_ignore_untemplated=True,
        should_group_untemplated=False,
        should_instrument_requests_inprogress=True,
        excluded_handlers=[r".*/metrics", r".*/health/live", r".*/health/ready", r".*/healthz", r".*/version"],
        registry=registry,
    ).instrument(app, metric_namespace="guard_runner")
