from __future__ import annotations

import hmac
import base64
import json
import os
import time
import uuid
from dataclasses import asdict, replace
from typing import Any, Literal

from fastapi import APIRouter, Header, HTTPException, Request, Response
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel, ConfigDict, Field, model_validator
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from opentelemetry import trace

from runner.toolkit.runtime.contracts import GuardContentBlock, ProtectionDecision, ProtectionRequest, RequestContext
from runner.toolkit.runtime.service import GuardrailRuntimeService

from .artifact_store import ArtifactStore
from .routing import RoutingError
from .draft_preview import DraftPreviewRuntime
from .metrics import (
    GuardrailRequestObservation,
    INTERNAL_METRIC_ID,
    RunnerMetrics,
    UNMATCHED_METRIC_ID,
    UNRESOLVED_METRIC_ID,
)
from .output_streaming import OutputStreamEvaluationError, OutputStreamProcessor, OutputStreamSessionStore
from .toolkit.runtime.streaming import output_stream_contract
from .telemetry import RuntimeTelemetryExporter


LITELLM_ADAPTER_ID = "litellm-generic-guardrail"
SENSITIVE_HEADERS = frozenset({"authorization", "cookie", "proxy-authorization", "x-api-key"})
RUNTIME_LOG_AAD = b"tasklattice-runtime-log-v1"
_TRACER = trace.get_tracer("tasklattice.guard-runner.api")
GUARDRAIL_VERSION_PATTERN = r"^\d{8}-\d{6}\.\d{3}Z$"


class EvaluateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    phase: Literal["input", "output"] | None = None
    input_type: Literal["request", "response"] | None = None
    texts: list[str] = Field(default_factory=list, max_length=64)
    content: list["HTTPContentBlock"] = Field(default_factory=list, max_length=64)
    call_id: str | None = Field(default=None, min_length=1, max_length=256)
    protocol: Literal["http", "a2a"] = "http"
    messages: list[dict[str, Any]] = Field(default_factory=list, max_length=20)
    attributes: dict[str, str] = Field(default_factory=dict)
    # Endpoint clients cannot downgrade an enforced Router to detect-only.
    mode: Literal["enforce"] = "enforce"
    model: str | None = None
    method: str | None = None
    path: str | None = None
    host: str | None = None
    jwt_claims: dict[str, str] = Field(default_factory=dict)
    business_request: dict[str, str | list[str]] | None = None
    output_sink: Literal["display", "markdown", "html", "sql", "shell", "url", "json", "tool_argument"] | None = None
    content_type: str | None = Field(default=None, min_length=1, max_length=128)
    schema_id: str | None = Field(default=None, min_length=1, max_length=256)
    tool_name: str | None = Field(default=None, min_length=1, max_length=256)
    target_environment: str | None = Field(default=None, min_length=1, max_length=128)
    a2a_operation: str | None = None
    a2a_context_id: str | None = None
    a2a_task_id: str | None = None
    output_scope: Literal["interventions", "full"] = "interventions"

    @model_validator(mode="after")
    def validate_content_shape(self):
        if bool(self.texts) == bool(self.content):
            raise ValueError("Provide exactly one of texts or content.")
        expected_phase = "input" if self.input_type == "request" else "output"
        if self.phase is not None and self.input_type is not None and self.phase != expected_phase:
            raise ValueError("phase and input_type describe different protection phases.")
        ids = [item.id or f"{self.resolved_phase}:{index}" for index, item in enumerate(self.content)]
        if len(ids) != len(set(ids)):
            raise ValueError("Content block identifiers must be unique.")
        return self

    @property
    def resolved_phase(self) -> Literal["input", "output"]:
        if self.phase is not None:
            return self.phase
        return "output" if self.input_type == "response" else "input"


class HTTPContentBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str | None = Field(default=None, min_length=1, max_length=160)
    text: str = Field(min_length=1, max_length=100_000)
    role: Literal["user_input", "query", "retrieved_content", "grounding_source", "tool_output", "model_output"]
    source: Literal["user_input", "query", "retrieved_content", "grounding_source", "tool_output", "model_output"] | None = None
    qualifiers: list[Literal["guard_content", "query", "grounding_source"]] = Field(default_factory=list, max_length=3)
    source_id: str | None = Field(default=None, min_length=1, max_length=256)
    source_type: str | None = Field(default=None, min_length=1, max_length=64)
    tool_name: str | None = Field(default=None, min_length=1, max_length=256)
    retrieval_index: int | None = Field(default=None, ge=0, le=1_000_000)
    provenance_id: str | None = Field(default=None, min_length=1, max_length=256)
    mime_type: str | None = Field(default=None, min_length=1, max_length=128)
    origin_hash: str | None = Field(default=None, min_length=16, max_length=128, pattern=r"^[A-Za-z0-9:_-]+$")

    @model_validator(mode="after")
    def validate_qualifiers(self):
        if "query" in self.qualifiers and self.role != "query":
            raise ValueError("The query qualifier requires the query role.")
        if "grounding_source" in self.qualifiers and self.role not in {"retrieved_content", "grounding_source"}:
            raise ValueError("The grounding_source qualifier requires a grounding-source role.")
        return self


EvaluateRequest.model_rebuild()


class GuardrailEvaluateRequest(EvaluateRequest):
    protocol: Literal["playground"] = "playground"
    guardrail_version: str = Field(pattern=GUARDRAIL_VERSION_PATTERN)


class DraftPreviewPrepareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    preview_id: str = Field(min_length=1, max_length=256)
    guardrail_id: str = Field(min_length=1, max_length=256)
    draft_revision: int = Field(gt=0)
    candidate_version: str = Field(pattern=GUARDRAIL_VERSION_PATTERN)
    plan: dict[str, Any]
    runtime_profile: str = Field(min_length=1, max_length=128)


class DraftPreviewEvaluateRequest(EvaluateRequest):
    preview_id: str = Field(min_length=1, max_length=256)
    draft_revision: int = Field(gt=0)
    candidate_version: str = Field(pattern=GUARDRAIL_VERSION_PATTERN)
    plan: dict[str, Any]
    runtime_profile: str = Field(min_length=1, max_length=128)
    protocol: Literal["playground"] = "playground"


class LiteLLMGuardrailRequest(BaseModel):
    """LiteLLM Basic Guardrail API request contract."""

    model_config = ConfigDict(extra="allow")

    input_type: Literal["request", "response"]
    litellm_call_id: str | None = None
    litellm_trace_id: str | None = None
    structured_messages: list[dict[str, Any]] | None = None
    images: list[str] | None = None
    tools: list[dict[str, Any]] | None = None
    texts: list[str] | None = None
    request_data: dict[str, Any] = Field(default_factory=dict)
    request_headers: dict[str, str | list[str]] | None = None
    litellm_version: str | None = None
    additional_provider_specific_params: dict[str, Any] | None = None
    tool_calls: list[dict[str, Any]] | None = None
    model: str | None = None


class LiteLLMGuardrailResponse(BaseModel):
    action: Literal["NONE", "BLOCKED", "GUARDRAIL_INTERVENED"]
    blocked_reason: str | None = None
    texts: list[str] | None = None
    images: list[str] | None = None
    tools: list[dict[str, Any]] | None = None


class OutputStreamRequest(BaseModel):
    """One ordered model-output chunk for Guardrail-controlled release."""

    model_config = ConfigDict(extra="forbid")

    stream_id: str = Field(min_length=1, max_length=256)
    sequence: int = Field(ge=0)
    text: str = Field(default="", max_length=100_000)
    final: bool = False
    call_id: str | None = Field(default=None, min_length=1, max_length=256)
    protocol: Literal["http", "a2a", "litellm"] = "http"
    messages: list[dict[str, Any]] = Field(default_factory=list, max_length=20)
    request_data: dict[str, Any] = Field(default_factory=dict)
    request_headers: dict[str, str] = Field(default_factory=dict)
    attributes: dict[str, str] = Field(default_factory=dict)
    model: str | None = None
    output_sink: Literal["display", "markdown", "html", "sql", "shell", "url", "json", "tool_argument"] | None = None

    @model_validator(mode="after")
    def validate_chunk(self):
        if not self.text and not self.final:
            raise ValueError("A non-final output stream chunk must contain text.")
        return self


