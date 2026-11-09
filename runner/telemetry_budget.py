"""Controller upload budgets for Runtime telemetry batches."""
from __future__ import annotations

import json
from typing import Callable

MAX_BODY_BYTES = 8 * 1024 * 1024
MAX_BODY_DEPTH = 64
MAX_STRUCTURAL_TOKENS = 100_000
MAX_EVENT_MODEL_CALLS = 64
MAX_BATCH_MODEL_CALLS = 256


class UnsendableTelemetryEvent(RuntimeError):
    """A retained event cannot fit the Controller upload contract."""


def bounded_batch_size(
    events: list[dict], body_for_count: Callable[[int], dict], max_body_bytes: int | None = None,
) -> int:
    """Select the largest WAL prefix that fits one Controller upload."""
    limit = MAX_BODY_BYTES if max_body_bytes is None else max_body_bytes
    if type(limit) is not int or not 1 <= limit <= MAX_BODY_BYTES:
        raise ValueError("Telemetry upload body budget must be a positive integer within the server default.")
    cumulative_calls = [0]
    invalid_event = []
    for event in events:
        metadata = event.get("metadata")
        usage = metadata.get("usage") if isinstance(metadata, dict) else None
        calls = usage.get("model_calls") if isinstance(usage, dict) else None
        count = len(calls) if isinstance(calls, list) else 0
        cumulative_calls.append(cumulative_calls[-1] + count)
        invalid_event.append(count > MAX_EVENT_MODEL_CALLS or (invalid_event[-1] if invalid_event else False))

    def fits(count):
        if invalid_event[count - 1] or cumulative_calls[count] > MAX_BATCH_MODEL_CALLS:
            return False
        return _within_body_budget(
            json.dumps(body_for_count(count), sort_keys=True, separators=(",", ":"), allow_nan=False), limit,
        )

    # Prefix budgets are monotonic; binary search avoids serializing every
    # growing prefix of a backlog. The HTTP contract caps every batch at 1000.
    low, high, selected = 1, min(len(events), 1000), 0
    while low <= high:
        middle = (low + high) // 2
        if fits(middle):
            selected, low = middle, middle + 1
        else:
            high = middle - 1
    if not selected:
        raise UnsendableTelemetryEvent(
            "First retained telemetry event exceeds server work/structure/byte limits; preserve WAL for reconciliation.",
        )
    return selected


def split_metered_event(event: dict, limit: int = MAX_EVENT_MODEL_CALLS) -> list[dict]:
    """Keep one logical event within the Controller's per-event work budget.

    The first chunk keeps the original event identity and model_invocations so
    Runtime statistics remain correct. Remaining calls become deterministic
    cost-only companions, so every provider call is still priced exactly once.
    """
    if type(limit) is not int or limit < 1:
        raise ValueError("Telemetry metered-event budget must be a positive integer.")
    metadata = event.get("metadata")
    usage = metadata.get("usage") if isinstance(metadata, dict) else None
    calls = usage.get("model_calls") if isinstance(usage, dict) else None
    if not isinstance(calls, list) or len(calls) <= limit:
        return [event]
    identity = ("id", "requestId", "runnerId", "occurredAt", "direction")
    if not all(isinstance(event.get(key), str) and event.get(key) for key in identity):
        return [event]
    chunks = [calls[offset:offset + limit] for offset in range(0, len(calls), limit)]
    main = dict(event)
    main["metadata"] = {**metadata, "usage": {**usage, "model_calls": chunks[0]}}
    cost_source = metadata.get("costSource")
    if not isinstance(cost_source, str) or not cost_source:
        cost_source = "testing" if metadata.get("costOnly") is True else "runtime"
    decision = event.get("decision")
    if not isinstance(decision, str) or not decision:
        decision = "testing"
    companion_metadata = {"costOnly": True, "costSource": cost_source}
    if isinstance(metadata.get("protocol"), str):
        # Playground attribution reads this from each event's metadata.
        companion_metadata["protocol"] = metadata["protocol"]
    events = [main]
    for index, chunk in enumerate(chunks[1:], start=1):
        companion = {
            "id": f"{event['id']}#cost-{index}",
            "requestId": event["requestId"], "runnerId": event["runnerId"],
            "occurredAt": event["occurredAt"], "direction": event["direction"],
            "decision": decision, "durationMs": 0,
            "metadata": {**companion_metadata,
                         "usage": {**usage, "model_calls": chunk, "model_invocations": len(chunk)}},
        }
        for key in ("guardrailId", "guardrailVersion", "endpointId", "routerId", "allocationContextId"):
            if key in event:
                companion[key] = event[key]
        events.append(companion)
    return events


def _within_body_budget(encoded: str, max_body_bytes: int | None = None) -> bool:
    limit = MAX_BODY_BYTES if max_body_bytes is None else max_body_bytes
    if len(encoded.encode()) > limit:
        return False
    quoted = escaped = False
    depth = tokens = 0
    for character in encoded:
        if quoted:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                quoted = False
        elif character == '"':
            quoted = True
        elif character in "{[":
            depth += 1
            tokens += 1
            if depth > MAX_BODY_DEPTH:
                return False
        elif character in "}]":
            depth -= 1
            tokens += 1
        elif character in ",:":
            tokens += 1
        if tokens > MAX_STRUCTURAL_TOKENS:
            return False
    return True
