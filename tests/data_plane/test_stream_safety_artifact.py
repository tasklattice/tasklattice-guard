"""Real WebSocket -> signed Policy -> NeMo -> parser, with synthetic model HTTP."""
import json

import httpx
import pytest

from runner import generated as protocol
from runner.providers import dynamic_runtime_action_providers
from tests.stream_client import connection, exchange, released, runner


def safety_providers(family, *, base_url="http://fixture-model/v1", transport=None):
    model, profile = (
        ("nvidia/llama-3.1-nemotron-safety-guard-8b-v3", "tali.nemotron-safety-guard-v3.v1")
        if family == "nvidia" else ("Qwen/Qwen3Guard-Gen-8B", "tali.qwen3guard.v1"))
    configuration = protocol.DataPlaneModelConfiguration(revision_id="stream-models", revision=1,
        runtimes=[protocol.ModelRuntime(id="safety", base_url=base_url, model=model,
            profile_ref=profile, credential_ref="fixture-provider", timeout_seconds=3, max_tokens=128)],
        bindings=[protocol.CapabilityBinding(binding_id="content_safety.output", capability_ref="content_safety",
            rail_type=protocol.RAIL_TYPE_OUTPUT, implementation_ref="tali.runtime.safety-model.v1",
            model_ref="safety", profile_ref=profile, contract_refs=["tali.guard.content-safety.v1"])])
    return dynamic_runtime_action_providers(configuration, {"fixture-provider": "fixture-model-key"}, transport=transport)


def classification(family, unsafe):
    text = json.dumps({"User Safety": "safe", "Response Safety": "unsafe" if unsafe else "safe",
                      "Safety Categories": "Violence" if unsafe else ""}) if family == "nvidia" else (
        "Safety: Unsafe\nCategories: Violent" if unsafe else "Safety: Safe\nCategories: None")
    return {"choices": [{"message": {"content": text}}]}


def fragments(safe):
    return ["benign "] * 199 + (["ordinary ", "answer "] if safe else ["REGRESSION_", "UNSAFE"]) + ["benign "] * 149


@pytest.mark.parametrize("mode", ["window_buffered", "interruptible", "full_buffered"])
@pytest.mark.parametrize("family", ["nvidia", "qwen"])
@pytest.mark.parametrize("scenario", ["safe", "block", "http_failure", "invalid_response"])
async def test_signed_stream_releases_native_windows_and_never_retries_failed_checks(tmp_path, mode, family, scenario):
    calls = []
    def classify(request):
        assert request.headers["authorization"] == "Bearer fixture-model-key"
        payload = json.loads(request.content)
        calls.append(payload)
        unsafe = "REGRESSION_UNSAFE" in json.dumps(payload["messages"])
        if unsafe and scenario == "http_failure":
            return httpx.Response(503, json={"error": "private fixture backend"})
        if unsafe and scenario == "invalid_response":
            return httpx.Response(200, json={"choices": [{"message": {"content": "not a classification"}}]})
        return httpx.Response(200, json=classification(family, unsafe))

    providers = safety_providers(family, transport=httpx.MockTransport(classify))
    parts = fragments(scenario == "safe")
    async with runner(tmp_path, f"stream-safety-{mode}-v1", providers=providers) as (url, _, registry, telemetry, _):
        async with connection(url, messages=[{"role": "user", "content": "Tell me a story."}]) as (socket, ready):
            assert ready["type"] == "ready", ready
            assert ready["effective_release_id"] and ready["requested_mode"] == mode
            assert ready["mode"] == ("full_buffered" if mode == "full_buffered" else "window_buffered")
            events = await exchange(socket, parts)
        terminal = events[-1]
        assert terminal["type"] == ("completed" if scenario == "safe" else "blocked" if scenario == "block" else "error")
        expected = "".join(parts) if scenario == "safe" else "" if mode == "full_buffered" else "".join(parts[:200])
        assert released(events) == expected
        assert "REGRESSION_UNSAFE" not in released(events)
        assert "private fixture" not in json.dumps(events)
        assert len(calls) == (1 if mode == "full_buffered" else 3 if scenario == "safe" else 2)
        assert terminal["checks"] == len(calls)
        assert registry.readiness()["ready"] and telemetry.events
        assert all(event["metadata"]["usage"]["model_invocations"] == 1 for event in telemetry.events
                   if "usage" in event["metadata"])