class RunnerAPI:
    def __init__(
        self,
        runtime: GuardrailRuntimeService,
        store: ArtifactStore,
        metrics: RunnerMetrics,
        telemetry: RuntimeTelemetryExporter,
        runner_id: str,
        controller_token: str,
        runtime_log_encryption_key: bytes | None = None,
        draft_previews: DraftPreviewRuntime | None = None,
        output_streams: OutputStreamProcessor | None = None,
    ) -> None:
        self.router = APIRouter()
        self._runtime = runtime
        self._store = store
        self._metrics = metrics
        self._telemetry = telemetry
        if isinstance(runtime, GuardrailRuntimeService):
            async def routing_event_sink(event):
                await telemetry.emit({**event, "runnerId": runner_id})
            runtime.routing_event_sink = routing_event_sink
        self._runner_id = runner_id
        self._controller_token = controller_token
        self._runtime_log_encryption_key = runtime_log_encryption_key
        self._draft_previews = draft_previews
        self._output_streams = output_streams or OutputStreamSessionStore()
        self._register()
        from .path_testing import register_path_testing
        register_path_testing(self)

    def _trace_request_id(self, fallback: str) -> str:
        """Prefer the active trace id without requiring legacy metric fakes to expose one."""

        trace_id = getattr(self._metrics, "current_trace_id", None)
        return (trace_id() if callable(trace_id) else None) or fallback

    def _register(self) -> None:
        @self.router.get("/")
        async def index():
            return {
                "component": "guard-runner",
                "role": "data-plane",
                "status": "ok",
                "endpoints": {
                    "readiness": "/health/ready",
                    "liveness": "/health/live",
                    "metrics": "/metrics",
                    "verify": "/runtime/v1/endpoints/{endpoint_id}/verify",
                    "litellm": "/runtime/v1/endpoints/{endpoint_id}/beta/litellm_basic_guardrail_api",
                    "evaluate": "/runtime/v1/endpoints/{endpoint_id}/guardrails/evaluate",
                    "output_stream": "/runtime/v1/endpoints/{endpoint_id}/guardrails/output-stream",
                    "controller_evaluate": "/internal/v1/guardrails/{guardrail_id}/evaluate",
                    "draft_preview": "/internal/v1/playground/draft-previews/{preview_id}",
                },
            }

        @self.router.post("/runtime/v1/endpoints/{endpoint_id}/verify")
        async def verify(
            endpoint_id: str,
            x_api_key: str | None = Header(default=None),
        ):
            authenticated = self._store.authenticate_endpoint(endpoint_id, x_api_key)
            self._metrics.observe_authentication("litellm", authenticated)
            if not authenticated:
                raise HTTPException(status_code=401, detail="Endpoint credential is invalid.")
            adapter = self._store.endpoint_adapter(endpoint_id)
            if adapter != LITELLM_ADAPTER_ID:
                raise HTTPException(status_code=409, detail="Endpoint adapter is not compatible with LiteLLM.")
            return {
                "ready": True,
                "adapter_id": adapter,
                "protocol": "litellm",
            }

        @self.router.post(
            "/runtime/v1/endpoints/{endpoint_id}/beta/litellm_basic_guardrail_api",
            response_model=LiteLLMGuardrailResponse,
            response_model_exclude_none=True,
        )
        async def apply_litellm_guardrail(
            endpoint_id: str,
            payload: LiteLLMGuardrailRequest,
            request: Request,
            response: Response,
            x_api_key: str | None = Header(default=None),
        ) -> LiteLLMGuardrailResponse:
            phase = "input" if payload.input_type == "request" else "output"
            authenticated = self._store.authenticate_endpoint(endpoint_id, x_api_key)
            self._metrics.observe_authentication("litellm", authenticated)
            adapter_matches = self._store.endpoint_adapter(endpoint_id) == LITELLM_ADAPTER_ID
            if not authenticated:
                self._metrics.reject_request("litellm", phase=phase, result="authentication_rejected")
                raise HTTPException(status_code=401, detail="Endpoint credential is invalid.")
            if not adapter_matches:
                self._metrics.reject_request("litellm", phase=phase, result="adapter_mismatch")
                raise HTTPException(status_code=409, detail="Endpoint adapter is not compatible with LiteLLM.")
            request_id = str(uuid.uuid4())
            started = time.perf_counter()
            try:
                protection_request = _litellm_protection_request(payload, endpoint_id, request)
            except RoutingError as error:
                raise HTTPException(status_code=503, detail=error.reason) from error
            decision = None
            with self._metrics.request(
                "runtime", "litellm", phase, endpoint_id=endpoint_id,
            ) as observation:
                request_id = self._trace_request_id(request_id)
                try:
                    route_matched = True
                    try:
                        decision = await self._runtime.evaluate(
                            protection_request, on_resolved=observation.resolve,
                        )
                    except LookupError:
                        route_matched = False
                        observation.set_identity(
                            guardrail_id=UNMATCHED_METRIC_ID,
                            guardrail_version=UNMATCHED_METRIC_ID,
                            router_id=UNMATCHED_METRIC_ID,
                        )
                        decision = ProtectionDecision(
                            decision="block",
                            action="reject",
                            reason="No Router matches this request.",
                            mode=protection_request.mode,
                        )
                    self._metrics.observe_route("litellm", phase, route_matched)
                    observation.complete(decision)
                    self._path_response_headers(response, decision)
                    return _litellm_response(decision)
                except RoutingError as error:
                    observation.fail("runtime", error.reason)
                    raise HTTPException(status_code=503, detail=str(error)) from error
                except Exception as error:
                    reason_class = _request_failure_reason(error)
                    observation.fail("runtime", reason_class)
                    self._metrics.observe_failure("runtime", reason_class)
                    raise
                finally:
                    await self._emit_telemetry(
                        request_id=request_id,
                        call_id=protection_request.call_id,
                        endpoint_id=endpoint_id,
                        phase=phase,
                        protocol="litellm",
                        mode=protection_request.mode,
                        started=started,
                        decision=decision,
                        content_before=protection_request.texts,
                        observation=observation,
                    )

        @self.router.post("/runtime/v1/endpoints/{endpoint_id}/guardrails/evaluate")
        async def evaluate(
            endpoint_id: str,
            payload: EvaluateRequest,
            request: Request,
            response: Response,
            x_api_key: str | None = Header(default=None),
        ):
            expected_adapter = "a2a-guard" if payload.protocol == "a2a" else "generic-http-guard"
            authenticated = self._store.authenticate_endpoint(endpoint_id, x_api_key)
            self._metrics.observe_authentication(payload.protocol, authenticated)
            adapter_matches = self._store.endpoint_adapter(endpoint_id) == expected_adapter
            if not authenticated:
                self._metrics.reject_request(
                    payload.protocol, payload.resolved_phase, "authentication_rejected",
                )
                raise HTTPException(status_code=401, detail="Endpoint credential is invalid.")
            if not adapter_matches:
                self._metrics.reject_request(payload.protocol, payload.resolved_phase, "adapter_mismatch")
                raise HTTPException(status_code=409, detail="Endpoint adapter does not match this protocol.")
            request_id = str(uuid.uuid4())
            started = time.perf_counter()
            decision = None
            try:
                protection_request = _http_protection_request(payload, request, endpoint_id)
            except RoutingError as error:
                raise HTTPException(status_code=503, detail=error.reason) from error
            with self._metrics.request(
                "runtime", payload.protocol, payload.resolved_phase,
                endpoint_id=endpoint_id,
            ) as observation:
                request_id = self._trace_request_id(request_id)
                try:
                    route_matched = True
                    try:
                        decision = await self._runtime.evaluate(
                            protection_request, on_resolved=observation.resolve,
                        )
                    except LookupError:
                        route_matched = False
                        observation.set_identity(
                            guardrail_id=UNMATCHED_METRIC_ID,
                            guardrail_version=UNMATCHED_METRIC_ID,
                            router_id=UNMATCHED_METRIC_ID,
                        )
                        decision = ProtectionDecision(
                            decision="block", action="reject",
                            reason="No Router matches this request.",
                            mode=payload.mode,
                        )
                    self._metrics.observe_route(
                        payload.protocol, payload.resolved_phase, route_matched,
                    )
                    observation.complete(decision)
                    self._path_response_headers(response, decision)
                    return {**jsonable_encoder(asdict(decision)), "call_id": protection_request.call_id}
                except RoutingError as error:
                    observation.fail("runtime", error.reason)
                    raise HTTPException(status_code=503, detail=str(error)) from error
                except Exception as error:
                    reason_class = _request_failure_reason(error)
                    observation.fail("runtime", reason_class)
                    self._metrics.observe_failure("runtime", reason_class)
                    raise
                finally:
                    await self._emit_telemetry(
                        request_id=request_id,
                        call_id=protection_request.call_id,
                        endpoint_id=endpoint_id,
                        phase=payload.resolved_phase,
                        protocol=payload.protocol,
                        mode=payload.mode,
                        started=started,
                        decision=decision,
                        content_before=_request_content(protection_request),
                        observation=observation,
                    )

        @self.router.post("/runtime/v1/endpoints/{endpoint_id}/guardrails/output-stream")
        async def evaluate_output_stream(
            endpoint_id: str,
            payload: OutputStreamRequest,
            request: Request,
            x_api_key: str | None = Header(default=None),
        ):
            expected_adapter = {
                "a2a": "a2a-guard", "http": "generic-http-guard", "litellm": LITELLM_ADAPTER_ID,
            }[payload.protocol]
            authenticated = self._store.authenticate_endpoint(endpoint_id, x_api_key)
            self._metrics.observe_authentication(payload.protocol, authenticated)
            if not authenticated:
                self._metrics.reject_request(payload.protocol, "output", "authentication_rejected")
                raise HTTPException(status_code=401, detail="Endpoint credential is invalid.")
            if self._store.endpoint_adapter(endpoint_id) != expected_adapter:
                self._metrics.reject_request(payload.protocol, "output", "adapter_mismatch")
                raise HTTPException(status_code=409, detail="Endpoint adapter does not match this protocol.")

            if payload.protocol == "litellm":
                # Preserve the same principal, routing fields and call identity
                # used by the pre-call Generic Guardrail API callback.
                protection_request = _litellm_protection_request(LiteLLMGuardrailRequest(
                    input_type="response", texts=[payload.text or " "],
                    litellm_call_id=payload.call_id or payload.stream_id,
                    structured_messages=payload.messages, model=payload.model,
                    request_data=payload.request_data, request_headers=payload.request_headers,
                ), endpoint_id, request)
            else:
                evaluate_payload = EvaluateRequest(
                    phase="output", texts=[payload.text or " "],
                    call_id=payload.call_id or payload.stream_id, protocol=payload.protocol,
                    messages=payload.messages, attributes=payload.attributes,
                    model=payload.model, output_sink=payload.output_sink,
                )
                protection_request = _http_protection_request(evaluate_payload, request, endpoint_id)
            protection_request = replace(protection_request, context=replace(protection_request.context,
                fields=(*protection_request.context.fields, ("routing.stream", "true"))))
            try:
                resolutions = []
                mode = self._runtime.output_delivery(protection_request, on_resolved=resolutions.append,
                                                     require_existing=payload.sequence > 0,
                                                     allow_new_output=payload.call_id is None)
                resolution = resolutions[0]
                if isinstance(self._runtime, GuardrailRuntimeService):
                    await self._runtime.publish_assignment(resolution, protection_request.call_id)
                contract = output_stream_contract(resolution.plan)

                async def evaluate_candidate(candidate: ProtectionRequest) -> ProtectionDecision:
                    started = time.perf_counter()
                    decision = None
                    try:
                        decision = await self._runtime.evaluate(candidate)
                        return decision
                    finally:
                        await self._emit_telemetry(
                            request_id=str(uuid.uuid4()),
                            call_id=candidate.call_id,
                            endpoint_id=endpoint_id,
                            phase="output",
                            protocol=f"{payload.protocol}-stream",
                            mode=candidate.mode,
                            started=started,
                            decision=decision,
                            content_before=candidate.texts,
                            stream_metadata={"streamId": payload.stream_id, "streamSequence": payload.sequence,
                                             "streamFinalCheck": payload.final and decision is not None,
                                             "effectiveOutputDelivery": mode},
                        )

                result = await self._output_streams.process(
                    stream_key=f"{endpoint_id}:{payload.stream_id}",
                    sequence=payload.sequence,
                    text=payload.text,
                    final=payload.final,
                    mode=mode,
                    request=protection_request,
                    evaluate=evaluate_candidate,
                )
                if isinstance(self._runtime, GuardrailRuntimeService) and (result.final or result.terminate):
                    await self._runtime.complete_call(resolution, protection_request.call_id,
                        result.decision.decision if result.decision else "allow")
            except RoutingError as error:
                raise HTTPException(status_code=503, detail=error.reason) from error
            except OutputStreamEvaluationError as error:
                if isinstance(self._runtime, GuardrailRuntimeService) and resolutions:
                    await self._runtime.complete_call(resolutions[0], protection_request.call_id,
                        "timeout" if error.timed_out else "error", type(error).__name__)
                raise HTTPException(status_code=504 if error.timed_out else 502, detail=str(error)) from error
            except LookupError as error:
                raise HTTPException(status_code=404, detail=str(error)) from error
            except ValueError as error:
                raise HTTPException(status_code=409, detail=str(error)) from error
            response = {
                "stream_id": payload.stream_id,
                "sequence": result.sequence,
                "next_sequence": result.next_sequence,
                "mode": result.mode,
                "requested_mode": contract.requested_mode,
                "delivery_reason": contract.reason,
                "effective_release_id": resolution.effective_release_id,
                "model_revision_id": resolution.model_revision_id,
                "status": result.status,
                "released_text": result.released_text,
                "terminate": result.terminate,
                "final": result.final,
            }
            if result.decision is not None:
                response["decision"] = jsonable_encoder(asdict(result.decision))
            return response

        @self.router.post("/internal/v1/guardrails/{guardrail_id}/evaluate")
        async def evaluate_guardrail(
            guardrail_id: str,
            payload: GuardrailEvaluateRequest,
            request: Request,
            authorization: str | None = Header(default=None),
        ):
            expected = f"Bearer {self._controller_token}"
            if authorization is None or not hmac.compare_digest(authorization, expected):
                raise HTTPException(status_code=401, detail="Controller authentication failed.")
            request_id = str(uuid.uuid4())
            started = time.perf_counter()
            decision = None
            protection_request = ProtectionRequest(
                phase=payload.resolved_phase,
                texts=tuple(payload.texts),
                context=RequestContext(
                    protocol=payload.protocol,
                    endpoint_id=None,
                    headers=tuple(
                        (key, value)
                        for key, value in request.headers.items()
                        if key.lower() not in SENSITIVE_HEADERS
                    ),
                    fields=tuple(payload.attributes.items()),
                ),
                call_id=payload.call_id,
                messages=tuple(payload.messages),
                mode=payload.mode,
            )
            with self._metrics.request(
                "controller",
                payload.protocol,
                payload.resolved_phase,
                endpoint_id=INTERNAL_METRIC_ID,
                guardrail_id=guardrail_id,
                guardrail_version=payload.guardrail_version,
                router_id=UNRESOLVED_METRIC_ID,
            ) as observation:
                request_id = self._trace_request_id(request_id)
                try:
                    decision = await self._runtime.evaluate_guardrail(
                        protection_request,
                        guardrail_id,
                        payload.guardrail_version,
                        on_resolved=observation.resolve,
                    )
                    observation.complete(decision)
                    return jsonable_encoder(asdict(decision))
                except LookupError as error:
                    observation.fail("routing", "guardrail_not_loaded")
                    self._metrics.observe_failure("runtime", "guardrail_not_loaded")
                    raise HTTPException(status_code=404, detail=str(error)) from error
                finally:
                    await self._emit_telemetry(
                        request_id=request_id,
                        call_id=payload.call_id,
                        endpoint_id=None,
                        phase=payload.resolved_phase,
                        protocol=payload.protocol,
                        mode=payload.mode,
                        started=started,
                        decision=decision,
                        content_before=protection_request.texts,
                        observation=observation,
                    )

        @self.router.post("/internal/v1/playground/draft-previews/{preview_id}")
        async def prepare_draft_preview(
            preview_id: str,
            payload: DraftPreviewPrepareRequest,
            authorization: str | None = Header(default=None),
        ):
            self._authorize_controller(authorization)
            if self._draft_previews is None:
                raise HTTPException(status_code=503, detail="This Runner cannot compile draft previews.")
            if preview_id != payload.preview_id:
                raise HTTPException(status_code=409, detail="Draft preview identity does not match the request path.")
            try:
                return await self._draft_previews.prepare(
                    preview_id=payload.preview_id,
                    guardrail_id=payload.guardrail_id,
                    draft_revision=payload.draft_revision,
                    candidate_version=payload.candidate_version,
                    plan=payload.plan,
                    runtime_profile=payload.runtime_profile,
                )
            except ValueError as error:
                raise HTTPException(status_code=409, detail=str(error)) from error
            except Exception as error:
                raise HTTPException(status_code=422, detail=str(error)) from error

        @self.router.post("/internal/v1/playground/draft-previews/{preview_id}/evaluate")
        async def evaluate_draft_preview(
            preview_id: str,
            payload: DraftPreviewEvaluateRequest,
            request: Request,
            authorization: str | None = Header(default=None),
        ):
            self._authorize_controller(authorization)
            if self._draft_previews is None:
                raise HTTPException(status_code=503, detail="This Runner cannot compile draft previews.")
            if preview_id != payload.preview_id:
                raise HTTPException(status_code=409, detail="Draft preview identity does not match the request path.")
            protection_request = ProtectionRequest(
                phase=payload.resolved_phase,
                texts=tuple(payload.texts),
                context=RequestContext(
                    protocol=payload.protocol,
                    endpoint_id=None,
                    headers=tuple(
                        (key, value)
                        for key, value in request.headers.items()
                        if key.lower() not in SENSITIVE_HEADERS
                    ),
                    fields=tuple((
                        *payload.attributes.items(),
                        ("playground.target_kind", "draft"),
                        ("playground.draft_revision", str(payload.draft_revision)),
                    )),
                ),
                call_id=payload.call_id,
                messages=tuple(payload.messages),
                mode=payload.mode,
            )
            with self._metrics.request(
                "playground",
                payload.protocol,
                payload.resolved_phase,
                endpoint_id=INTERNAL_METRIC_ID,
                guardrail_id=payload.plan.get("guardrail_id", UNRESOLVED_METRIC_ID),
                guardrail_version=payload.candidate_version,
                router_id=UNRESOLVED_METRIC_ID,
            ) as observation:
                try:
                    decision = await self._draft_previews.evaluate(
                        protection_request,
                        preview_id=payload.preview_id,
                        guardrail_id=payload.plan.get("guardrail_id", ""),
                        draft_revision=payload.draft_revision,
                        candidate_version=payload.candidate_version,
                        plan=payload.plan,
                        runtime_profile=payload.runtime_profile,
                    )
                    observation.complete(decision)
                    # Draft previews are deliberately excluded from Runtime Evidence telemetry.
                    return jsonable_encoder(asdict(decision))
                except LookupError as error:
                    raise HTTPException(status_code=404, detail=str(error)) from error
                except ValueError as error:
                    raise HTTPException(status_code=409, detail=str(error)) from error

    def _authorize_controller(self, authorization: str | None) -> None:
        expected = f"Bearer {self._controller_token}"
        if authorization is None or not hmac.compare_digest(authorization, expected):
            raise HTTPException(status_code=401, detail="Controller authentication failed.")

    def _path_response_headers(self, response: Response, decision: ProtectionDecision) -> None:
        response.headers["x-guard-runner-id"] = self._runner_id
        if decision.route_assignment:
            response.headers["x-guard-route-assignment"] = json.dumps(decision.route_assignment, ensure_ascii=True, separators=(",", ":"))

    async def _emit_telemetry(
        self,
        *,
        request_id: str,
        call_id: str | None,
        endpoint_id: str | None,
        phase: Literal["input", "output"],
        protocol: str,
        mode: str,
        started: float,
        decision: ProtectionDecision | None,
        content_before: tuple[str, ...] = (),
        observation: GuardrailRequestObservation | None = None,
        stream_metadata: dict[str, Any] | None = None,
    ) -> None:
        capture_level = self._store.logging_level(
            decision.guardrail_id if decision is not None else None
        )
        runtime_log_captured = _runtime_log_qualifies(capture_level, decision)
        event = {
            "id": request_id,
            "occurredAt": _iso_now(),
            "requestId": call_id or request_id,
            "runnerId": self._runner_id,
            "direction": "incoming" if phase == "input" else "outgoing",
            "decision": decision.decision if decision is not None else "error",
            "durationMs": max(0, round((time.perf_counter() - started) * 1_000)),
            "metadata": {
                "protocol": protocol,
                "mode": mode,
                "captureLevel": capture_level,
                "runtimeLogCaptured": runtime_log_captured,
                "contentAvailable": False,
                **(stream_metadata or {}),
            },
        }
        if endpoint_id is not None:
            event["endpointId"] = endpoint_id
        if decision is not None:
            event["metadata"].update(_telemetry_metadata(decision))
            if runtime_log_captured and self._runtime_log_encryption_key:
                event["metadata"]["contentCiphertext"] = _encrypt_runtime_log_content(
                    self._runtime_log_encryption_key,
                    phase,
                    content_before,
                    decision.texts or content_before,
                )
            if decision.guardrail_id:
                event["guardrailId"] = decision.guardrail_id
            if decision.guardrail_version:
                event["guardrailVersion"] = decision.guardrail_version
            if decision.router_id:
                event["routerId"] = decision.router_id
        try:
            with _TRACER.start_as_current_span(
                "guardrail.telemetry.append",
                attributes={
                    "guardrail.id": (
                        decision.guardrail_id
                        if decision is not None and decision.guardrail_id
                        else "__unresolved__"
                    ),
                    "guardrail.phase": phase,
                    "guardrail.protocol": protocol,
                    "endpoint.id": endpoint_id or "__internal__",
                    "guardrail.telemetry.capture_level": capture_level,
                },
            ):
                await self._telemetry.emit(event)
        except TimeoutError:
            self._metrics.observe_failure("telemetry", "timeout")
            if observation is None or observation.failure_stage is None:
                if observation is not None:
                    observation.fail("telemetry", "timeout")
                raise
        except Exception:
            self._metrics.observe_failure("telemetry", "telemetry_append_failed")
            if observation is None or observation.failure_stage is None:
                if observation is not None:
                    observation.fail("telemetry", "telemetry_append_failed")
                raise


