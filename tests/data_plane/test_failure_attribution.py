"""Model protocol health is independent of Guard correctness and test quality."""
from dataclasses import asdict
import asyncio
import json
from pathlib import Path

import httpx
import pytest

from runner import generated as protocol
from runner.api import _telemetry_metadata
from runner.protocol_codec import validation_case_result_to_proto
from runner.providers import dynamic_runtime_action_providers
from runner.toolkit.nemo.actions.model_call import (model_failure, observe_model_call, ObservedNeMoModel,
    activate_native_model_observation, deactivate_native_model_observation)
from runner.toolkit.runtime.contracts import EngineRequest
from runner.toolkit.runtime.failures import ModelResponseError, model_response
from tests.data_plane.test_artifact_execution import _runtime
from tests.classifier_cases import jailbreak_request

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures/artifacts/stream-safety-window_buffered-v1"


def providers(handler):
    config = protocol.DataPlaneModelConfiguration(revision_id="failure-attribution", revision=1,
        runtimes=[protocol.ModelRuntime(id="safety", base_url="http://model.test/v1", model="Qwen/Qwen3Guard-Gen-8B",
            profile_ref="tali.qwen3guard.v1", credential_ref="fixture-provider", timeout_seconds=2, max_tokens=128)],
        bindings=[protocol.CapabilityBinding(binding_id="content_safety.output", capability_ref="content_safety",
            rail_type=protocol.RAIL_TYPE_OUTPUT, implementation_ref="tali.runtime.safety-model.v1",
            model_ref="safety", profile_ref="tali.qwen3guard.v1", contract_refs=["tali.guard.content-safety.v1"])])
    return dynamic_runtime_action_providers(config, {"fixture-provider": "private-key"}, transport=httpx.MockTransport(handler))


def answer():
    return httpx.Response(200, json={"choices": [{"message": {"content": "Safety: Safe\nCategories: None"}}]})


@pytest.mark.parametrize("fault,source,category,status", [
    (503,"model","unavailable",503), (401,"configuration","authentication",401),
    (403,"configuration","permission",403), (429,"model","rate_limit",429),
    ("timeout","model","timeout",None), ("json","model","json_decode",None),
    ("schema","model","response_schema",None), ("label","model","response_schema",None),
])
async def test_model_fault_survives_real_runtime_telemetry_and_report_wire(tmp_path, monkeypatch, fault, source, category, status):
    monkeypatch.setattr('runner.toolkit.nemo.actions.model_retry._rate_limit_attempts', 1)
    def respond(request):
        if isinstance(fault, int): return httpx.Response(fault, text="private provider error")
        if fault == "timeout": raise httpx.ReadTimeout("private timeout", request=request)
        if fault == "json": return httpx.Response(200, text="private invalid JSON")
        if fault == "schema": return httpx.Response(200, json={"choices": []})
        return httpx.Response(200, json={"choices": [{"message": {"content": "invalid classification"}}]})
    actions = providers(respond)
    store, _, engine = _runtime(tmp_path, FIXTURE, providers=actions)
    plan = store.plan(*store.active_plan_keys()[0])
    try:
        result = await engine.evaluate(EngineRequest(phase="output", text="synthetic input", plan=plan))
        assert result.execution_status in {"error", "timeout"}
        assert result.model_status == "error"
        calls = [s for s in result.trace if s.kind == "evaluator" and s.model_call_id and s.model_result]
        assert len(calls) == 1
        failed = calls[0]
        assert (failed.error_source, failed.error_category, failed.http_status) == (source, category, status)
        assert failed.affects_result and failed.provider_name and failed.model_name
        assert not any(s.error_source == "guard" for s in result.trace)
        event = _telemetry_metadata(result)
        assert any(d["source"] == source and d["httpStatus"] == status for d in event["diagnostics"])
        wire = validation_case_result_to_proto({"caseId":"fault", "expectedDecision":"allow", "actualDecision":result.decision,
            "phase":"output", "action":result.action, "trace":[asdict(s) for s in result.trace], "modelStatus":result.model_status,
            "executionStatus":result.execution_status, "evidenceStatus":"unverifiable"})
        decoded = protocol.ValidationCaseResult.FromString(wire.SerializeToString())
        recorded = next(s for s in decoded.trace if s.model_call_id == failed.model_call_id and s.model_result)
        assert recorded.error_source == source and recorded.error_category == category
        assert recorded.HasField("http_status") is (status is not None)
        assert "private" not in json.dumps(event)
    finally:
        await engine.shutdown()


def test_internal_type_error_is_not_a_model_schema_error():
    _, failure = model_failure(TypeError("internal guard bug"))
    assert (failure.source, failure.category) == ("guard", "internal")
    with pytest.raises(ModelResponseError) as caught:
        with model_response():
            json.loads('{private malformed response')
    _, failure = model_failure(caught.value)
    assert (failure.source, failure.category) == ("model", "json_decode")
    assert "private" not in str(caught.value)


