"""Actual NeMo dispatch, using the same compiled policy for checks and streams."""
import asyncio
from dataclasses import replace

import pytest
import yaml
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from runner.toolkit.compiler.nemo_compiler import NeMoConfigCompiler
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.actions.contracts import ActionResult
from runner.toolkit.nemo.actions.names import ACTION_EVALUATE
from runner.toolkit.runtime.streaming import OutputStreamEvaluationError
from runner.toolkit.nemo.registry import NeMoRuntimeRegistry
from runner.toolkit.nemo.runtime import NeMoRuntime, _CURRENT_SCOPE
from runner.toolkit.runtime.contracts import (
    EngineRequest, EvaluationTrigger, GuardrailPlanModule, GuardrailPlanSnapshot,
    GuardrailPlanStep, RiskFinding,
)


class Safety:
    name = ACTION_EVALUATE
    version = "1.0.0"
    capabilities = frozenset({"content_safety"})
    rails = frozenset({"input", "output"})
    route_keys = frozenset({("content_safety", "tali.guard.content-safety.v1")})
    route_rail_keys = frozenset(
        ("content_safety", "tali.guard.content-safety.v1", phase)
        for phase in ("input", "output")
    )

    def __init__(self):
        self.calls = []
        self.gate = None
        self.entered = asyncio.Event()

    async def execute(self, request):
        self.calls.append((request.binding.id, request.content))
        self.entered.set()
        if self.gate is not None:
            await self.gate.wait()
        if "failure" in request.content:
            raise ValueError("private provider failure")
        matched = "unsafe" in request.content
        return ActionResult(
            "matched" if matched else "not_matched", request.content,
            findings=(RiskFinding(risk="content_safety", taxonomy_id="TALI-PHYSICAL-HARM",
                                  verdict="matched", confidence=1.0, evidence="Synthetic safety fixture.",
                                  recommended_action=request.proposed_action),) if matched else (),
        )


def plan(*, action="block", delivery="window_buffered", count=1):
    return GuardrailPlanSnapshot(
        guardrail_id="native-stream", guardrail_version="1", compiler_version="test",
        safety_level="balanced", output_delivery=delivery,
        steps=tuple(GuardrailPlanStep(
            id=f"safety-{i}", capability="content_safety", contract_ref="tali.guard.content-safety.v1",
            phases=("input", "output"), on_unsafe=action,
        ) for i in range(count)),
        modules=tuple(GuardrailPlanModule(
            id=f"interaction_safety:{phase}", module="interaction_safety", phase=phase,
            step_ids=tuple(f"safety-{i}" for i in range(count)), timeout_ms=2000,
        ) for phase in ("input", "output")),
    )


def build(candidate=None, *, chunk_size=2, context_size=1, concurrency=4):
    candidate = candidate or plan()
    config = NeMoConfigCompiler(stream_chunk_size=chunk_size, stream_context_size=context_size).compile(candidate)

    class Store:
        def active_plan_keys(self): return ((candidate.guardrail_id, candidate.guardrail_version),)
        def plan(self, *_): return candidate
        def nemo_config(self, *_): return config

    provider = Safety()
    registry = NeMoRuntimeRegistry(Store(), action_providers(provider), max_concurrency_per_guardrail=concurrency)
    runtime = NeMoRuntime(registry)
    request = EngineRequest(phase="output", text="", plan=candidate)
    return runtime, provider, registry, request, config


async def source(*chunks):
    for chunk in chunks:
        yield chunk


async def run(runtime, request, *chunks):
    delivered, observed = [], []
    async def emit(text): delivered.append(text)
    async def observe(check): observed.append(check)
    result = await runtime.protect_output(request, source(*chunks), emit=emit, observe=observe)
    return result, delivered, observed


@pytest.mark.parametrize("action", ["block", "allow"])
def test_compiler_emits_direct_outcome_rails_with_checked_delivery(action):
    candidate = plan(action=action, count=2)
    config = NeMoConfigCompiler(stream_chunk_size=4, stream_context_size=1).compile(candidate)
    output = yaml.safe_load(config.config_yaml)["rails"]["output"]
    assert len(output["flows"]) == 2
    assert all("ordered" not in flow for flow in output["flows"])
    assert output["parallel"] is False
    assert output["streaming"] == dict(enabled=True, stream_first=False, chunk_size=4, context_size=1)
    assert ".is_blocked" in config.colang_content


@pytest.mark.parametrize("change", ["full", "transform", "conditional", "pii", "fail_open", "optional"])
def test_incompatible_policies_do_not_advertise_native_streaming(change):
    candidate = plan()
    if change == "full": candidate = replace(candidate, output_delivery="full_buffered")
    if change == "transform": candidate = replace(candidate, steps=(replace(candidate.steps[0], on_unsafe="transform"),))
    if change == "pii": candidate = replace(candidate, steps=(replace(candidate.steps[0], capability="pii", contract_ref="tali.guard.pii.exact.v1"),))
    if change == "conditional":
        candidate = plan(count=2)
        candidate = replace(candidate, steps=(candidate.steps[0], replace(candidate.steps[1], trigger=EvaluationTrigger(type="on_result", step_ref="safety-0", verdicts=("unknown",)))))
    if change == "fail_open": candidate = replace(candidate, modules=tuple(replace(m, failure_mode="fail_open") for m in candidate.modules))
    if change == "optional": candidate = replace(candidate, modules=tuple(replace(m, required_for_release=False) for m in candidate.modules))
    config = NeMoConfigCompiler().compile(candidate)
    assert not yaml.safe_load(config.config_yaml).get("rails", {}).get("output", {}).get("streaming", {}).get("enabled")


