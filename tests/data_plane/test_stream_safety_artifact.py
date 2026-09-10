"""Real signed artifacts, NeMo, provider parsers and stream HTTP; synthetic model
transport only. These are deterministic execution tests, not safety-quality tests.
"""
from pathlib import Path
import json

import httpx
import pytest
from fastapi import FastAPI

from runner import generated as protocol
from runner.api import RunnerAPI
from runner.metrics import RunnerMetrics
from runner.providers import dynamic_runtime_action_providers
from runner.toolkit.runtime.context import CallContextStore
from runner.toolkit.runtime.service import GuardrailRuntimeService
from tests.data_plane.test_artifact_execution import _runtime, RUNTIME_CREDENTIAL, Telemetry


@pytest.mark.parametrize("mode", ["window_buffered", "interruptible", "full_buffered"])
@pytest.mark.parametrize("family", ["nvidia", "qwen"])
@pytest.mark.parametrize("scenario", ["safe", "block", "http_failure", "invalid_response"])
async def test_signed_output_policy_stream_release_and_failure_retry(tmp_path, mode, family, scenario):
    prefix = "benign " * 600
    marker = "REGRESSION_UNSAFE"
    fragments = [prefix, "REGRESSION_", "UNSAFE"] if scenario != "safe" else [prefix, "ordinary ", "answer"]
    model = "nvidia/llama-3.1-nemotron-safety-guard-8b-v3" if family == "nvidia" else "Qwen/Qwen3Guard-Gen-8B"
    profile = "tali.nemotron-safety-guard-v3.v1" if family == "nvidia" else "tali.qwen3guard.v1"
    calls = []
    fault_pending = scenario in {"http_failure", "invalid_response"}

    def classify(request):
        nonlocal fault_pending
        assert request.url.path == "/v1/chat/completions"
        assert request.headers["authorization"] == "Bearer fixture-model-key"
        payload = json.loads(request.content)
        assert payload["model"] == model
        calls.append(payload)
        unsafe = marker in json.dumps(payload["messages"])
        if unsafe and fault_pending:
            fault_pending = False
            return httpx.Response(503, json={"error": "private fixture backend"}) if scenario == "http_failure" else httpx.Response(
                200, json={"choices": [{"message": {"content": "not a classification"}}]})
        verdict = json.dumps({"User Safety": "safe", "Response Safety": "unsafe" if unsafe else "safe",
            "Safety Categories": "Violence" if unsafe else ""}) if family == "nvidia" else (
            "Safety: Unsafe\nCategories: Violent" if unsafe else "Safety: Safe\nCategories: None")
        return httpx.Response(200, json={"choices": [{"message": {"content": verdict}}]})

    configuration = protocol.DataPlaneModelConfiguration(revision_id="fixture-stream-models", revision=1,
        runtimes=[protocol.ModelRuntime(id="safety", base_url="http://fixture-model/v1", model=model,
            profile_ref=profile, credential_ref="fixture-provider", timeout_seconds=2, max_tokens=128)],
        bindings=[protocol.CapabilityBinding(binding_id="content_safety.output", capability_ref="content_safety",
            rail_type=protocol.RAIL_TYPE_OUTPUT, implementation_ref="tali.runtime.safety-model.v1",
            model_ref="safety", profile_ref=profile, contract_refs=["tali.guard.content-safety.v1"])])
    providers = dynamic_runtime_action_providers(configuration, {"fixture-provider": "fixture-model-key"},
        transport=httpx.MockTransport(classify))
    fixture = Path(__file__).resolve().parents[1] / "fixtures" / "artifacts" / f"stream-safety-{mode}-v1"
    store, registry, engine = _runtime(tmp_path, fixture, providers=providers)
    telemetry = Telemetry()
    app = FastAPI()
    app.include_router(RunnerAPI(GuardrailRuntimeService(engine, store, contexts=CallContextStore()),
        store, RunnerMetrics(4), telemetry, "fixture-stream", "fixture-controller-token").router)
    endpoint = "/runtime/v1/endpoints/fixture-endpoint/guardrails/output-stream"
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
            async def send(sequence):
                return await client.post(endpoint, headers={"x-api-key": RUNTIME_CREDENTIAL}, json={
                    "stream_id": "safety-stream", "sequence": sequence, "text": fragments[sequence],
                    "final": sequence == 2, "protocol": "litellm", "messages": [{"role": "user", "content": "Tell me a story."}],
                })

            released = ""
            release_id = None
            for sequence in (0, 1):
                response = await send(sequence)
                assert response.status_code == 200, response.text
                data = response.json()
                assert data["mode"] == data["requested_mode"] == mode
                assert not data["terminate"]
                assert data["effective_release_id"]
                release_id = release_id or data["effective_release_id"]
                assert data["effective_release_id"] == release_id
                released += data["released_text"]
            expected_prefix = "" if mode == "full_buffered" else prefix[:-2048] if mode == "window_buffered" else "".join(fragments[:2])
            assert released == expected_prefix
            assert len(calls) == {"full_buffered": 0, "window_buffered": 1, "interruptible": 2}[mode]

            response = await send(2)
            if scenario in {"http_failure", "invalid_response"}:
                assert response.status_code == 502, response.text
                assert "released_text" not in response.json()
                assert "private fixture" not in response.text and marker not in response.text
                failed_payload = calls[-1]
                # Real parser/action failure did not commit the chunk. Retry
                # the same final sequence; the accumulated candidate is exact.
                response = await send(2)
                assert calls[-1] == failed_payload
            assert response.status_code == 200, response.text
            final = response.json()
            assert final["effective_release_id"] == release_id
            assert final["decision"]["usage"]["model_invocations"] == 1
            assert final["decision"]["usage"]["fail_closed"] is False
            if scenario == "safe":
                assert final["status"] == "completed"
                assert released + final["released_text"] == "".join(fragments)
            else:
                assert final["status"] == "blocked" and final["terminate"] is True
                assert final["released_text"] == ""
                assert marker not in released
            assert registry.readiness()["ready"] is True
            assert telemetry.events
    finally:
        await engine.shutdown()
