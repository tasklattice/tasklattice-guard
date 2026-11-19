"""Drive the real Runtime telemetry exporter against a test Controller.

The fixture uses the Runner's disk-backed WAL transport with a batch size of
100 and emits metered events through the public
``RuntimeTelemetryExporter.emit`` path:
  * three ordinary Runtime events with two model calls each,
  * one Runtime event with 65 model calls (above the 64-call per-event budget),
  * one validation-style cost-only event with 300 model calls.

Emit-level splitting must turn the oversized events into a first chunk that
keeps the logical event identity and deterministic ``<id>#cost-<n>`` cost-only
companions. The fixture waits for the Node side to seed the claimed Controller
resources, drains the WAL, then replays the delivered WAL once more to prove
that Controller receipt and cost identities are idempotent.

It prints exactly two JSON lines: the logical event plan (before upload) and the
delivery result (uploads, per-event call counts, remaining WAL lines).
"""
from __future__ import annotations

import asyncio
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

import httpx

from runner.telemetry import RuntimeTelemetryExporter

RUNNER_ID = "fixture-runner"
GUARDRAIL_ID = "fixture-guardrail"
ENDPOINT_ID = "fixture-endpoint"
ROUTER_ID = "fixture-router"
GUARDRAIL_VERSION = "20260912-083000.123Z"
ROUTE_ID = "fixture-route"
TARGET_ID = "fixture-target"
BATCH_SIZE = 100


def _calls(prefix: str, count: int) -> list[dict[str, Any]]:
    return [{
        "call_id": f"{prefix}-call-{index}",
        "provider": "fixture-provider",
        "model": "fixture-model",
        "operation": "chat",
        "result": "success",
        "duration_ms": 1 + index,
        "input_tokens": 10 + index,
        "output_tokens": 1,
        "usage_known": True,
    } for index in range(count)]


def _usage(calls: list[dict[str, Any]], *, runtime: bool) -> dict[str, Any]:
    usage: dict[str, Any] = {"model_calls": calls, "model_invocations": len(calls)}
    if runtime:
        usage.update({"runtime_engine": "fixture-engine", "fail_closed": False,
            "queue_latency_ms": 1, "provider_latency_ms": 2, "active_concurrency": 1})
    return usage


def _runtime_event(event_id: str, request_id: str, calls: list[dict[str, Any]], *,
        decision: str = "allow", duration_ms: int = 12) -> dict[str, Any]:
    return {
        "id": event_id, "requestId": request_id, "runnerId": RUNNER_ID,
        "guardrailId": GUARDRAIL_ID, "guardrailVersion": GUARDRAIL_VERSION,
        "endpointId": ENDPOINT_ID, "routerId": ROUTER_ID,
        "occurredAt": datetime.now(UTC).isoformat(), "direction": "incoming",
        "decision": decision, "durationMs": duration_ms,
        "metadata": {"protocol": "litellm", "mode": "sync", "captureLevel": "info",
            "routerRevision": 1, "routeId": ROUTE_ID, "targetId": TARGET_ID,
            "usage": _usage(calls, runtime=True)},
    }


def _validation_cost_event(event_id: str, calls: list[dict[str, Any]]) -> dict[str, Any]:
    """Match the validation cost-only event emitted by the Runner control client."""
    return {
        "id": event_id, "requestId": "fixture-validation-run", "runnerId": RUNNER_ID,
        "guardrailId": GUARDRAIL_ID, "occurredAt": datetime.now(UTC).isoformat(),
        "direction": "incoming", "decision": "testing", "durationMs": 0,
        "metadata": {"costOnly": True, "costSource": "testing",
            "usage": _usage(calls, runtime=False)},
    }


def _logical_events() -> list[dict[str, Any]]:
    return [
        _runtime_event("fixture-runtime-1", "fixture-request-1", _calls("runtime-1", 2)),
        _runtime_event("fixture-runtime-2", "fixture-request-2", _calls("runtime-2", 2)),
        _runtime_event("fixture-runtime-3", "fixture-request-3", _calls("runtime-3", 2),
            decision="block", duration_ms=14),
        _runtime_event("fixture-runtime-large", "fixture-request-large", _calls("runtime-large", 65),
            duration_ms=20),
        _validation_cost_event("fixture-validation-300", _calls("validation", 300)),
    ]