@pytest.mark.parametrize("raw,category", [
    ("Safety: Controversial\nCategories: Violent", "model_uncertain"),
    ("Safety: Unsafe\nCategories: private unmapped category", "category_mapping"),
])
async def test_inconclusive_model_result_retains_specific_cause_without_claiming_missing_context(tmp_path, raw, category):
    actions = providers(lambda _: httpx.Response(200, json={"choices": [{"message": {"content": raw}}]}))
    store, _, engine = _runtime(tmp_path, FIXTURE, providers=actions)
    try:
        decision = await engine.evaluate(EngineRequest(phase="output", text="private request content",
            plan=store.plan(*store.active_plan_keys()[0])))
        # This artifact's existing unknown policy blocks conclusively. Retain
        # the classification cause without turning that policy action into an error.
        assert decision.execution_status == "complete"
        assert decision.decision == "block"
        assert decision.model_status == "ok"
        cause = next(d for d in decision.diagnostics if d.category == category)
        assert not cause.affects_result and cause.source == "model"
        assert cause.step_id in {step.id for step in decision.trace}
        assert cause.model_call_id == decision.usage.model_calls[-1].call_id
        assert not any(d.source == "configuration" or d.code == "needs_context" for d in decision.diagnostics)
        event = _telemetry_metadata(decision)
        assert any(d["category"] == category for d in event["diagnostics"])
        assert "private" not in json.dumps(event)
    finally:
        await engine.shutdown()


def test_guard_failure_after_valid_response_keeps_model_call_successful():
    with pytest.raises(TypeError):
        with observe_model_call(jailbreak_request(), provider="provider", model="judge", operation="classify") as call:
            call.complete(payload={})
            raise TypeError("Guard postprocessing failed")
    assert call.usage.result == "success" and call.usage.error_source is None


async def test_guard_action_crash_after_valid_model_response_keeps_root_cause_local(tmp_path, monkeypatch):
    actions = providers(lambda _: answer())
    def crash(*args, **kwargs):
        raise TypeError('private Guard postprocessing error')
    monkeypatch.setattr('runner.toolkit.nemo.runtime._decision', crash)
    store, _, engine = _runtime(tmp_path, FIXTURE, providers=actions)
    plan = store.plan(*store.active_plan_keys()[0])
    try:
        decision = await engine.evaluate(EngineRequest(phase='output', text='synthetic', plan=plan))
        assert decision.execution_status == 'error'
        assert decision.model_status == 'ok'
        assert decision.usage.model_invocations == 1
        assert all(c.result == 'success' for c in decision.usage.model_calls)
        assert any(d.source == 'guard' and d.affects_result for d in decision.diagnostics)
        assert not any(d.source == 'model' for d in decision.diagnostics)
    finally:
        await engine.shutdown()


@pytest.mark.parametrize("fault,source,category,status", [
    (503,"model","unavailable",503), (401,"configuration","authentication",401),
    (403,"configuration","permission",403), (429,"model","rate_limit",429),
    ("timeout","model","timeout",None), ("connection","model","connection",None),
    ("json","model","json_decode",None), ("schema","model","response_schema",None),
    ("label","model","response_schema",None),
])
async def test_native_client_error_types_use_the_same_fault_contract(fault, source, category, status):
    from nemoguardrails.llm.clients.openai_compatible import OpenAICompatibleClient
    from nemoguardrails.llm.models.openai_chat import OpenAIChatModel
    import time

    def respond(request):
        if isinstance(fault, int): return httpx.Response(fault, text="private provider error")
        if fault == "timeout": raise httpx.ReadTimeout("private timeout", request=request)
        if fault == "connection": raise httpx.ConnectError("private connection", request=request)
        if fault == "json": return httpx.Response(200, text="private invalid JSON")
        if fault == "schema": return httpx.Response(200, json={"choices": []})
        return httpx.Response(200, json={"choices": [{"message": {"content": "maybe"}}]})

    scope, token = activate_native_model_observation(guardrail_id="guard", endpoint_id="endpoint",
        phase="input", request_started_at=time.perf_counter())
    try:
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
            client = OpenAICompatibleClient("https://model.test/v1", api_key="private", http_client=http, max_retries=0)
            model = ObservedNeMoModel(OpenAIChatModel(client, "topic-model"), "topic_control")
            with pytest.raises(Exception):
                await model.generate_async("synthetic input")
        assert len(scope.calls) == 1
        call = scope.calls[0]
        assert (call.error_source, call.error_category, call.http_status) == (source, category, status)
        assert "private" not in json.dumps(asdict(call))
    finally:
        deactivate_native_model_observation(token)


@pytest.mark.parametrize("workers", [1, 3])
async def test_reused_native_workers_keep_model_evidence_in_its_own_request(workers):
    from nemoguardrails.guardrails.async_work_queue import AsyncWorkQueue
    from nemoguardrails.types import LLMResponse
    from runner.toolkit.nemo.queue_context import install_work_queue_context
    import time

    class Model:
        model_name, provider_name, provider_url = "topic", "fixture", "https://model.test"

        async def generate_async(self, prompt, **kwargs):
            await asyncio.sleep(0)
            return LLMResponse(content=prompt)

    install_work_queue_context()
    model = ObservedNeMoModel(Model(), "topic_control")
    scopes = []
    async with AsyncWorkQueue("attribution-test", max_queue_size=10, max_concurrency=workers) as queue:
        async def check(index):
            scope, token = activate_native_model_observation(guardrail_id=f"guard-{index}", endpoint_id="endpoint",
                phase="input", request_started_at=time.perf_counter())
            try:
                if index % 2:
                    with pytest.raises(ModelResponseError):
                        await queue.submit(model.generate_async, "invalid")
                else:
                    await queue.submit(model.generate_async, "on-topic")
                assert len(scope.calls) == 1
                assert scope.calls[0].result == ("invalid_response" if index % 2 else "success")
                scopes.append(scope)
            finally:
                deactivate_native_model_observation(token)
        await asyncio.gather(*(check(index) for index in range(4)))
        await asyncio.gather(*(check(index) for index in range(4, 8)))
    assert all(len(scope.calls) == 1 for scope in scopes)
    assert len({scope.calls[0].call_id for scope in scopes}) == 8