def _telemetry_metadata(decision: ProtectionDecision) -> dict[str, Any]:
    """Return structured evidence; guarded content is exported only as ciphertext."""
    usage = asdict(decision.usage) if decision.usage is not None else None
    coverage = asdict(decision.coverage) if decision.coverage is not None else None
    findings = [
        {
            "id": f"finding-{index}",
            "risk": item.risk,
            "taxonomyId": item.taxonomy_id,
            "verdict": item.verdict,
            "confidence": item.confidence,
            "recommendedAction": item.recommended_action,
            "policyId": item.policy_id,
            "ruleId": item.rule_id,
            "providerEvidence": [asdict(evidence) for evidence in item.provider_evidence],
        }
        for index, item in enumerate(decision.findings, start=1)
    ]
    trace = [
        {
            "id": item.id,
            "kind": item.kind,
            "name": item.name,
            "status": item.status,
            "durationMs": item.duration_ms,
            "parentId": item.parent_id,
            "contractRef": item.contract_ref,
            "verdict": item.verdict,
            "route": item.route,
            "capability": item.capability,
            "moduleId": item.module_id,
            "confidence": item.confidence,
            "policyId": item.policy_id,
            "policyVersion": item.policy_version,
            "railType": item.rail_type,
            "flowName": item.flow_name,
            "actionName": item.action_name,
            "actionVersion": item.action_version,
            "outcome": item.outcome,
            "timeoutMs": item.timeout_ms,
            "timedOut": item.timed_out,
            "parallelGroup": item.parallel_group,
            "engine": item.engine,
            "runtimeProfile": item.runtime_profile,
            "configChecksum": item.config_checksum,
            "providerLatencyMs": item.provider_latency_ms,
            "providerWorkMs": item.provider_work_ms,
            "modelWaitMs": item.model_wait_ms,
            "providerName": item.provider_name,
            "modelName": item.model_name,
            "modelOperation": item.model_operation,
            "modelResult": item.model_result,
            "errorType": item.error_type,
            "modelTimeToFirstTokenMs": item.model_time_to_first_token_ms,
            "modelInputTokens": item.model_input_tokens,
            "modelOutputTokens": item.model_output_tokens,
            "modelRetries": item.model_retries,
            "modelBackoffMs": item.model_backoff_ms,
            "startedOffsetMs": item.started_offset_ms,
            "finishedOffsetMs": item.finished_offset_ms,
            "evaluatorId": item.evaluator_id,
            "profileRef": item.profile_ref,
        }
        for item in decision.trace
    ]
    risks = sorted({item.risk for item in decision.findings})
    return {
        "action": decision.action,
        "risks": risks,
        "findings": findings,
        "trace": trace,
        "usage": usage,
        "coverage": coverage,
        "outputDelivery": decision.output_delivery,
        "effectiveReleaseId": decision.effective_release_id,
        "modelRevisionId": decision.model_revision_id,
    }


