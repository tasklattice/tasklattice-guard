from __future__ import annotations

import json

import httpx
import pytest
from prometheus_client import generate_latest

from runner.metrics import RunnerMetrics
from runner.telemetry import RuntimeTelemetryExporter, TelemetryReceiptError


def _metered_event(event_id: str, calls: int, **extra) -> dict:
    event = {
        "id": event_id,
        "requestId": f"request-{event_id}",
        "runnerId": "runner-0",
        "occurredAt": "2026-11-05T00:00:00Z",
        "direction": "incoming",
        "decision": "allow",
        "durationMs": 1,
        "metadata": {
            "usage": {
                "model_calls": [{"call_id": f"{event_id}-{index}"} for index in range(calls)],
                "model_invocations": calls,
            },
        },
    }
    event.update(extra)
    return event


def _wal_line(event: dict) -> str:
    return json.dumps(event, sort_keys=True, separators=(",", ":")) + "\n"


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
async def test_null_optional_fields_are_omitted_when_draining_wal(tmp_path):
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


@pytest.mark.asyncio
async def test_batching_splits_metered_backlog_and_preserves_retry_and_concurrent_tail(tmp_path):
    exporter = RuntimeTelemetryExporter("http://controller/events", "token", tmp_path, 100, "runner-0")
    events = [{"id": str(index), "metadata": {"usage": {"model_calls": [{"call_id": str(call)} for call in range(48)]}}}
              for index in range(6)]
    for event in events:
        await exporter.emit(event)
    original = (tmp_path / "runtime-events.wal").read_bytes()
    attempts = []
    accepted = []

    async def receive(request):
        batch = json.loads(request.content)["events"]
        attempts.append(batch)
        calls = sum(len(event.get("metadata", {}).get("usage", {}).get("model_calls", [])) for event in batch)
        if calls > 256:
            return httpx.Response(413)
        if len(attempts) == 1:
            return httpx.Response(503)
        if len(attempts) == 2:
            await exporter.emit({"id": "concurrent-tail"})
        accepted.extend(batch)
        return httpx.Response(202, json={"accepted": len(batch)})

    async with httpx.AsyncClient(transport=httpx.MockTransport(receive)) as client:
        with pytest.raises(httpx.HTTPStatusError) as failure:
            await exporter._flush_once(client)
        assert failure.value.response.status_code == 503
        assert (tmp_path / "runtime-events.wal").read_bytes() == original
        assert await exporter._flush_once(client) is True
        assert await exporter._flush_once(client) is False

    assert [len(batch) for batch in attempts] == [5, 5, 2]
    assert attempts[0] == attempts[1]
    assert accepted == [*events, {"id": "concurrent-tail"}]
    assert (tmp_path / "runtime-events.wal").read_text() == ""


@pytest.mark.asyncio
async def test_batch_is_capped_at_http_event_limit(tmp_path):
    events = [{"id": str(index)} for index in range(1001)]
    (tmp_path / "runtime-events.wal").write_text("".join(json.dumps(event) + "\n" for event in events))
    exporter = RuntimeTelemetryExporter("http://controller/events", "token", tmp_path, 2000, "runner-0")
    received = []

    def receive(request):
        batch = json.loads(request.content)["events"]
        received.append(batch)
        return httpx.Response(202 if len(batch) <= 1000 else 400, json={"accepted": len(batch)})

    async with httpx.AsyncClient(transport=httpx.MockTransport(receive)) as client:
        assert await exporter._flush_once(client) is True
        assert await exporter._flush_once(client) is False
    assert [len(batch) for batch in received] == [1000, 1]
    assert [event for batch in received for event in batch] == events


@pytest.mark.asyncio
@pytest.mark.parametrize("calls,chunks", [(64, 1), (65, 2), (130, 3), (300, 5)])
async def test_emit_splits_metered_events_into_deterministic_companions(tmp_path, calls, chunks):
    exporter = RuntimeTelemetryExporter("http://controller/events", "token", tmp_path, 100, "runner-0")
    event = _metered_event("event-1", calls, guardrailId="guardrail-1")
    await exporter.emit(event)

    lines = [json.loads(line) for line in (tmp_path / "runtime-events.wal").read_text().splitlines()]
    assert len(lines) == chunks
    assert lines[0]["id"] == "event-1"
    assert lines[0]["metadata"]["usage"]["model_invocations"] == calls
    assert [part["id"] for part in lines[1:]] == [f"event-1#cost-{index}" for index in range(1, chunks)]
    assert all(part["metadata"]["costOnly"] is True for part in lines[1:])
    assert all(part["metadata"]["costSource"] == "runtime" for part in lines[1:])
    assert sum(len(part["metadata"]["usage"]["model_calls"]) for part in lines) == calls
    assert sum(
        len(part["metadata"]["usage"]["model_calls"]) for part in lines
    ) == len({call["call_id"] for part in lines for call in part["metadata"]["usage"]["model_calls"]})

    # A retry re-reads the same deterministic split; companion ids are not regenerated.
    assert (tmp_path / "runtime-events.wal").read_text() == "".join(_wal_line(part) for part in lines)