@pytest.mark.parametrize("chunk,context", [(0, 0), (1, 0), (2, 2), (2, -1)])
def test_rejects_windows_without_bounded_positive_overlap(chunk, context):
    with pytest.raises(ValueError, match="context_size"):
        NeMoConfigCompiler(stream_chunk_size=chunk, stream_context_size=context)


@pytest.mark.parametrize("text", ["", "safe", "unsafe"])
async def test_complete_response_checks_keep_input_rails_and_many_output_rules_working(text):
    runtime, provider, _, request, _ = build(plan(count=30))
    try:
        for phase in ("input", "output"):
            provider.calls.clear()
            result = await runtime.evaluate(replace(request, phase=phase, text=text))
            assert not result.usage.fail_closed, result.reason
            assert result.decision == ("block" if text == "unsafe" else "allow")
            assert len(provider.calls) == (1 if text == "unsafe" else 30)
    finally:
        await runtime.shutdown()


@pytest.mark.parametrize("mode,action,expected", [("enforce", "block", "block"), ("enforce", "allow", "allow"), ("detect", "block", "allow")])
async def test_regular_and_streaming_share_outcome_and_evidence(mode, action, expected):
    runtime, provider, _, request, _ = build(plan(action=action, count=2))
    request = replace(request, mode=mode)
    try:
        normal = await runtime.evaluate(replace(request, text="unsafe"))
        assert normal.decision == expected and not normal.usage.fail_closed, normal.reason
        provider.calls.clear()
        result, delivered, observed = await run(runtime, request, "un", "safe")
        assert result.status == ("blocked" if expected == "block" else "completed")
        assert "".join(delivered) == ("" if expected == "block" else "unsafe")
        assert observed[0].decision == normal.decision
        assert observed[0].findings
        assert [call[0] for call in provider.calls[:2]] == (["safety-0"] if expected == "block" else ["safety-0", "safety-1"])
    finally:
        await runtime.shutdown()


async def test_window_overlap_tail_and_json_content_are_preserved():
    runtime, provider, _, request, _ = build()
    try:
        parts = ['{"error":', '"normal model JSON"}', "中文", "tail"]
        result, delivered, observed = await run(runtime, request, *parts)
        assert "".join(delivered) == "".join(parts)
        assert result.status == "completed" and result.released_characters == len("".join(parts))
        assert provider.calls[0][1] == "".join(parts[:2])
        assert parts[1] in provider.calls[1][1]  # native overlap, not isolated checks
        assert observed and result.checks == len(observed)
        assert _CURRENT_SCOPE.get() is None
    finally:
        await runtime.shutdown()


async def test_check_finishes_before_any_text_is_delivered():
    runtime, provider, _, request, _ = build()
    provider.gate = asyncio.Event()
    delivered = []
    async def emit(text): delivered.append(text)
    task = asyncio.create_task(runtime.protect_output(request, source("hello", " world"), emit=emit))
    try:
        await asyncio.wait_for(provider.entered.wait(), 2)
        assert delivered == []
        provider.gate.set()
        result = await task
        assert result.status == "completed" and "".join(delivered) == "hello world"
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await runtime.shutdown()


@pytest.mark.parametrize("kind", ["provider", "source", "timeout", "cancel"])
@pytest.mark.parametrize("delivery", ["window_buffered", "full_buffered"])
async def test_failure_and_cancellation_close_source_and_release_admission(kind, delivery):
    runtime, provider, registry, request, _ = build(plan(delivery=delivery), concurrency=1)
    closed = asyncio.Event()
    delivered, observed = [], []
    async def tokens():
        try:
            yield "failure" if kind == "provider" else "hello"
            if kind == "source": raise ValueError("private upstream body")
            yield " world"
        finally:
            closed.set()
    if kind in {"cancel", "timeout"}: provider.gate = asyncio.Event()
    async def emit(text): delivered.append(text)
    async def observe(check): observed.append(check)
    task = asyncio.create_task(runtime.protect_output(request, tokens(), emit=emit, observe=observe,
                                                     timeout_seconds=0.05 if kind == "timeout" else 3))
    try:
        if kind == "cancel":
            await asyncio.wait_for(provider.entered.wait(), 2)
            task.cancel()
        with pytest.raises(asyncio.CancelledError if kind == "cancel" else OutputStreamEvaluationError) as error:
            await task
        if kind == "timeout": assert error.value.timed_out
        assert closed.is_set() and delivered == []
        if kind == "provider": assert observed[0].usage.fail_closed
        instance = registry.get(request.plan)
        assert instance.active_requests == instance.waiting_requests == 0
        provider.gate = None
        assert (await run(runtime, request, "safe"))[0].status == "completed"
    finally:
        await runtime.shutdown()


