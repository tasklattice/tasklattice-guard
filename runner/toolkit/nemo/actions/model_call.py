from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Iterator, Protocol

import httpx
from runner.model_http_evidence import begin_model_http_call, finish_model_http_call, mark_model_request_sent
from runner.model_concurrency import model_slot
from aiohttp import ClientConnectionError, ClientResponseError
from ...runtime.failures import Failure, ModelConfigurationError, ModelResponseError
from nemoguardrails import Guardrails
from nemoguardrails.exceptions import LLMClientError, LLMConnectionError, LLMResponseValidationError, LLMTimeoutError
from nemoguardrails.types import ChatMessage, LLMResponse, LLMResponseChunk
from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode

from .contracts import ActionRequest, ModelCallResult, ModelCallUsage


_COST_CALLS: ContextVar[list[ModelCallUsage] | None] = ContextVar("guard_cost_calls", default=None)
SHORT_CIRCUIT_CANCEL = "guardrail_short_circuit"


def begin_cost_collection():
    calls: list[ModelCallUsage] = []
    return calls, _COST_CALLS.set(calls)


def end_cost_collection(token):
    _COST_CALLS.reset(token)


def _collect_cost(usage: ModelCallUsage) -> None:
    calls = _COST_CALLS.get()
    if calls is not None:
        calls.append(usage)


_TRACER = trace.get_tracer("tasklattice.guard-runner.model")
_LOGGER = logging.getLogger("uvicorn.error.tasklattice.model")
_NATIVE_MODEL_SCOPE: ContextVar["NativeModelObservationScope | None"] = ContextVar(
    "tasklattice_native_model_observation_scope",
    default=None,
)
_ACTIVE_MODEL_CALL: ContextVar["ModelCallTracker | None"] = ContextVar("guard_active_model_call", default=None)
_ACTIVE_NATIVE_CALL: ContextVar["_NativeModelCall | None"] = ContextVar("guard_active_native_call", default=None)


def record_model_queue(queue_ms: int, request_sent: bool) -> None:
    mark_model_request_sent(request_sent)
    call = _ACTIVE_MODEL_CALL.get() or _ACTIVE_NATIVE_CALL.get()
    if call is not None:
        call.queue_duration_ms += queue_ms
        call.request_sent = bool(call.request_sent or request_sent)


def record_native_response(response: LLMResponse) -> None:
    """Record validated response evidence before IORails reduces it to a result."""
    if call := _ACTIVE_NATIVE_CALL.get():
        call.complete(response)


def record_native_failure(error: BaseException) -> None:
    if call := _ACTIVE_NATIVE_CALL.get():
        call.fail(error)


class ModelCallObserver(Protocol):
    def model_call_started(self, **labels: str) -> None: ...

    def model_call_finished(
        self, *, usage: ModelCallUsage, **labels: str,
    ) -> None: ...


@dataclass(slots=True)
class NativeModelObservationScope:
    """Request identity shared with NeMo-native model adapters via ContextVar."""

    guardrail_id: str
    endpoint_id: str
    phase: str
    request_started_at: float
    observer: ModelCallObserver | None = None
    calls: list[ModelCallUsage] = field(default_factory=list)


def activate_native_model_observation(
    *,
    guardrail_id: str,
    endpoint_id: str,
    phase: str,
    request_started_at: float,
    observer: ModelCallObserver | None = None,
) -> tuple[NativeModelObservationScope, Any]:
    scope = NativeModelObservationScope(
        guardrail_id=guardrail_id,
        endpoint_id=endpoint_id,
        phase=phase,
        request_started_at=request_started_at,
        observer=observer,
    )
    return scope, _NATIVE_MODEL_SCOPE.set(scope)


def deactivate_native_model_observation(token: Any) -> None:
    _NATIVE_MODEL_SCOPE.reset(token)