@pytest.mark.asyncio
async def test_bad_202_receipt_keeps_the_wal_and_records_the_result(tmp_path):
    metrics = RunnerMetrics(8)
    exporter = RuntimeTelemetryExporter(
        "http://controller/events", "token", tmp_path, 100, "runner-0", metrics,
    )
    await exporter.emit({"id": "event-1", "requestId": "request-1"})
    original = (tmp_path / "runtime-events.wal").read_bytes()
    transport = httpx.MockTransport(lambda _request: httpx.Response(202, json={"accepted": 0}))

    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(TelemetryReceiptError):
            await exporter._flush_once(client)

    assert (tmp_path / "runtime-events.wal").read_bytes() == original
    assert 'guard_runner_telemetry_export_batches_total{operation="events",result="invalid_receipt"} 1.0' in (
        generate_latest(metrics.registry).decode()
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(202, content=b"not-json"),
        httpx.Response(202, json={"accepted": True}),
        httpx.Response(202, json={"accepted": "1"}),
        httpx.Response(202, json={}),
        httpx.Response(202, json=["accepted"]),
    ],
)
async def test_non_acknowledging_202_keeps_the_wal(tmp_path, response):
    exporter = RuntimeTelemetryExporter("http://controller/events", "token", tmp_path, 100, "runner-0")
    await exporter.emit({"id": "event-1", "requestId": "request-1"})
    original = (tmp_path / "runtime-events.wal").read_bytes()
    transport = httpx.MockTransport(lambda _request: response)

    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(TelemetryReceiptError):
            await exporter._flush_once(client)

    assert (tmp_path / "runtime-events.wal").read_bytes() == original


@pytest.mark.asyncio
async def test_watermark_requires_an_exact_zero_accepted_receipt(tmp_path):
    exporter = RuntimeTelemetryExporter("http://controller/events", "token", tmp_path, 100, "runner-0")
    transport = httpx.MockTransport(lambda _request: httpx.Response(202, json={"accepted": 1}))
    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(TelemetryReceiptError):
            await exporter._report_watermark(client)


@pytest.mark.asyncio
async def test_watermark_non_json_receipt_is_rejected(tmp_path):
    exporter = RuntimeTelemetryExporter("http://controller/events", "token", tmp_path, 100, "runner-0")
    transport = httpx.MockTransport(lambda _request: httpx.Response(202, content=b"accepted"))
    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(TelemetryReceiptError):
            await exporter._report_watermark(client)


@pytest.mark.asyncio
async def test_gateway_413_shrinks_the_batch_without_losing_events(tmp_path):
    metrics = RunnerMetrics(8)
    events = [{"id": f"event-{index}", "body": "x" * 7000} for index in range(300)]
    (tmp_path / "runtime-events.wal").write_text("".join(_wal_line(event) for event in events))
    exporter = RuntimeTelemetryExporter(
        "http://controller/events", "token", tmp_path, 1000, "runner-0", metrics,
    )
    delivered = []
    attempts = []

    def receive(request):
        attempts.append(len(request.content))
        if len(request.content) > 1024 * 1024:
            return httpx.Response(413, json={"error": {"code": "telemetry_batch_too_large"}})
        batch = json.loads(request.content)["events"]
        delivered.extend(batch)
        return httpx.Response(202, json={"accepted": len(batch)})

    async with httpx.AsyncClient(transport=httpx.MockTransport(receive)) as client:
        while await exporter._flush_once(client):
            pass

    assert len(attempts) > 1
    assert any(size > 1024 * 1024 for size in attempts)
    assert delivered == events
    assert (tmp_path / "runtime-events.wal").read_text() == ""
    text = generate_latest(metrics.registry).decode()
    assert 'guard_runner_telemetry_export_batches_total{operation="events",result="too_large"}' in text
    assert "guard_runner_telemetry_wal_events 0.0" in text


