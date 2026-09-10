from __future__ import annotations

import json

import httpx
import pytest
from prometheus_client import generate_latest

from runner.metrics import RunnerMetrics
from runner.telemetry import RuntimeTelemetryExporter


@pytest.mark.asyncio
async def test_runtime_events_remain_in_wal_until_controller_accepts_them(tmp_path):
    exporter = RuntimeTelemetryExporter("http://controller/events", "token", tmp_path, 100, "runner-0")
    event = {"id": "event-1", "requestId": "request-1", "decision": "allow"}
    await exporter.emit(event)
    assert "event-1" in (tmp_path / "runtime-events.wal").read_text()

    received = []
    transport = httpx.MockTransport(lambda request: (
        received.append(request) or httpx.Response(202, json={"accepted": 1})
    ))
    async with httpx.AsyncClient(transport=transport) as client:
        assert await exporter._flush_once(client) is False

    assert received[0].headers["authorization"] == "Bearer token"
    assert not (tmp_path / "runtime-events.wal").read_text()


@pytest.mark.asyncio
async def test_legacy_null_optional_fields_are_omitted_when_draining_wal(tmp_path):
    exporter = RuntimeTelemetryExporter("http://controller/events", "token", tmp_path, 100, "runner-0")
    await exporter.emit({
        "id": "event-1",
        "requestId": "playground-call",
        "endpointId": None,
        "decision": "allow",
    })
    received = []
    transport = httpx.MockTransport(lambda request: (
        received.append(json.loads(request.content))
        or httpx.Response(202, json={"accepted": 1})
    ))

    async with httpx.AsyncClient(transport=transport) as client:
        assert await exporter._flush_once(client) is False

    assert "endpointId" not in received[0]["events"][0]
    assert not (tmp_path / "runtime-events.wal").read_text()


@pytest.mark.asyncio
async def test_zero_traffic_watermark_proves_the_export_channel_is_fresh(tmp_path):
    exporter = RuntimeTelemetryExporter("http://controller/events", "token", tmp_path, 100, "runner-0")
    received = []
    transport = httpx.MockTransport(lambda request: (
        received.append(request) or httpx.Response(202, json={"accepted": 0})
    ))

    async with httpx.AsyncClient(transport=transport) as client:
        await exporter._report_watermark(client)

    payload = json.loads(received[0].content)
    assert payload["events"] == []
    assert payload["runnerId"] == "runner-0"
    assert payload["observedAt"]


@pytest.mark.asyncio
async def test_wal_depth_and_successful_drain_are_exported_as_metrics(tmp_path):
    metrics = RunnerMetrics(8)
    exporter = RuntimeTelemetryExporter(
        "http://controller/events", "token", tmp_path, 100, "runner-0", metrics,
    )
    await exporter.emit({"id": "event-1", "occurredAt": "2026-08-23T00:00:00Z"})

    before = generate_latest(metrics.registry).decode()
    assert "guard_runner_telemetry_wal_events 1.0" in before
    assert "guard_runner_telemetry_wal_bytes " in before

    transport = httpx.MockTransport(lambda _request: httpx.Response(202, json={"accepted": 1}))
    async with httpx.AsyncClient(transport=transport) as client:
        assert await exporter._flush_once(client) is False

    after = generate_latest(metrics.registry).decode()
    assert "guard_runner_telemetry_wal_events 0.0" in after
    assert 'guard_runner_telemetry_export_batches_total{operation="events",result="success"} 1.0' in after
    assert 'guard_runner_telemetry_export_events_total{result="success"} 1.0' in after
