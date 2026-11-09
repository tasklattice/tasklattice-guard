import asyncio
from types import SimpleNamespace

import pytest
from nemoguardrails.types import LLMResponse, UsageInfo

from runner.toolkit.nemo.actions.model_call import (
    ObservedNeMoModel, ModelCallTracker, begin_cost_collection, end_cost_collection,
)
from runner.api import _telemetry_metadata
from runner.toolkit.runtime.contracts import ProtectionDecision, RuntimeUsage


def tracker():
    return ModelCallTracker(SimpleNamespace(request_started_at=0), "provider", "guard-model", "judge", 0)


def test_missing_usage_is_not_zero_and_cache_tokens_are_preserved():
    call = tracker()
    call.complete(payload={"choices": []})
    assert call.usage.usage_known is False
    call.complete(payload={"usage": {"prompt_tokens": 0, "completion_tokens": 0}})
    assert call.usage.usage_known is True
    call.complete(payload={"usage": {"prompt_tokens": 120, "completion_tokens": 7, "prompt_tokens_details": {"cached_tokens": 80}}})
    assert call.usage.cached_input_tokens == 80
    assert call.usage.input_tokens == 120
    assert call.usage.call_id
    metadata = _telemetry_metadata(ProtectionDecision(decision="allow", action="allow", usage=RuntimeUsage(model_calls=(call.usage,), model_invocations=1)))
    assert metadata["usage"]["model_calls"][0]["cached_input_tokens"] == 80


def test_non_standard_service_tiers_are_not_mispriced_as_standard():
    call = tracker()
    call.complete(payload={"service_tier": "priority", "usage": {"prompt_tokens": 10, "completion_tokens": 1}})
    assert call.usage.unsupported_usage is True


@pytest.mark.asyncio
async def test_native_calls_keep_identity_cache_usage_and_isolated_cost_collections():
    class Model:
        model_name = "small"
        provider_name = "provider"
        provider_url = "https://example.test"
        async def generate_async(self, *args, **kwargs):
            await asyncio.sleep(0)
            return LLMResponse(content="ok", usage=UsageInfo(input_tokens=42, output_tokens=2, cached_tokens=20))
    async def run():
        calls, token = begin_cost_collection()
        try:
            await ObservedNeMoModel(Model(), "safety", "registered-model").generate_async("test")
        finally:
            end_cost_collection(token)
        return calls
    first, second = await asyncio.gather(run(), run())
    assert len(first) == len(second) == 1
    assert first[0].call_id != second[0].call_id
    assert first[0].runtime_ref == "registered-model"
    assert first[0].usage_known and first[0].cached_input_tokens == 20


@pytest.mark.asyncio
async def test_validation_failures_emit_costs_once_and_cached_replies_do_not_rebill():
    from unittest.mock import AsyncMock, Mock
    from runner.control_client import RunnerControlClient
    from runner import generated as protocol
    from runner.toolkit.nemo.actions.model_call import observe_native_model_call
    from tests.test_runner_control_client import Store, Metrics, _settings
    telemetry = SimpleNamespace(emit=AsyncMock())
    client = RunnerControlClient(_settings(), Store(), Metrics(), telemetry=telemetry)
    client._metrics.job = Mock()
    async def validate(*args, **kwargs):
        with observe_native_model_call(None, role="safety", provider="provider", model="guard-model", runtime_ref="registered") as call:
            call.complete(LLMResponse(content="safe", usage=UsageInfo(input_tokens=10, output_tokens=1)))
        raise ValueError("failed after a real model response")
    client._validator = SimpleNamespace(run=validate)
    request = protocol.ValidationRequest(run_id="priced-test", guardrail_id="guardrail-1")
    await client._validate(request)
    await client._validate(request)
    telemetry.emit.assert_awaited_once()
    event = telemetry.emit.call_args.args[0]
    assert event["guardrailId"] == "guardrail-1"
    assert event["metadata"]["costOnly"] is True
    assert event["metadata"]["costSource"] == "testing"
    assert event["metadata"]["usage"]["model_calls"][0]["input_tokens"] == 10
