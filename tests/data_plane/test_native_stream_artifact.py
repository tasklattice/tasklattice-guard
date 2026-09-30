"""Signed Policy -> real NeMo streaming -> real model parser; only HTTP is fake."""
import json
from pathlib import Path

import httpx
import pytest

from runner import generated as protocol
from runner.providers import dynamic_runtime_action_providers
from runner.toolkit.nemo.native_streaming import NativeStreamError
from runner.toolkit.runtime.contracts import EngineRequest
from tests.data_plane.test_artifact_execution import _runtime


@pytest.mark.parametrize("family", ["nvidia", "qwen"])
@pytest.mark.parametrize("scenario", ["safe", "block", "http_failure", "invalid_response"])
async def test_native_stream_consumes_signed_policy_and_preserves_model_evidence(tmp_path, family, scenario):
    model, profile = (
        ("nvidia/llama-3.1-nemotron-safety-guard-8b-v3", "tali.nemotron-safety-guard-v3.v1")
        if family == "nvidia" else ("Qwen/Qwen3Guard-Gen-8B", "tali.qwen3guard.v1")
    )
    calls, decisions, delivered, observations = [], [], [], []

    class Observer:
        def model_call_started(self, **labels): observations.append(("start", labels))
        def model_call_finished(self, **labels): observations.append(("finish", labels))

    def classify(request):
        assert request.headers["authorization"] == "Bearer fixture-model-key"
        payload = json.loads(request.content)
        assert payload["model"] == model
        calls.append(payload)
        unsafe = "REGRESSION_UNSAFE" in json.dumps(payload["messages"])
        if unsafe and scenario == "http_failure":
            return httpx.Response(503, json={"error": "private provider body"})
        if unsafe and scenario == "invalid_response":
            return httpx.Response(200, json={"choices": [{"message": {"content": "not a classification"}}]})
        verdict = json.dumps({"User Safety": "safe", "Response Safety": "unsafe" if unsafe else "safe",
                              "Safety Categories": "Violence" if unsafe else ""}) if family == "nvidia" else (
            "Safety: Unsafe\nCategories: Violent" if unsafe else "Safety: Safe\nCategories: None")
        return httpx.Response(200, json={"choices": [{"message": {"content": verdict}}]})

    configuration = protocol.DataPlaneModelConfiguration(revision_id="native-stream-models", revision=1,
        runtimes=[protocol.ModelRuntime(id="safety", base_url="http://fixture-model/v1", model=model,
            profile_ref=profile, credential_ref="fixture-provider", timeout_seconds=2, max_tokens=128)],
        bindings=[protocol.CapabilityBinding(binding_id="content_safety.output", capability_ref="content_safety",
            rail_type=protocol.RAIL_TYPE_OUTPUT, implementation_ref="tali.runtime.safety-model.v1",
            model_ref="safety", profile_ref=profile, contract_refs=["tali.guard.content-safety.v1"])])
    providers = dynamic_runtime_action_providers(configuration, {"fixture-provider": "fixture-model-key"},
        transport=httpx.MockTransport(classify))
    fixture = Path(__file__).resolve().parents[1] / "fixtures" / "artifacts" / "stream-safety-window_buffered-v1"
    store, registry, engine = _runtime(tmp_path, fixture, providers=providers)
    engine._model_call_observer = Observer()
    plan = store.plan(*store.active_plan_keys()[0])
    request = EngineRequest(phase="output", text="", plan=plan,
                            context_messages=({"role": "user", "content": "Tell me a story."},))
    # First 200 iterator items pass. The marker straddles the next native
    # window, so the 50-item context must catch it before the suffix is released.
    parts = ["ordinary "] * 199 + ["ordinary " if scenario == "safe" else "REGRESSION_"]
    parts += ["ordinary " if scenario == "safe" else "UNSAFE"] + ["ordinary "] * 149
    closed = False

    async def source():
        nonlocal closed
        try:
            for part in parts:
                yield part
        finally:
            closed = True

    async def emit(text): delivered.append(text)
    async def observe(decision): decisions.append(decision)
    try:
        if scenario in {"http_failure", "invalid_response"}:
            with pytest.raises(NativeStreamError) as error:
                await engine.stream_output(request, source(), emit=emit, observe=observe)
            assert "private" not in str(error.value)
            assert decisions[-1].usage.fail_closed
        else:
            result = await engine.stream_output(request, source(), emit=emit, observe=observe)
            assert result.status == ("completed" if scenario == "safe" else "blocked")
            assert result.checks == len(calls) == len(decisions)
            assert not decisions[-1].usage.fail_closed
        assert closed
        assert "".join(delivered) == "".join(parts if scenario == "safe" else parts[:200])
        assert all(decision.usage.model_invocations == 1 for decision in decisions)
        assert len(observations) == 2 * len(calls)
        assert all(decision.usage.action_invocations == 1 for decision in decisions)
        if scenario == "block":
            assert decisions[-1].decision == "block"
            finding = decisions[-1].findings[0]
            assert finding.policy_id == "builtin-content-safety" and finding.rule_id
            assert finding.provider_evidence
        assert registry.get(plan).active_requests == 0 and registry.readiness()["ready"]
    finally:
        await engine.shutdown()