class ObservedNeMoModel:
    """Privacy-safe metric/trace proxy for a NeMo-native LLMModel."""

    def __init__(self, delegate: Any, role: str, runtime_ref: str | None = None) -> None:
        self._delegate = delegate
        self._role = role
        self.runtime_ref = runtime_ref

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
            async with model_slot(self.runtime_ref):
                response = await self._delegate.generate_async(
                    prompt, stop=stop, **kwargs,
                )
            if self._role == "topic_control" and (
                not isinstance(response.content, str) or response.content.strip().casefold() not in {"on-topic", "off-topic"}
            ):
                raise ModelResponseError("response_schema", "InvalidTopicLabel")
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
            async with model_slot(self.runtime_ref):
                async for chunk in self._delegate.stream_async(
                    prompt, stop=stop, **kwargs,
                ):
                    call.complete(chunk)
                    yield chunk


def instrument_nemo_models(
    rails: Guardrails,
    model_roles: tuple[str, ...],
    runtime_refs: dict[str, str] | None = None,
) -> None:
    """Wrap model action parameters on the pinned NeMo Guardrails runtime."""
    params = rails.runtime.registered_action_params
    for role in model_roles:
        parameter = f"{role}_llm"
        model = params.get(parameter)
        if model is None or isinstance(model, ObservedNeMoModel):
            continue
        from runner.model_validation_diagnostics import instrument_native_validation_http
        instrument_native_validation_http(model)
        rails.register_action_param(parameter, ObservedNeMoModel(model, role, (runtime_refs or {}).get(role)))


@dataclass(slots=True)
class _NativeModelCall:
    scope: NativeModelObservationScope | None
    role: str
    provider: str
    model: str
    started: float
    profile_ref: str | None = None
    runtime_ref: str | None = None
    result: ModelCallResult = "unknown_error"
    error_type: str = "none"
    failure: Failure | None = None
    call_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    usage_known: bool = False
    cached_input_tokens: int = 0
    unsupported_usage: bool = False
    input_tokens: int = 0
    output_tokens: int = 0
    finished: float = 0.0
    queue_duration_ms: int = 0
    request_sent: bool | None = None

    def complete(self, response: LLMResponse | LLMResponseChunk) -> None:
        self.result = "success"
        usage = response.usage
        self.unsupported_usage = self.unsupported_usage or (response.provider_metadata or {}).get("service_tier") not in (None, "default", "auto")
        if usage is not None:
            self.usage_known = all(type(value) is int and value >= 0 for value in (usage.input_tokens, usage.output_tokens))
            self.cached_input_tokens = max(0, usage.cached_tokens or 0)
            self.input_tokens = max(0, usage.input_tokens)
            self.output_tokens = max(0, usage.output_tokens)

    def fail(self, error: BaseException) -> None:
        result, failure = model_failure(error)
        if failure and failure.source == "guard" and (self.result == "success" or self.failure is not None):
            return  # Retain the model evidence when IORails reduces a failure or Guard code fails later.
        self.result, self.failure = result, failure
        self.error_type = self.failure.error_type if self.failure else "none"
        if self.result != "cancelled":
            _log_model_failure(self.call_id, self.result, error)

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
            queue_duration_ms=self.queue_duration_ms, request_sent=self.request_sent,
            profile_ref=self.profile_ref,
            runtime_ref=self.runtime_ref,
            started_offset_ms=started_offset_ms,
            finished_offset_ms=started_offset_ms + duration_ms,
            call_id=self.call_id,
            usage_known=self.usage_known,
            cached_input_tokens=self.cached_input_tokens,
            unsupported_usage=self.unsupported_usage,
            input_tokens=self.input_tokens,
            output_tokens=self.output_tokens,
            error_type=self.error_type,
            error_source=self.failure.source if self.failure else None,
            error_category=self.failure.category if self.failure else None,
            http_status=self.failure.http_status if self.failure else None,
        )


@contextmanager
def _observe_native_model_call(
    model: ObservedNeMoModel,
    role: str,
) -> Iterator[_NativeModelCall]:
    with observe_native_model_call(
        _NATIVE_MODEL_SCOPE.get(),
        role=role,
        provider=str(model.provider_name or "unknown"),
        model=model.model_name,
        runtime_ref=model.runtime_ref,
    ) as call:
        yield call