def _runtime_log_qualifies(
    level: str,
    decision: ProtectionDecision | None,
) -> bool:
    if decision is None:
        return True
    timed_out = any(item.timed_out for item in decision.trace)
    fail_closed = bool(decision.usage and decision.usage.fail_closed)
    if level == "trace":
        return True
    if decision.decision == "block" or timed_out or fail_closed:
        return True
    return level == "debug" and decision.decision == "transform"


def _encrypt_runtime_log_content(
    key: bytes,
    phase: Literal["input", "output"],
    before: tuple[str, ...],
    after: tuple[str, ...],
) -> str:
    role = "user_input" if phase == "input" else "model_output"
    payload = {
        "contentBefore": _runtime_log_blocks(before, role),
        "contentAfter": _runtime_log_blocks(after, role),
    }
    nonce = os.urandom(12)
    encrypted = AESGCM(key).encrypt(
        nonce,
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode(),
        RUNTIME_LOG_AAD,
    )
    ciphertext, tag = encrypted[:-16], encrypted[-16:]
    return ":".join((
        RUNTIME_LOG_AAD.decode(),
        base64.b64encode(nonce).decode(),
        base64.b64encode(tag).decode(),
        base64.b64encode(ciphertext).decode(),
    ))


def _runtime_log_blocks(values: tuple[str, ...], role: str) -> list[dict[str, Any]]:
    result = []
    for index, value in enumerate(values[:64], start=1):
        result.append({
            "id": f"content-{index}",
            "role": role,
            "source": role,
            "text": value[:8_000],
            "truncated": len(value) > 8_000,
        })
    return result