def _wal_lines(path: Path) -> list[str]:
    if not path.exists():
        return []
    return [line for line in path.read_text(encoding="utf-8").splitlines() if line]


def _describe(line: str) -> dict[str, Any]:
    event = json.loads(line)
    metadata = event.get("metadata") if isinstance(event.get("metadata"), dict) else {}
    usage = metadata.get("usage") if isinstance(metadata.get("usage"), dict) else {}
    return {"id": event.get("id"), "costOnly": metadata.get("costOnly") is True,
        "calls": len(usage.get("model_calls") or []),
        "modelInvocations": usage.get("model_invocations")}


async def exercise(endpoint: str, token: str) -> dict[str, Any]:
    logical = _logical_events()
    info = {
        "runnerId": RUNNER_ID, "guardrailId": GUARDRAIL_ID, "guardrailVersion": GUARDRAIL_VERSION,
        "endpointId": ENDPOINT_ID, "routerId": ROUTER_ID, "routeId": ROUTE_ID, "targetId": TARGET_ID,
        "logicalEvents": [{"id": event["id"], "requestId": event["requestId"],
            "calls": len(event["metadata"]["usage"]["model_calls"]),
            "costOnly": event["metadata"].get("costOnly") is True} for event in logical],
    }
    with TemporaryDirectory() as directory:
        state = Path(directory)
        wal = state / "runtime-events.wal"
        exporter = RuntimeTelemetryExporter(endpoint, token, state, BATCH_SIZE)
        result: dict[str, Any] = {"uploads": [], "replayUploads": []}
        print(json.dumps(info), flush=True)
        # The Controller fixture allocates the Endpoint context before upload.
        context_id = (await asyncio.to_thread(sys.stdin.readline)).strip()
        assert context_id
        for event in logical:
            if "endpointId" in event:
                event["allocationContextId"] = context_id
        uploads: dict[str, list[dict[str, Any]]] = {"delivery": [], "replay": []}
        phase = {"name": "delivery"}

        async def record(response: httpx.Response) -> None:
            try:
                await response.aread()
                accepted = response.json().get("accepted")
            except Exception:
                accepted = None
            uploads[phase["name"]].append({"status": response.status_code, "accepted": accepted})

        try:
            async with httpx.AsyncClient(event_hooks={"response": [record]}) as client:
                try:
                    for event in logical:
                        await exporter.emit(event)
                    emitted = _wal_lines(wal)
                    result["walEvents"] = [_describe(line) for line in emitted]
                    # Drain under the Controller upload budgets (100 events per
                    # request, 256 model calls and 8 MiB per body).
                    for _ in range(10):
                        if not await exporter._flush_once(client):
                            break
                    result["remainingEvents"] = len(_wal_lines(wal))
                    # Simulate the lost-response window: the Controller committed
                    # the batch but the Runner had to replay the same WAL records.
                    with wal.open("a", encoding="utf-8") as stream:
                        stream.write("".join(f"{line}\n" for line in emitted))
                    # A restarted process recovers the replayed on-disk spool;
                    # do not mutate a live exporter's cached queue counters.
                    await exporter.stop()
                    exporter = RuntimeTelemetryExporter(endpoint, token, state, BATCH_SIZE)
                    phase["name"] = "replay"
                    for _ in range(10):
                        if not await exporter._flush_once(client):
                            break
                    result["remainingAfterReplay"] = len(_wal_lines(wal))
                except Exception as error:
                    result["drainError"] = f"{type(error).__name__}: {error}"
                    result["remainingEvents"] = len(_wal_lines(wal))
                finally:
                    result["uploads"] = uploads["delivery"]
                    result["replayUploads"] = uploads["replay"]
        finally:
            await exporter.stop()
        return result


if __name__ == "__main__":
    print(json.dumps(asyncio.run(exercise(*sys.argv[1:]))), flush=True)
