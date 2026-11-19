from __future__ import annotations

import json

import pytest

from runner.telemetry_budget import (
    MAX_BODY_BYTES,
    UnsendableTelemetryEvent,
    bounded_batch_size,
    split_metered_event,
)


def _event(event_id: str, calls: int, **extra) -> dict:
    event = {
        "id": event_id, "requestId": f"request-{event_id}", "runnerId": "runner-0",
        "occurredAt": "2026-11-05T00:00:00Z", "direction": "incoming",
        "decision": "allow", "durationMs": 1,
        "metadata": {"usage": {"model_calls": [{"call_id": f"{event_id}-{index}"} for index in range(calls)],
                               "model_invocations": calls}},
    }
    event.update(extra)
    return event


def test_metered_event_split_preserves_every_call_and_runtime_identity():
    event = _event("runtime-1", 130, endpointId="endpoint-1", allocationContextId="context-1")
    attribution = {"protocol": "litellm", "routerRevision": 3, "routeId": "route-1", "targetId": "target-1"}
    event["metadata"].update(attribution)
    parts = split_metered_event(event)
    assert [len(part["metadata"]["usage"]["model_calls"]) for part in parts] == [64, 64, 2]
    assert parts[0]["id"] == "runtime-1"
    assert parts[0]["metadata"]["usage"]["model_invocations"] == 130
    assert all(part["metadata"]["costOnly"] is True for part in parts[1:])
    assert [part["id"] for part in parts] == ["runtime-1", "runtime-1#cost-1", "runtime-1#cost-2"]
    assert all(part["allocationContextId"] == "context-1" and part["endpointId"] == "endpoint-1" for part in parts)
    assert all({key: part["metadata"][key] for key in attribution} == attribution for part in parts)
    assert [call["call_id"] for part in parts for call in part["metadata"]["usage"]["model_calls"]] == [
        f"runtime-1-{index}" for index in range(130)]
    assert split_metered_event(parts[0]) == [parts[0]]


def test_cost_only_event_keeps_its_source_and_protocol():
    event = _event("cost-1", 65, metadata={"costOnly": True, "costSource": "testing", "protocol": "playground",
                                           "usage": {"model_calls": [{} for _ in range(65)], "model_invocations": 65}})
    parts = split_metered_event(event)
    assert len(parts) == 2
    assert parts[1]["metadata"] == {"costOnly": True, "costSource": "testing", "protocol": "playground",
                                    "usage": {"model_calls": [{}], "model_invocations": 1}}


def test_events_without_identity_are_left_intact():
    assert split_metered_event({"id": "event", "metadata": {"usage": {"model_calls": [{}] * 65}}}) == [
        {"id": "event", "metadata": {"usage": {"model_calls": [{}] * 65}}}]


def test_bounded_batch_size_respects_the_event_batch_and_byte_budgets():
    events = [_event(str(index), 64) for index in range(5)]
    body = lambda count: {"events": events[:count]}
    assert bounded_batch_size(events, body) == 4  # 4 x 64 calls == 256
    assert bounded_batch_size(events[:3], body) == 3
    with pytest.raises(UnsendableTelemetryEvent):
        bounded_batch_size([_event("too-many", 65)], lambda count: {"events": [_event("too-many", 65)][:count]})


def test_bounded_batch_size_caps_at_1000_and_respects_an_upload_override():
    events = [{"id": str(index)} for index in range(1001)]
    body = lambda count: {"events": events[:count]}
    assert bounded_batch_size(events, body) == 1000
    assert bounded_batch_size([_event(str(index), 1) for index in range(10)], body, 1500) > 1


def test_bounded_batch_size_boundary_is_exact():
    event = {"id": "x", "metadata": {"pad": ""}}
    event["metadata"]["pad"] = "a" * 1_000
    assert bounded_batch_size([event], lambda count: {"events": [event][:count]}, 8 * 1024 * 1024) == 1
    with pytest.raises(UnsendableTelemetryEvent):
        bounded_batch_size([event], lambda count: {"events": [event][:count]}, 64)


def test_bounded_batch_size_rejects_invalid_limits():
    with pytest.raises(ValueError):
        bounded_batch_size([{"id": "x"}], lambda count: {"events": [{"id": "x"}][:count]}, 0)
    with pytest.raises(ValueError):
        bounded_batch_size([{"id": "x"}], lambda count: {"events": [{"id": "x"}][:count]}, MAX_BODY_BYTES + 1)
