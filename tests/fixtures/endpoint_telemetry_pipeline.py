"""Drive real Endpoint callbacks and drain their WAL to a test Controller."""
from __future__ import annotations

import asyncio
import hashlib
import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

import httpx
from fastapi import FastAPI

from runner.api import RunnerAPI
from runner import generated as protocol
from runner.metrics import RunnerMetrics
from runner.providers import dynamic_runtime_action_providers
from runner.telemetry import RuntimeTelemetryExporter
from runner.toolkit.runtime.service import GuardrailRuntimeService
from tests.capability_binding import capability_binding
from tests.data_plane.test_artifact_execution import _runtime, FIXTURE, RUNTIME_CREDENTIAL


async def exercise(endpoint: str, token: str, scenario: str) -> dict:
    with TemporaryDirectory() as directory:
        state = Path(directory)
        if scenario == "models":
            profile = "tali.nemoguard-jailbreak-detect.v1"
            configuration = protocol.DataPlaneModelConfiguration(
                revision_id="fixture-models", revision=1,
                runtimes=[protocol.ModelRuntime(id="detector", base_url="http://fixture-provider/v1",
                    model="fixture-model", profile_ref=profile, credential_ref="fixture-provider", timeout_seconds=2)],
                bindings=[capability_binding(detector_type="jailbreak_detection", model_ref="detector",
                    profile_ref=profile, contract_refs=["tali.guard.jailbreak.v1"])],
            )
            # Only the remote model is simulated; routing, detection, metering,
            # HTTP event emission and the disk-backed exporter all run normally.
            providers = dynamic_runtime_action_providers(configuration, {"fixture-provider": "test-key"},
                transport=httpx.MockTransport(lambda _: httpx.Response(200, json={"jailbreak": False, "score": 0.01})))
            store, _, engine = _runtime(state, FIXTURE.parent / "jailbreak-v1", providers=providers)
            texts = [f"Summarize document {index}." for index in range(50)]
        else:
            store, _, engine = _runtime(state)
            store._logging_levels["fixture-secrets"] = "trace"
            texts = ["Summarize this document: " + "a" * 500_000]
        exporter = RuntimeTelemetryExporter(endpoint, token, state, 100, "fixture-runner")
        app = FastAPI()
        app.include_router(RunnerAPI(
            GuardrailRuntimeService(engine, store), store, RunnerMetrics(4), exporter,
            "fixture-runner", "internal-test-token",
            runtime_log_encryption_key=b"a" * 32,
        ).router)
        statuses = []
        uploads = []
        try:
            # A brief telemetry outage can accumulate several valid, individually
            # sendable events before the exporter resumes.
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
                for index in range(6):
                    response = await client.post(
                        "/runtime/v1/endpoints/fixture-endpoint/beta/litellm_basic_guardrail_api",
                        headers={"x-api-key": RUNTIME_CREDENTIAL},
                        json={"input_type": "request", "litellm_call_id": f"audit-{index}",
                              "texts": texts},
                    )
                    statuses.append(response.status_code)
                    assert response.status_code == 200, response.text

            wal = state / "runtime-events.wal"
            original = wal.read_text().splitlines()
            events = [json.loads(line) for line in original]
            runtime_events = [event for event in events if "requestId" in event]
            info = {"statuses": statuses, "generatedEvents": len(events),
                    "runtimeEventIds": [event["id"] for event in runtime_events],
                    "guardrailId": runtime_events[0]["guardrailId"],
                    "modelCalls": sum(len(event["metadata"].get("usage", {}).get("model_calls", [])) for event in runtime_events),
                    "ciphertextDigests": {event["id"]: hashlib.sha256(event["metadata"]["contentCiphertext"].encode()).hexdigest()
                        for event in runtime_events if event["metadata"].get("contentCiphertext")},
                    "routerId": next(event["routerId"] for event in events if "routerId" in event),
                    "batchBytes": len(json.dumps({"events": events}, separators=(",", ":")).encode())}
            # Node seeds the matching resource identities before permitting upload.
            print(json.dumps(info), flush=True)
            await asyncio.to_thread(sys.stdin.readline)

            async def record(response):
                uploads.append(response.status_code)

            async with httpx.AsyncClient(timeout=httpx.Timeout(30.0), event_hooks={"response": [record]}) as client:
                # A fixed bound also exposes the pre-fix repeated-413 stall.
                for _ in range(10):
                    try:
                        if not await exporter._flush_once(client):
                            break
                    except httpx.HTTPStatusError:
                        if len(uploads) >= 2:
                            break
            return {"uploads": uploads, "remainingEvents": len(wal.read_text().splitlines())}
        finally:
            await exporter.stop()
            await engine.shutdown()


if __name__ == "__main__":
    print(json.dumps(asyncio.run(exercise(*sys.argv[1:]))), flush=True)
