"""External text streams checked by NeMo's public stream_async API.

NeMo owns buffering and rail dispatch. This adapter verifies typed check
evidence before delivery; output.py owns the common output lifecycle. It never
interprets Colang or schedules individual rails. Source exhaustion means verified
normal completion: transports must raise on truncation instead of ending source.
"""
from __future__ import annotations

import time
from collections import deque
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field, replace
from typing import Any

import yaml
from nemoguardrails.rails.llm.options import ActivatedRail, GenerationLog, GenerationResponse
from opentelemetry.trace import Status, StatusCode

from ..runtime.contracts import EngineRequest, NeMoConfigSnapshot, ProtectionDecision
from ..runtime.streaming import OutputStreamEvaluationError, OutputStreamResult


class NativeStreamError(OutputStreamEvaluationError):
    """The stream failed; no unchecked text may be used as a fallback."""


def native_output_config(config: NeMoConfigSnapshot) -> dict[str, Any]:
    return (yaml.safe_load(config.config_yaml) or {}).get("rails", {}).get("output", {})


@dataclass(slots=True)
class _StreamEvidence:
    binding_ids: tuple[str, ...]
    batch: list[dict[str, Any]] = field(default_factory=list)
    completed: deque[tuple[dict[str, Any], ...]] = field(default_factory=deque)
    release_allowed: bool = False
    blocked: bool = False

    def record(self, payload: dict[str, Any]) -> None:
        if self.blocked:
            raise NativeStreamError("NeMo executed a rail after a terminal result.")
        index = len(self.batch)
        if index == len(self.binding_ids):
            self.batch = []
            index = 0
        if payload["step_id"] != self.binding_ids[index]:
            raise NativeStreamError("NeMo output rail execution order is invalid.")
        if self.batch and payload["input_text"] != self.batch[0]["input_text"]:
            raise NativeStreamError("NeMo output rails checked different candidates.")
        self.release_allowed = False
        self.batch.append(payload)
        self.blocked = payload["blocked"] or payload["verdict"] == "error"
        if self.blocked or len(self.batch) == len(self.binding_ids):
            self.completed.append(tuple(self.batch))
            self.release_allowed = not self.blocked


async def _close(iterator) -> None:
    close = getattr(iterator, "aclose", None)
    if close is not None:
        try:
            await close()
        except Exception:
            raise NativeStreamError("The protected stream could not close its source.") from None


async def run_native_output_stream(
    runtime,
    request: EngineRequest,
    source: AsyncIterator[str],
    *,
    emit: Callable[[str], Awaitable[None]],
    observe: Callable[[ProtectionDecision], Awaitable[None]] | None = None,
    acquisition,
) -> OutputStreamResult:
    # These are our own runtime helpers, not NeMo implementation APIs.
    from .runtime import (
        _execution_context, _admission, _TRACER, _colang1_decision, _colang1_runtime_result,
        _decision, _messages,
    )

    instance, cache_hit, registry_wait = acquisition
    output = native_output_config(instance.config)
    streaming = output.get("streaming", {})
    if (
        instance.config.runtime_profile != "llmrails_colang1_standard"
        or not streaming.get("enabled") or streaming.get("stream_first") is not False
        or output.get("parallel") is not False
    ):
        raise ValueError("This published configuration does not support native output streaming.")
    bindings = instance.config.bindings_for("output")
    if not bindings or any(
        item.capability != "content_safety" or item.on_unsafe not in {"block", "allow"}
        or item.failure_mode != "fail_closed" for item in bindings
    ):
        raise ValueError("Native streaming requires fail-closed, non-transforming safety rails.")
    source_iterator = source.__aiter__()
    evidence = _StreamEvidence(tuple(item.id for item in bindings))
    started = time.perf_counter()
    with _execution_context(runtime, request, instance, started, native_stream=evidence) as (scope, _):
        stream = None
        pending = ""
        exhausted = False
        released = 0
        checks = 0
        queue_wait = registry_wait

        async def inputs():
            nonlocal pending, exhausted
            async for text in source_iterator:
                evidence.release_allowed = False
                pending += text
                yield text
            evidence.release_allowed = False
            exhausted = True

        async def observe_checks():
            nonlocal checks
            while evidence.completed:
                payloads = evidence.completed.popleft()
                results = tuple(_colang1_runtime_result(binding, payload)
                                for binding, payload in zip(bindings, payloads))
                last = payloads[-1]
                candidate = payloads[0]["input_text"]
                if not candidate.endswith(pending):
                    raise NativeStreamError("NeMo did not check all pending source text.")
                # We record results at our registered Action boundary. The public
                # streaming API does not return GenerationResponse/output_vars.
                response = GenerationResponse(response=candidate, log=GenerationLog(activated_rails=[
                    ActivatedRail(type="output", name=flow, stop=payload["blocked"],
                                  duration=payload["latency_ms"] / 1000)
                    for flow, payload in zip(output["flows"], payloads)
                ]))
                decision = _decision(
                    replace(request, text=candidate), response, instance.config, results,
                    custom_decision=_colang1_decision(
                        replace(request, text=candidate), instance.config, response, results, payloads,
                    ),
                    cache_hit=cache_hit, queue_latency_ms=queue_wait,
                    active_concurrency=instance.active_requests,
                )
                checks += 1
                if observe is not None:
                    await observe(decision)
                if last["verdict"] == "error" or decision.usage.fail_closed:
                    raise NativeStreamError("Output protection failed; unchecked text was withheld.")

        inputs_iterator = inputs()
        async with _admission(instance, request) as admission_wait:
            try:
                queue_wait += admission_wait
                # Sources and delivery callbacks can raise with private payloads.
                # Record only safe error types, never automatic exception details.
                with _TRACER.start_as_current_span(
                    "guardrail.native_output_stream",
                    record_exception=False, set_status_on_exception=False,
                ) as span:
                    span.set_attribute("guardrail.id", request.plan.guardrail_id)
                    span.set_attribute("guardrail.version", request.plan.guardrail_version)
                    try:
                        stream = instance.rails.stream_async(
                            messages=_messages(request), generator=inputs_iterator,
                            include_metadata=False,
                        )
                        async for text in stream:
                            await observe_checks()
                            if scope.action_failure is not None:
                                raise NativeStreamError("Output rail execution failed.")
                            if evidence.blocked:
                                return OutputStreamResult("blocked", released, checks)
                            # Do not classify text by JSON shape: model content may
                            # itself be {"error": ...}. Only our checked source prefix
                            # is deliverable; NeMo diagnostic strings are not.
                            if (not evidence.release_allowed or not isinstance(text, str)
                                    or not pending.startswith(text)):
                                raise NativeStreamError("NeMo returned output without a completed check.")
                            if text:
                                await emit(text)
                                pending = pending[len(text):]
                                released += len(text)
                        await observe_checks()
                        if scope.action_failure is not None or not exhausted or pending:
                            raise NativeStreamError("The protected stream did not complete.")
                        if evidence.blocked:
                            return OutputStreamResult("blocked", released, checks)
                        return OutputStreamResult("completed", released, checks)
                    except BaseException as error:
                        span.set_status(Status(StatusCode.ERROR, type(error).__name__))
                        raise
            finally:
                try:
                    if stream is not None:
                        await _close(stream)
                finally:
                    await _close(inputs_iterator)
