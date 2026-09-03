from __future__ import annotations

import asyncio
import json
import time
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Iterator, Protocol

import httpx
from nemoguardrails.types import ChatMessage, LLMResponse, LLMResponseChunk
from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode

from .contracts import ActionRequest, ModelCallResult, ModelCallUsage


_TRACER = trace.get_tracer("tasklattice.guard-runner.model")
_NATIVE_MODEL_SCOPE: ContextVar["NativeModelObservationScope | None"] = ContextVar(
    "tasklattice_native_model_observation_scope",
    default=None,
)


class ModelCallObserver(Protocol):
    def model_call_started(self, **labels: str) -> None: ...

    def model_call_finished(
        self, *, usage: ModelCallUsage, **labels: str,
    ) -> None: ...


@dataclass(slots=True)
class NativeModelObservationScope:
    """Request identity shared with NeMo-native model adapters via ContextVar."""

    guardrail_id: str
    integration_id: str
    phase: str
    request_started_at: float
    observer: ModelCallObserver | None = None
    calls: list[ModelCallUsage] = field(default_factory=list)


def activate_native_model_observation(
    *,
    guardrail_id: str,
    integration_id: str,
    phase: str,
    request_started_at: float,
    observer: ModelCallObserver | None = None,
) -> tuple[NativeModelObservationScope, Any]:
    scope = NativeModelObservationScope(
        guardrail_id=guardrail_id,
        integration_id=integration_id,
        phase=phase,
        request_started_at=request_started_at,
        observer=observer,
    )
    return scope, _NATIVE_MODEL_SCOPE.set(scope)


def deactivate_native_model_observation(token: Any) -> None:
    _NATIVE_MODEL_SCOPE.reset(token)