@pytest.mark.asyncio
async def test_413_shrink_tracks_the_configured_body_default(tmp_path, monkeypatch):
    monkeypatch.setattr("runner.telemetry.MAX_BODY_BYTES", 4096)
    events = [{"id": f"event-{index}", "body": "x" * 100} for index in range(300)]
    (tmp_path / "runtime-events.wal").write_text("".join(_wal_line(event) for event in events))
    exporter = RuntimeTelemetryExporter("http://controller/events", "token", tmp_path, 1000, "runner-0")
    delivered = []

    def receive(request):
        if len(request.content) > 1024:
            return httpx.Response(413, json={"error": {"code": "telemetry_batch_too_large"}})
        batch = json.loads(request.content)["events"]
        delivered.extend(batch)
        return httpx.Response(202, json={"accepted": len(batch)})

    async with httpx.AsyncClient(transport=httpx.MockTransport(receive)) as client:
        while await exporter._flush_once(client):
            pass

    assert delivered == events
    assert exporter._body_limit <= 1024


@pytest.mark.asyncio
async def test_413_at_a_single_event_quarantines_then_drains_later_events(tmp_path):
    metrics = RunnerMetrics(8)
    first = {"id": "huge", "body": "x" * 5000}
    later = {"id": "later"}
    (tmp_path / "runtime-events.wal").write_text(_wal_line(first) + _wal_line(later))
    exporter = RuntimeTelemetryExporter(
        "http://controller/events", "token", tmp_path, 100, "runner-0", metrics,
    )
    delivered = []

    def receive(request):
        if len(request.content) > 1024:
            return httpx.Response(413, json={"error": {"code": "telemetry_batch_too_large"}})
        batch = json.loads(request.content)["events"]
        delivered.extend(batch)
        return httpx.Response(202, json={"accepted": len(batch)})

    async with httpx.AsyncClient(transport=httpx.MockTransport(receive)) as client:
        while await exporter._flush_once(client):
            pass

    assert delivered == [later]
    assert (tmp_path / "runtime-events.wal").read_text() == ""
    assert (tmp_path / "runtime-events.rejected.wal").read_text() == _wal_line(first)
    assert (
        'guard_runner_telemetry_quarantined_events_total{reason="unsendable"} 1.0'
        in generate_latest(metrics.registry).decode()
    )


@pytest.mark.asyncio
async def test_unsendable_retained_record_is_quarantined_without_rewriting(tmp_path):
    event = _metered_event("event-1", 130)
    (tmp_path / "runtime-events.wal").write_text(_wal_line(event))
    exporter = RuntimeTelemetryExporter("http://controller/events", "token", tmp_path, 100, "runner-0")

    def unexpected(_request):
        pytest.fail("An unsendable record must be identified before uploading.")

    async with httpx.AsyncClient(transport=httpx.MockTransport(unexpected)) as client:
        assert await exporter._flush_once(client) is False

    assert (tmp_path / "runtime-events.wal").read_text() == ""
    assert (tmp_path / "runtime-events.rejected.wal").read_text() == _wal_line(event)


@pytest.mark.asyncio
async def test_quarantine_file_cap_stops_growth_and_preserves_the_wal(tmp_path, monkeypatch):
    monkeypatch.setattr("runner.telemetry.MAX_REJECTED_WAL_BYTES", 10)
    (tmp_path / "runtime-events.rejected.wal").write_text("x" * 9)
    event = {"id": "huge", "body": "x" * 100}
    (tmp_path / "runtime-events.wal").write_text(_wal_line(event))
    exporter = RuntimeTelemetryExporter("http://controller/events", "token", tmp_path, 100, "runner-0")

    def unexpected(_request):
        pytest.fail("An unsendable record must be identified before uploading.")

    # Shrink the budget so the first event cannot fit any upload.
    exporter._body_limit = 8
    async with httpx.AsyncClient(transport=httpx.MockTransport(unexpected)) as client:
        with pytest.raises(RuntimeError, match="64 MiB bound"):
            await exporter._flush_once(client)

    assert (tmp_path / "runtime-events.wal").read_text() == _wal_line(event)
    assert (tmp_path / "runtime-events.rejected.wal").read_text() == "x" * 9


@pytest.mark.asyncio
async def test_413_on_a_single_selected_event_quarantines_immediately(tmp_path):
    metrics = RunnerMetrics(8)
    event = {"id": "solo", "body": "x" * 5000}
    (tmp_path / "runtime-events.wal").write_text(_wal_line(event))
    exporter = RuntimeTelemetryExporter(
        "http://controller/events", "token", tmp_path, 100, "runner-0", metrics,
    )
    attempts = []

    def receive(request):
        attempts.append(len(request.content))
        return httpx.Response(413, json={"error": {"code": "telemetry_batch_too_large"}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(receive)) as client:
        assert await exporter._flush_once(client) is False

    assert len(attempts) == 1
    assert (tmp_path / "runtime-events.wal").read_text() == ""
    assert (tmp_path / "runtime-events.rejected.wal").read_text() == _wal_line(event)
    assert 'guard_runner_telemetry_quarantined_events_total{reason="unsendable"} 1.0' in (
        generate_latest(metrics.registry).decode()
    )