def _http_protection_request(
    payload: EvaluateRequest,
    request: Request,
    endpoint_id: str,
) -> ProtectionRequest:
    headers = {
        key.lower(): value
        for key, value in request.headers.items()
        if key.lower() not in SENSITIVE_HEADERS
    }
    method = (payload.method or headers.get("x-original-method") or request.method).upper()
    path = payload.path or headers.get("x-original-uri") or request.url.path
    host = payload.host or headers.get("x-forwarded-host") or request.url.hostname or ""
    fields = {
        **{str(key): str(value) for key, value in payload.attributes.items()},
        "protocol": payload.protocol,
        "endpoint.id": endpoint_id,
        "auth.principal": endpoint_id,
        "http.method": method,
        "http.path": path,
        "http.host": host,
        "model": payload.model or "",
    }
    fields.update({
        key: value
        for key, value in {
            "output.sink": payload.output_sink,
            "output.content_type": payload.content_type,
            "output.schema_id": payload.schema_id,
            "tool.name": payload.tool_name,
            "target.environment": payload.target_environment,
        }.items()
        if value is not None
    })
    if payload.jwt_claims:
        fields["auth.claim_source"] = "endpoint_asserted"
    if payload.protocol == "a2a":
        fields.update({
            "a2a.version": headers.get("a2a-version", ""),
            "a2a.extensions": headers.get("a2a-extensions", ""),
            "a2a.operation": payload.a2a_operation or "",
            "a2a.context_id": payload.a2a_context_id or "",
            "a2a.task_id": payload.a2a_task_id or "",
        })
    external_call_id = payload.call_id or payload.a2a_task_id or payload.a2a_context_id
    if external_call_id is None and payload.resolved_phase == "input":
        external_call_id = f"http-{uuid.uuid4().hex}"
    return ProtectionRequest(
        phase=payload.resolved_phase,
        texts=tuple(payload.texts),
        content_blocks=_http_content_blocks(payload),
        context=RequestContext(
            protocol=payload.protocol,
            endpoint_id=endpoint_id,
            headers=tuple(sorted(headers.items())),
            # Unverified endpoint assertions are not authenticated JWT claims.
            jwt_claims=(),
            fields=tuple(sorted(fields.items())),
            endpoint_request=_endpoint_source(request),
            business_request=_source_pairs(payload.business_request),
        ),
        call_id=_scoped_call_id(endpoint_id, external_call_id),
        messages=tuple(payload.messages),
        mode=payload.mode,
        evidence_scope=payload.output_scope,
    )