class ObservedNeMoModel:
    """Privacy-safe metric/trace proxy for a NeMo-native LLMModel."""

    def __init__(self, delegate: Any, role: str) -> None:
        self._delegate = delegate
        self._role = role

    @property
    def model_name(self) -> str:
        return str(self._delegate.model_name or "unknown")

    @property
    def provider_name(self) -> str | None:
        return self._delegate.provider_name

    @property
    def provider_url(self) -> str | None:
        return self._delegate.provider_url

    async def generate_async(
        self,
        prompt: str | list[ChatMessage],
        *,
        stop: list[str] | None = None,
        **kwargs: Any,
    ) -> LLMResponse:
        with _observe_native_model_call(self, self._role) as call:
            response = await self._delegate.generate_async(
                prompt, stop=stop, **kwargs,
            )
            call.complete(response)
            return response

    async def stream_async(
        self,
        prompt: str | list[ChatMessage],
        *,
        stop: list[str] | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[LLMResponseChunk]:
        with _observe_native_model_call(self, self._role) as call:
            async for chunk in self._delegate.stream_async(
                prompt, stop=stop, **kwargs,
            ):
                call.complete(chunk)
                yield chunk


def instrument_nemo_models(rails: Any, model_roles: tuple[str, ...]) -> None:
    """Wrap NeMo model action parameters without depending on private clients."""
    engine = getattr(rails, "rails_engine", rails)
    runtime = getattr(engine, "runtime", None)
    params = getattr(runtime, "registered_action_params", {})
    for role in model_roles:
        parameter = f"{role}_llm"
        model = params.get(parameter)
        if model is None or isinstance(model, ObservedNeMoModel):
            continue
        rails.register_action_param(parameter, ObservedNeMoModel(model, role))


@dataclass(slots=True)
class _NativeModelCall:
    scope: NativeModelObservationScope | None
    role: str
    provider: str
    model: str
    started: float
    result: ModelCallResult = "success"
    error_type: str = "none"
    input_tokens: int = 0
    output_tokens: int = 0
    finished: float = 0.0

    def complete(self, response: LLMResponse | LLMResponseChunk) -> None:
        usage = response.usage
        if usage is not None:
            self.input_tokens = max(0, usage.input_tokens)
            self.output_tokens = max(0, usage.output_tokens)

    def fail(self, error: BaseException) -> None:
        self.result, self.error_type = classify_model_error(error)

    @property
    def usage(self) -> ModelCallUsage:
        finished = self.finished or time.perf_counter()
        duration_ms = max(0, round((finished - self.started) * 1_000))
        request_started_at = (
            self.scope.request_started_at if self.scope is not None else self.started
        )
        started_offset_ms = max(
            0, round((self.started - request_started_at) * 1_000),
        )
        phase = self.scope.phase if self.scope is not None else "unknown"
        return ModelCallUsage(
            provider=self.provider,
            model=self.model,
            operation=f"{self.role}_{phase}",
            result=self.result,
            duration_ms=duration_ms,
            started_offset_ms=started_offset_ms,
            finished_offset_ms=started_offset_ms + duration_ms,
            input_tokens=self.input_tokens,
            output_tokens=self.output_tokens,
            error_type=self.error_type,
        )


@contextmanager
def _observe_native_model_call(
    model: ObservedNeMoModel,
    role: str,
) -> Iterator[_NativeModelCall]:
    scope = _NATIVE_MODEL_SCOPE.get()
    provider = str(model.provider_name or "unknown")
    call = _NativeModelCall(scope, role, provider, model.model_name, time.perf_counter())
    labels = {
        "guardrail_id": scope.guardrail_id if scope is not None else "__unresolved__",
        "integration_id": scope.integration_id if scope is not None else "__internal__",
        "phase": scope.phase if scope is not None else "unknown",
        "action": f"nemo_{role}",
        "provider": provider,
        "model": model.model_name,
        "operation": f"{role}_{scope.phase if scope is not None else 'unknown'}",
    }
    observer = scope.observer if scope is not None else None
    if observer is not None:
        observer.model_call_started(**labels)
    with _TRACER.start_as_current_span(
        "guardrail.model.request",
        attributes={
            "guardrail.id": labels["guardrail_id"],
            "guardrail.phase": labels["phase"],
            "guardrail.action": labels["action"],
            "integration.id": labels["integration_id"],
            "gen_ai.provider.name": provider,
            "gen_ai.request.model": model.model_name,
            "gen_ai.operation.name": labels["operation"],
            "guardrail.model.source": "nemo_native",
        },
    ) as span:
        try:
            yield call
        except BaseException as error:
            call.fail(error)
            span.record_exception(error)
            span.set_status(Status(StatusCode.ERROR, call.result))
            raise
        finally:
            call.finished = time.perf_counter()
            usage = call.usage
            span.set_attribute("guardrail.model.result", usage.result)
            span.set_attribute("guardrail.model.duration_ms", usage.duration_ms)
            span.set_attribute("guardrail.model.error_type", usage.error_type)
            span.set_attribute("gen_ai.usage.input_tokens", usage.input_tokens)
            span.set_attribute("gen_ai.usage.output_tokens", usage.output_tokens)
            if usage.result != "success":
                span.set_status(Status(StatusCode.ERROR, usage.result))
            if scope is not None:
                scope.calls.append(usage)
            if observer is not None:
                observer.model_call_finished(
                    usage=usage,
                    **labels,
                )


@dataclass(slots=True)
class ModelCallTracker:
    request: ActionRequest
    provider: str
    model: str
    operation: str
    started: float
    profile_ref: str | None = None
    runtime_ref: str | None = None
    result: ModelCallResult = "unknown_error"
    error_type: str = "none"
    input_tokens: int = 0
    output_tokens: int = 0
    retries: int = 0
    backoff_ms: int = 0
    time_to_first_token_ms: int | None = None
    finished: float = 0.0

    def complete(
        self,
        *,
        payload: Any = None,
        result: ModelCallResult = "success",
        error_type: str = "none",
        retries: int = 0,
        backoff_ms: int = 0,
        time_to_first_token_ms: int | None = None,
    ) -> None:
        self.result = result
        self.error_type = error_type
        self.retries = max(0, retries)
        self.backoff_ms = max(0, backoff_ms)
        self.time_to_first_token_ms = time_to_first_token_ms
        self.input_tokens, self.output_tokens = _tokens(payload)

    def fail(self, error: BaseException) -> None:
        self.result, self.error_type = classify_model_error(error)

    @property
    def usage(self) -> ModelCallUsage:
        finished = self.finished or time.perf_counter()
        duration_ms = max(0, round((finished - self.started) * 1_000))
        origin = self.request.request_started_at or self.started
        started_offset_ms = max(0, round((self.started - origin) * 1_000))
        return ModelCallUsage(
            provider=self.provider,
            model=self.model,
            operation=self.operation,
            result=self.result,
            duration_ms=duration_ms,
            profile_ref=self.profile_ref,
            runtime_ref=self.runtime_ref,
            started_offset_ms=started_offset_ms,
            finished_offset_ms=started_offset_ms + duration_ms,
            time_to_first_token_ms=self.time_to_first_token_ms,
            input_tokens=self.input_tokens,
            output_tokens=self.output_tokens,
            retries=self.retries,
            backoff_ms=self.backoff_ms,
            error_type=self.error_type,
        )


@contextmanager
def observe_model_call(
    request: ActionRequest,
    *,
    provider: str,
    model: str,
    operation: str,
    profile_ref: str | None = None,
    runtime_ref: str | None = None,
) -> Iterator[ModelCallTracker]:
    started = time.perf_counter()
    tracker = ModelCallTracker(
        request, provider, model, operation, started,
        profile_ref=profile_ref, runtime_ref=runtime_ref,
    )
    integration_id = (
        request.request_context.integration_id
        if request.request_context is not None
        else None
    )
    attributes = {
        "guardrail.id": request.guardrail_id,
        "guardrail.version": request.guardrail_version,
        "guardrail.phase": request.rail_type,
        "guardrail.capability": request.capability,
        "guardrail.evaluation.contract_ref": request.binding.contract_ref,
        "guardrail.action": request.binding.action_name or request.binding.id,
        "guardrail.policy.id": request.policy_id or "__none__",
        "integration.id": integration_id or "__internal__",
        "gen_ai.provider.name": provider,
        "gen_ai.request.model": model,
        "gen_ai.operation.name": operation,
        "guardrail.evaluator.profile_ref": profile_ref or "__none__",
        "guardrail.model.runtime_ref": runtime_ref or "__none__",
    }
    observer_labels = {
        "guardrail_id": request.guardrail_id,
        "integration_id": integration_id or "__internal__",
        "phase": request.rail_type,
        "action": request.binding.action_name or request.binding.id,
        "provider": provider,
        "model": model,
        "operation": operation,
    }
    scope = _NATIVE_MODEL_SCOPE.get()
    observer = scope.observer if scope is not None else None
    if observer is not None:
        observer.model_call_started(**observer_labels)
    with _TRACER.start_as_current_span(
        "guardrail.model.request",
        attributes=attributes,
    ) as span:
        try:
            yield tracker
        except BaseException as error:
            tracker.fail(error)
            span.record_exception(error)
            span.set_status(Status(StatusCode.ERROR, tracker.result))
            raise
        finally:
            tracker.finished = time.perf_counter()
            usage = tracker.usage
            span.set_attribute("guardrail.model.result", usage.result)
            span.set_attribute("guardrail.model.duration_ms", usage.duration_ms)
            span.set_attribute("guardrail.model.error_type", usage.error_type)
            span.set_attribute("gen_ai.usage.input_tokens", usage.input_tokens)
            span.set_attribute("gen_ai.usage.output_tokens", usage.output_tokens)
            span.set_attribute("guardrail.model.retries", usage.retries)
            span.set_attribute("guardrail.model.backoff_ms", usage.backoff_ms)
            if usage.time_to_first_token_ms is not None:
                span.set_attribute(
                    "guardrail.model.time_to_first_token_ms",
                    usage.time_to_first_token_ms,
                )
            if usage.result != "success":
                span.set_status(Status(StatusCode.ERROR, usage.result))
            if observer is not None:
                observer.model_call_finished(
                    usage=usage,
                    **observer_labels,
                )


def action_usage(tracker: ModelCallTracker, input_characters: int) -> "ActionUsage":
    from .contracts import ActionUsage

    usage = tracker.usage
    return ActionUsage(
        provider_latency_ms=usage.duration_ms,
        model_invocations=1,
        input_characters=max(0, input_characters),
        model_calls=(usage,),
    )


def classify_model_error(error: BaseException) -> tuple[ModelCallResult, str]:
    # NeMo wraps provider exceptions in LLMCallException. Preserve the bounded
    # provider class instead of collapsing every native flow failure to unknown.
    if error.__cause__ is not None and error.__cause__ is not error:
        return classify_model_error(error.__cause__)
    # An asyncio timeout cancels the inner provider call before translating the
    # cancellation to TimeoutError at the Action boundary.
    if isinstance(error, asyncio.CancelledError):
        return "timeout", "action_deadline"
    if isinstance(error, (httpx.TimeoutException, TimeoutError)):
        return "timeout", type(error).__name__
    if isinstance(error, httpx.HTTPStatusError):
        status = error.response.status_code
        if status == 429:
            return "rate_limited", "http_429"
        if status >= 500:
            return "server_error", f"http_{status // 100}xx"
        return "client_error", f"http_{status // 100}xx"
    if isinstance(error, httpx.TransportError):
        return "transport_error", type(error).__name__
    if isinstance(error, (KeyError, TypeError, ValueError, json.JSONDecodeError)):
        return "invalid_response", type(error).__name__
    return "unknown_error", type(error).__name__


def _tokens(payload: Any) -> tuple[int, int]:
    if not isinstance(payload, dict):
        return 0, 0
    usage = payload.get("usage")
    if not isinstance(usage, dict):
        return 0, 0
    return (
        _non_negative_int(usage.get("prompt_tokens", usage.get("input_tokens", 0))),
        _non_negative_int(usage.get("completion_tokens", usage.get("output_tokens", 0))),
    )


def _non_negative_int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0
