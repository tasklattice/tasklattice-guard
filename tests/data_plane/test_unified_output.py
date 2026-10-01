"""Complete and streamed output use the same pinned NeMo execution boundary."""
import asyncio
from dataclasses import replace
from pathlib import Path
from unittest.mock import AsyncMock, Mock

import pytest

from runner.toolkit.runtime.content_views import content_view, text_blocks
from runner.toolkit.runtime.contracts import EngineRequest
from runner.toolkit.runtime.streaming import OutputStreamEvaluationError
from tests.control_plane.test_native_output_stream import build, plan, source
from tests.data_plane.test_artifact_execution import _runtime


@pytest.mark.parametrize("fixture,text,expected", [
    ("configured-phrases-v1", "normal reply", "normal reply"),
    ("configured-phrases-v1", "internal-name", "public-name"),
    ("configured-phrases-v1", "confidential", None),
    ("default-local-v1", "Email: alice@example.com", "Email: [email_REDACTED]"),
    ("custom-dynamic-flow-events-v1", "check", None),
    ("custom-dynamic-flow-events-v1", "ordinary", "ordinary"),
])
async def test_frozen_policy_checks_complete_and_fragmented_output_once(tmp_path, monkeypatch, fixture, text, expected):
    store, registry, engine = _runtime(tmp_path, Path(__file__).resolve().parents[1] / "fixtures/artifacts" / fixture)
    candidate = store.plan(*store.active_plan_keys()[0])
    acquire = Mock(wraps=registry.acquire)
    protect = AsyncMock(wraps=engine.protect_output)
    monkeypatch.setattr(registry, "acquire", acquire)
    monkeypatch.setattr(engine, "protect_output", protect)
    request = EngineRequest(phase="output", text=text, plan=candidate, target_source="model_output")
    try:
        complete = await engine.evaluate(request)
        protect.assert_awaited_once()
        assert acquire.call_count == 1
        # Streaming starts with an empty active output block. The completed
        # view must match the normal check, including transformation offsets.
        placeholder = text_blocks("output", ("",), "model_output")
        fragmented = replace(request, text="", content_view=content_view(placeholder, placeholder[0].id),
                             active_block_id=placeholder[0].id)
        observed, delivered, contracts = [], [], []
        async def observe(decision): observed.append(decision)
        async def emit(part): delivered.append(part)
        async def ready(contract): contracts.append(contract)
        result = await engine.protect_output(fragmented, source(*text),
            observe=observe, emit=emit, ready=ready)
        assert acquire.call_count == 2  # One acquisition per request, including ready.
        assert contracts[0].effective_mode == "full_buffered"
        assert result.checks == len(observed) == 1
        decision = observed[0]
        assert not complete.usage.fail_closed and not decision.usage.fail_closed
        assert (complete.decision, complete.action, complete.texts, complete.findings) == (
            decision.decision, decision.action, decision.texts, decision.findings)
        assert complete.usage.action_invocations == decision.usage.action_invocations
        assert "".join(delivered) == (expected or "")
        assert result.status == ("blocked" if expected is None else "completed")
    finally:
        await engine.shutdown()


@pytest.mark.parametrize("delivery", ["window_buffered", "full_buffered"])
@pytest.mark.parametrize("failure", ["ready", "source-timeout", "cancel-source"])
async def test_both_modes_close_source_when_setup_or_consumption_fails(delivery, failure):
    engine, provider, registry, request, _ = build(plan(delivery=delivery))

    class Source:
        consumed = 0
        closed = False
        entered = asyncio.Event()
        def __aiter__(self): return self
        async def __anext__(self):
            self.consumed += 1
            self.entered.set()
            await asyncio.Event().wait()
        async def aclose(self): self.closed = True

    incoming = Source()
    async def ready(_):
        if failure == "ready": raise ValueError("private transport failure")
    async def emit(_): pytest.fail("Failed output cannot release content")
    task = asyncio.create_task(engine.protect_output(request, incoming, emit=emit, ready=ready,
        timeout_seconds=.05 if failure == "source-timeout" else 2))
    try:
        if failure == "cancel-source":
            await asyncio.wait_for(incoming.entered.wait(), 1)
            task.cancel()
        with pytest.raises(asyncio.CancelledError if failure == "cancel-source" else OutputStreamEvaluationError) as caught:
            await task
        if failure == "source-timeout": assert caught.value.timed_out
        assert "private" not in str(caught.value)
        assert incoming.closed and provider.calls == []
        if failure == "ready": assert incoming.consumed == 0
        instance = registry.get(request.plan)
        assert instance.active_requests == instance.waiting_requests == 0
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await engine.shutdown()


@pytest.mark.parametrize("delivery", ["window_buffered", "full_buffered"])
async def test_complete_output_timeout_keeps_timeout_evidence(delivery):
    candidate = plan(delivery=delivery)
    candidate = replace(candidate, modules=tuple(replace(module, timeout_ms=50) for module in candidate.modules))
    engine, provider, registry, request, _ = build(candidate)
    provider.gate = asyncio.Event()
    try:
        result = await engine.evaluate(replace(request, text="hello"))
        assert result.usage.fail_closed and any(step.timed_out for step in result.trace)
        instance = registry.get(request.plan)
        assert instance.active_requests == instance.waiting_requests == 0
    finally:
        await engine.shutdown()