def _http_content_blocks(payload: EvaluateRequest) -> tuple[GuardContentBlock, ...]:
    blocks: list[GuardContentBlock] = []
    for index, item in enumerate(payload.content):
        qualifiers = set(item.qualifiers)
        if item.role == "query":
            qualifiers.add("query")
        if item.role in {"retrieved_content", "grounding_source"}:
            qualifiers.add("grounding_source")
        if payload.resolved_phase == "input" or item.role in {"user_input", "tool_output", "model_output"}:
            qualifiers.add("guard_content")
        source = item.source or item.role
        blocks.append(GuardContentBlock(
            id=item.id or f"{payload.resolved_phase}:{index}",
            text=item.text,
            role=item.role,
            trust="untrusted",
            source=source,
            qualifiers=tuple(
                qualifier
                for qualifier in ("guard_content", "query", "grounding_source")
                if qualifier in qualifiers
            ),
            metadata=tuple(
                (key, str(value))
                for key, value in (
                    ("source_id", item.source_id),
                    ("source_type", item.source_type),
                    ("tool_name", item.tool_name),
                    ("retrieval_index", item.retrieval_index),
                    ("provenance_id", item.provenance_id),
                    ("mime_type", item.mime_type),
                    ("origin_hash", item.origin_hash),
                )
                if value is not None
            ),
        ))
    return tuple(blocks)