@contextmanager
def observe_native_model_call(
    scope: NativeModelObservationScope | None,
    *,
    role: str,
    provider: str,
    model: str,
    profile_ref: str | None = None,
    runtime_ref: str | None = None,
) -> Iterator[_NativeModelCall]:
    """Observe a native model call with an explicit request scope."""

    call = _NativeModelCall(
        scope,
        role,
        provider,
        model,
        time.perf_counter(),
        profile_ref=profile_ref,
        runtime_ref=runtime_ref,
    )
    labels = {
        "guardrail_id": scope.guardrail_id if scope is not None else "__unresolved__",
        "endpoint_id": scope.endpoint_id if scope is not None else "__internal__",
        "phase": scope.phase if scope is not None else "unknown",
        "action": f"nemo_{role}",
        "provider": provider,
        "model": model,
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
            "endpoint.id": labels["endpoint_id"],
            "gen_ai.provider.name": provider,
            "gen_ai.request.model": model,
            "gen_ai.operation.name": labels["operation"],
            "guardrail.model.source": "nemo_native",
        },
    ) as span:
        token = _ACTIVE_NATIVE_CALL.set(call)
        evidence_token = begin_model_http_call(call.call_id, provider, model)
        try:
            yield call
        except BaseException as error:
            call.fail(error)
            if call.result not in {"success", "cancelled"}:
                span.record_exception(error)
                span.set_status(Status(StatusCode.ERROR, call.result))
            raise
        finally:
            finish_model_http_call(evidence_token, call.result, call.error_type)
            _ACTIVE_NATIVE_CALL.reset(token)
            call.finished = time.perf_counter()
            usage = call.usage
            _collect_cost(usage)
            span.set_attribute("guardrail.model.result", usage.result)
            span.set_attribute("guardrail.model.call_id", usage.call_id)
            span.set_attribute("guardrail.model.duration_ms", usage.duration_ms)
            span.set_attribute("guardrail.model.queue_duration_ms", usage.queue_duration_ms)
            if usage.request_sent is not None:
                span.set_attribute("guardrail.model.request_sent", usage.request_sent)
            span.set_attribute("guardrail.model.error_type", usage.error_type)
            if usage.error_source:
                span.set_attribute("guardrail.error.source", usage.error_source)
                span.set_attribute("guardrail.error.category", usage.error_category or "unknown")
            if usage.http_status is not None:
                span.set_attribute("http.response.status_code", usage.http_status)
            span.set_attribute("gen_ai.usage.input_tokens", usage.input_tokens)
            span.set_attribute("gen_ai.usage.output_tokens", usage.output_tokens)
            if usage.result not in {"success", "cancelled"}:
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
    failure: Failure | None = None
    call_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    usage_known: bool = False
    cached_input_tokens: int = 0
    unsupported_usage: bool = False
    input_tokens: int = 0
    output_tokens: int = 0
    retries: int = 0
    backoff_ms: int = 0
    time_to_first_token_ms: int | None = None
    finished: float = 0.0
    queue_duration_ms: int = 0
    request_sent: bool | None = None

    def complete(
        self,
        *,
        payload: Any = None,
        result: ModelCallResult = "success",
        error_type: str = "none",
        retries: int | None = None,
        backoff_ms: int | None = None,
        time_to_first_token_ms: int | None = None,
    ) -> None:
        self.result = result
        self.error_type = error_type
        if retries is not None:
            self.retries = max(0, retries)
        if backoff_ms is not None:
            self.backoff_ms = max(0, backoff_ms)
        self.time_to_first_token_ms = time_to_first_token_ms
        self.input_tokens, self.output_tokens = _tokens(payload)
        usage = payload.get("usage") if isinstance(payload, dict) else None
        self.usage_known = isinstance(usage, dict) and all(
            type(value) is int and value >= 0 for value in (
                usage.get("prompt_tokens", usage.get("input_tokens")),
                usage.get("completion_tokens", usage.get("output_tokens")),
            )
        )
        if isinstance(usage, dict):
            details = usage.get("prompt_tokens_details") or usage.get("input_tokens_details") or {}
            self.cached_input_tokens = _non_negative_int(details.get("cached_tokens", 0)) if isinstance(details, dict) else 0
            self.unsupported_usage = payload.get("service_tier") not in (None, "default", "auto") or bool(usage.get("cache_creation_input_tokens")) or any(
                isinstance(usage.get(key), dict) and _non_negative_int(usage[key].get("audio_tokens", 0)) > 0
                for key in ("prompt_tokens_details", "completion_tokens_details", "input_tokens_details", "output_tokens_details")
            )

    def fail(self, error: BaseException) -> None:
        result, failure = model_failure(error)
        if self.result == "success" and failure and failure.source == "guard":
            return  # Validated response remains healthy when subsequent Guard code fails.
        self.result, self.failure = result, failure
        self.error_type = self.failure.error_type if self.failure else "none"
        if self.result != "cancelled":
            _log_model_failure(self.call_id, self.result, error)

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
            queue_duration_ms=self.queue_duration_ms, request_sent=self.request_sent,
            profile_ref=self.profile_ref,
            runtime_ref=self.runtime_ref,
            started_offset_ms=started_offset_ms,
            finished_offset_ms=started_offset_ms + duration_ms,
            time_to_first_token_ms=self.time_to_first_token_ms,
            call_id=self.call_id,
            usage_known=self.usage_known,
            cached_input_tokens=self.cached_input_tokens,
            unsupported_usage=self.unsupported_usage,
            input_tokens=self.input_tokens,
            output_tokens=self.output_tokens,
            retries=self.retries,
            backoff_ms=self.backoff_ms,
            error_type=self.error_type,
            error_source=self.failure.source if self.failure else None,
            error_category=self.failure.category if self.failure else None,
            http_status=self.failure.http_status if self.failure else None,
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
    endpoint_id = (
        request.request_context.endpoint_id
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
        "endpoint.id": endpoint_id or "__internal__",
        "gen_ai.provider.name": provider,
        "gen_ai.request.model": model,
        "gen_ai.operation.name": operation,
        "guardrail.evaluator.profile_ref": profile_ref or "__none__",
        "guardrail.model.runtime_ref": runtime_ref or "__none__",
    }
    observer_labels = {
        "guardrail_id": request.guardrail_id,
        "endpoint_id": endpoint_id or "__internal__",
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
        evidence_token = begin_model_http_call(tracker.call_id, provider, model)
        active_token = _ACTIVE_MODEL_CALL.set(tracker)
        try:
            yield tracker
        except BaseException as error:
            tracker.fail(error)
            if tracker.result not in {"success", "cancelled"}:
                span.record_exception(error)
                span.set_status(Status(StatusCode.ERROR, tracker.result))
            raise
        finally:
            finish_model_http_call(evidence_token, tracker.result, tracker.error_type)
            _ACTIVE_MODEL_CALL.reset(active_token)
            tracker.finished = time.perf_counter()
            usage = tracker.usage
            _collect_cost(usage)
            span.set_attribute("guardrail.model.result", usage.result)
            span.set_attribute("guardrail.model.call_id", usage.call_id)
            span.set_attribute("guardrail.model.duration_ms", usage.duration_ms)
            span.set_attribute("guardrail.model.queue_duration_ms", usage.queue_duration_ms)
            if usage.request_sent is not None:
                span.set_attribute("guardrail.model.request_sent", usage.request_sent)
            span.set_attribute("guardrail.model.error_type", usage.error_type)
            if usage.error_source:
                span.set_attribute("guardrail.error.source", usage.error_source)
                span.set_attribute("guardrail.error.category", usage.error_category or "unknown")
            if usage.http_status is not None:
                span.set_attribute("http.response.status_code", usage.http_status)
            span.set_attribute("gen_ai.usage.input_tokens", usage.input_tokens)
            span.set_attribute("gen_ai.usage.output_tokens", usage.output_tokens)
            span.set_attribute("guardrail.model.retries", usage.retries)
            span.set_attribute("guardrail.model.backoff_ms", usage.backoff_ms)
            if usage.time_to_first_token_ms is not None:
                span.set_attribute(
                    "guardrail.model.time_to_first_token_ms",
                    usage.time_to_first_token_ms,
                )
            if usage.result not in {"success", "cancelled"}:
                span.set_status(Status(StatusCode.ERROR, usage.result))
            # Preserve calls even when Guard code fails before returning ActionUsage.
            # The runtime deduplicates these against returned usage by call ID.
            if scope is not None:
                scope.calls.append(usage)
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
    result, failure = model_failure(error)
    return result, failure.error_type if failure else "none"


def model_failure(error: BaseException) -> tuple[ModelCallResult, Failure | None]:
    chain = model_error_chain(error)
    for item in chain:
        if isinstance(item, asyncio.CancelledError):
            if item.args == (SHORT_CIRCUIT_CANCEL,):
                return "cancelled", None
            return "timeout", Failure("guard", "deadline", "action_deadline")
        if isinstance(item, ModelConfigurationError):
            return "configuration_error", Failure("configuration", "configuration", type(item).__name__)
        if isinstance(item, ModelResponseError):
            return "invalid_response", Failure("model", item.category, item.error_type)
        if isinstance(item, LLMResponseValidationError):
            decoder = next((cause for cause in chain if isinstance(cause, json.JSONDecodeError)), None)
            return "invalid_response", Failure("model", "json_decode" if decoder else "response_schema",
                                               type(decoder if decoder is not None else item).__name__)
        if isinstance(item, json.JSONDecodeError):
            return "invalid_response", Failure("model", "json_decode", type(item).__name__)
        if isinstance(item, (httpx.TimeoutException, TimeoutError, LLMTimeoutError)):
            return "timeout", Failure("model", "timeout", type(item).__name__)
        if isinstance(item, LLMConnectionError):
            if isinstance(item.__cause__, RuntimeError):
                return "unknown_error", Failure("guard", "internal", type(item.__cause__).__name__)
            return "transport_error", Failure("model", "connection", type(item).__name__)
        if isinstance(item, (httpx.HTTPStatusError, ClientResponseError)) or isinstance(item, LLMClientError) and item.status_code >= 400:
            status = (item.response.status_code if isinstance(item, httpx.HTTPStatusError)
                      else item.status if isinstance(item, ClientResponseError) else item.status_code)
            if status in {408, 504}:
                result, source, category = "timeout", "model", "timeout"
            elif status == 429:
                result, source, category = "rate_limited", "model", "rate_limit"
            elif status >= 500:
                result, source, category = "server_error", "model", "unavailable"
            else:
                result, source = "client_error", "configuration"
                category = {401: "authentication", 403: "permission", 404: "not_found"}.get(status, "request_rejected")
            return result, Failure(source, category, f"http_{status}", status)
        if isinstance(item, (httpx.TransportError, ClientConnectionError)):
            return "transport_error", Failure("model", "connection", type(item).__name__)
    # A local programming exception is not evidence of a malformed model reply.
    return "unknown_error", Failure("guard", "internal", type(error).__name__)


def model_error_chain(error: BaseException) -> tuple[BaseException, ...]:
    chain: list[BaseException] = []
    seen: set[int] = set()
    while error is not None and id(error) not in seen and len(chain) < 8:
        seen.add(id(error))
        chain.append(error)
        error = error.__cause__ or error.__context__
    return tuple(chain)


def model_error_diagnostics(error: BaseException) -> dict[str, Any]:
    # No exception messages, request/response bodies, URLs or credentials.
    chain = model_error_chain(error)
    return {"error_type": type(error).__name__,
            "cause_types": [type(item).__name__ for item in chain],
            "os_error_numbers": [item.errno for item in chain
                                 if isinstance(item, OSError) and type(item.errno) is int]}


def _log_model_failure(call_id: str, result: ModelCallResult, error: BaseException) -> None:
    _, failure = model_failure(error)
    _LOGGER.warning("%s", json.dumps({"event": "model_call_failed", "call_id": call_id,
        "result": result, **model_error_diagnostics(error),
        "error_source": failure.source if failure else None,
        "error_category": failure.category if failure else None,
        "http_status": failure.http_status if failure else None}))


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