async def test_complete_configuration_uses_the_same_output_entry_point():
    runtime, provider, _, request, _ = build(plan(delivery="full_buffered"))
    try:
        result, delivered, observed = await run(runtime, request, "hello", " world")
        assert result.status == "completed" and "".join(delivered) == "hello world"
        assert result.checks == len(observed) == 1
        assert provider.calls == [("safety-0", "hello world")]
    finally:
        await runtime.shutdown()


async def test_concurrent_streams_keep_request_modes_and_evidence_isolated():
    runtime, provider, _, request, _ = build()
    provider.gate = asyncio.Event()
    enforcing = asyncio.create_task(run(runtime, request, "un", "safe"))
    detecting = asyncio.create_task(run(runtime, replace(request, mode="detect"), "un", "safe"))
    try:
        await asyncio.wait_for(provider.entered.wait(), 2)
        provider.gate.set()
        blocked, allowed = await asyncio.gather(enforcing, detecting)
        assert blocked[0].status == "blocked" and blocked[1] == []
        assert allowed[0].status == "completed" and "".join(allowed[1]) == "unsafe"
        assert all(d.mode == "enforce" for d in blocked[2])
        assert all(d.mode == "detect" for d in allowed[2])
        assert _CURRENT_SCOPE.get() is None
    finally:
        enforcing.cancel()
        detecting.cancel()
        await asyncio.gather(enforcing, detecting, return_exceptions=True)
        await runtime.shutdown()


@pytest.mark.parametrize("sink", ["emit", "observe"])
@pytest.mark.parametrize("delivery", ["window_buffered", "full_buffered"])
async def test_failed_sink_terminates_and_closes_upstream(sink, monkeypatch, caplog, delivery):
    import runner.toolkit.nemo.runtime as runtime_module
    exporter = InMemorySpanExporter()
    tracing = TracerProvider()
    tracing.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(runtime_module, "_TRACER", tracing.get_tracer("native-test"))
    runtime, _, registry, request, _ = build(plan(delivery=delivery))
    closed = asyncio.Event()
    async def chunks():
        try:
            yield "hello"
            yield " world"
            if delivery == "window_buffered":
                pytest.fail("No more upstream content should be requested after delivery fails")
            yield " tail"
        finally:
            closed.set()
    async def fail(_): raise ValueError("private sink error")
    async def ignore(_): pass
    try:
        with pytest.raises(OutputStreamEvaluationError) as error:
            await runtime.protect_output(request, chunks(), emit=fail if sink == "emit" else ignore,
                                        observe=fail if sink == "observe" else None)
        assert "private" not in str(error.value)
        assert closed.is_set() and _CURRENT_SCOPE.get() is None
        assert registry.get(request.plan).active_requests == 0
        spans = exporter.get_finished_spans()
        assert any(span.status.is_ok is False for span in spans)
        assert all("private sink error" not in span.to_json() for span in spans)
        assert "private sink error" not in caplog.text
    finally:
        await runtime.shutdown()
        tracing.shutdown()


async def test_cancel_while_waiting_does_not_consume_source_or_leak_admission():
    runtime, provider, registry, request, _ = build(concurrency=1)
    provider.gate = asyncio.Event()
    first = asyncio.create_task(run(runtime, request, "hello", " world"))
    consumed = False
    async def queued_source():
        nonlocal consumed
        consumed = True
        yield "never requested"
    async def emit(_): pytest.fail("Queued stream must not deliver anything")
    second = None
    try:
        await asyncio.wait_for(provider.entered.wait(), 2)
        second = asyncio.create_task(runtime.protect_output(request, queued_source(), emit=emit))
        await asyncio.sleep(0)
        assert registry.get(request.plan).waiting_requests == 1
        second.cancel()
        with pytest.raises(asyncio.CancelledError): await second
        assert not consumed and registry.get(request.plan).waiting_requests == 0
        assert registry.get(request.plan).active_requests == 1
        provider.gate.set()
        assert (await first)[0].status == "completed"
        assert registry.get(request.plan).active_requests == 0
    finally:
        first.cancel()
        if second is not None: second.cancel()
        await asyncio.gather(first, *([second] if second is not None else []), return_exceptions=True)
        await runtime.shutdown()


@pytest.mark.parametrize("kind", ["non_text", "too_large"])
@pytest.mark.parametrize("delivery", ["window_buffered", "full_buffered"])
async def test_invalid_source_is_withheld_before_model_checks(kind, delivery):
    runtime, provider, _, request, _ = build(plan(delivery=delivery))
    async def emit(_): pytest.fail("No invalid content is deliverable")
    try:
        with pytest.raises(OutputStreamEvaluationError):
            await runtime.protect_output(request, source(None if kind == "non_text" else "x" * 1_000_001), emit=emit)
        assert provider.calls == [] and _CURRENT_SCOPE.get() is None
    finally:
        await runtime.shutdown()