def _request_content(request: ProtectionRequest) -> tuple[str, ...]:
    if request.content_blocks:
        return tuple(item.text for item in request.content_blocks if item.guard_content)
    return request.texts


def _litellm_protection_request(
    payload: LiteLLMGuardrailRequest,
    endpoint_id: str,
    request: Request | None = None,
) -> ProtectionRequest:
    headers = {
        str(key).lower(): str(value)
        for key, value in (payload.request_headers or {}).items()
        if str(key).lower() not in SENSITIVE_HEADERS
    }
    native_fields = {
        "user_api_key_hash": "litellm.api_key_hash",
        "user_api_key_alias": "litellm.api_key_alias",
        "user_api_key_user_id": "litellm.user_id",
        "user_api_key_user_email": "litellm.user_email",
        "user_api_key_team_id": "litellm.team_id",
        "user_api_key_team_alias": "litellm.team_alias",
        "user_api_key_end_user_id": "litellm.end_user_id",
        "user_api_key_org_id": "litellm.org_id",
        "output_sink": "output.sink",
        "content_type": "output.content_type",
        "schema_id": "output.schema_id",
        "tool_name": "tool.name",
        "target_environment": "target.environment",
    }
    fields = {
        target: str(payload.request_data[source])
        for source, target in native_fields.items()
        if payload.request_data.get(source) is not None
    }
    principal = next(
        (
            fields[key]
            for key in (
                "litellm.api_key_hash",
                "litellm.api_key_alias",
                "litellm.team_id",
                "litellm.user_id",
            )
            if fields.get(key)
        ),
        endpoint_id,
    )
    fields.update({
        "protocol": "litellm",
        "endpoint.id": endpoint_id,
        "auth.principal": principal,
        "model": str(payload.model or payload.request_data.get("model") or ""),
        "litellm.operation": payload.input_type,
        "http.method": headers.get("x-original-method", "POST").upper(),
        "http.path": headers.get("x-original-uri", ""),
        "http.host": headers.get("x-forwarded-host", headers.get("host", "")),
        "a2a.version": headers.get("a2a-version", ""),
        "a2a.extensions": headers.get("a2a-extensions", ""),
    })
    return ProtectionRequest(
        phase="input" if payload.input_type == "request" else "output",
        texts=tuple(payload.texts or ()),
        context=RequestContext(
            protocol="litellm",
            endpoint_id=endpoint_id,
            endpoint_request=_endpoint_source(request) if request is not None else None,
            business_request=_source_pairs(payload.request_headers),
            headers=tuple(sorted(headers.items())),
            fields=tuple(sorted(fields.items())),
        ),
        call_id=(
            _scoped_call_id(endpoint_id, payload.litellm_call_id)
            if payload.litellm_call_id
            else None
        ),
        messages=tuple(payload.structured_messages or ()),
    )


def _litellm_response(decision: ProtectionDecision) -> LiteLLMGuardrailResponse:
    if decision.decision == "block":
        return LiteLLMGuardrailResponse(
            action="BLOCKED",
            blocked_reason=decision.reason,
        )
    if decision.decision == "transform":
        return LiteLLMGuardrailResponse(
            action="GUARDRAIL_INTERVENED",
            texts=list(decision.texts),
        )
    return LiteLLMGuardrailResponse(action="NONE")


def _request_failure_reason(error: Exception) -> str:
    """Map request exceptions to a bounded, aggregation-safe reason class."""
    if isinstance(error, TimeoutError):
        return "timeout"
    if isinstance(error, ConnectionError):
        return "transport_error"
    if isinstance(error, LookupError):
        return "dependency_missing"
    if isinstance(error, ValueError):
        return "configuration_error"
    return "runtime_exception"


def _iso_now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _scoped_call_id(endpoint_id: str, call_id: str | None) -> str | None:
    if call_id is None: return None
    prefix = endpoint_id + ":"
    return call_id if call_id.startswith(prefix) else prefix + call_id


def _source_pairs(source: dict[str, str | list[str]] | None) -> tuple[tuple[str, str], ...] | None:
    if source is None: return None
    pairs = []
    if len(source) > 128: raise RoutingError("routing_input_error")
    for key, raw in source.items():
        name = key.lower()
        if name in SENSITIVE_HEADERS: continue
        values = raw if isinstance(raw, list) else [raw]
        if len(values) > 64: raise RoutingError("routing_input_error")
        for value in values:
            if not isinstance(value, str) or len(value) > 2048: raise RoutingError("routing_input_error")
            pairs.append((name, value.strip(" \t")))
    return tuple(pairs)


def _endpoint_source(request: Request) -> tuple[tuple[str, str], ...]:
    headers: dict[str, list[str]] = {}
    for key, value in request.headers.raw:
        name = key.decode("latin-1").lower()
        headers.setdefault(name, []).append(value.decode("latin-1"))
    return (*(_source_pairs(headers) or ()), (":method", request.method),
            (":path", request.url.path), (":host", request.url.hostname or ""))
