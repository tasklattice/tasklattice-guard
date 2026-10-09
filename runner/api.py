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

from runner.toolkit.runtime.contracts import ProtectionDecision, ProtectionRequest, RequestContext
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
from .output_streaming import register_output_stream
from .telemetry import RuntimeTelemetryExporter


LITELLM_ADAPTER_ID = "litellm-generic-guardrail"
SENSITIVE_HEADERS = frozenset({"authorization", "cookie", "proxy-authorization", "x-api-key"})
RUNTIME_LOG_AAD = b"tasklattice-runtime-log-v1"
_TRACER = trace.get_tracer("tasklattice.guard-runner.api")
GUARDRAIL_VERSION_PATTERN = r"^\d{8}-\d{6}\.\d{3}Z$"


class InternalEvaluationRequest(BaseModel):
    """Controller-only Playground evaluation; never an Endpoint wire adapter."""
    model_config = ConfigDict(extra="forbid")
    phase: Literal["input", "output"] | None = None
    input_type: Literal["request", "response"] | None = None
    texts: list[str] = Field(min_length=1, max_length=64)
    call_id: str | None = Field(default=None, min_length=1, max_length=256)
    protocol: Literal["playground"] = "playground"
    messages: list[dict[str, Any]] = Field(default_factory=list, max_length=20)
    attributes: dict[str, str] = Field(default_factory=dict)
    mode: Literal["enforce"] = "enforce"

    @model_validator(mode="after")
    def validate_phase(self):
        expected = "input" if self.input_type == "request" else "output"
        if self.phase is not None and self.input_type is not None and self.phase != expected:
            raise ValueError("phase and input_type describe different protection phases.")
        return self

    @property
    def resolved_phase(self) -> Literal["input", "output"]:
        return self.phase or ("output" if self.input_type == "response" else "input")


class GuardrailEvaluateRequest(InternalEvaluationRequest):
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


class DraftPreviewEvaluateRequest(InternalEvaluationRequest):
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
        scan_max_body_bytes: int = 1_048_576,
        scan_timeout_seconds: float = 25,
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
        self._register()
        register_output_stream(self)
        from .path_testing import register_path_testing
        register_path_testing(self)
        from .scan import register_scan
        register_scan(self, max_body_bytes=scan_max_body_bytes, timeout_seconds=scan_timeout_seconds)

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
                    "scan": "/backend/v1/scans",
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
                            action="block",
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
                        http_request=request,
                        observation=observation,
                    )

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
                        http_request=request,
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
        http_request: Request | None = None,
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
        if protocol == "scan" and (stream_metadata or {}).get("scanExecutionStatus") == "error":
            event["decision"] = "error"
        if decision is not None:
            event["metadata"].update(_telemetry_metadata(decision))
            if runtime_log_captured and self._runtime_log_encryption_key:
                event["metadata"]["contentCiphertext"] = _encrypt_runtime_log_content(
                    self._runtime_log_encryption_key,
                    phase,
                    content_before,
                    decision.texts or content_before,
                    await _runtime_http_request(http_request) if http_request is not None else None,
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
            "riskSeverity": item.risk_severity,
            "policyVersion": item.policy_version,
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
        "executionStatus": "error" if any(item.verdict == "error" for item in decision.findings) or any(item.timed_out or item.verdict == "error" or item.status in {"error", "failed", "timeout"} for item in decision.trace) else "complete",
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
    http_request: dict[str, Any] | None = None,
) -> str:
    role = "user_input" if phase == "input" else "model_output"
    payload = {
        "contentBefore": _runtime_log_blocks(before, role),
        "contentAfter": _runtime_log_blocks(after, role),
        **({"httpRequest": http_request} if http_request is not None else {}),
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


async def _runtime_http_request(request: Request) -> dict[str, Any]:
    """Keep the received HTTP body byte-for-byte; never retain transport credentials."""
    headers = []
    redacted = set()
    for name, value in request.scope.get("headers", []):
        header = name.decode("latin-1")
        if header.lower() in SENSITIVE_HEADERS:
            redacted.add(header)
            text = "[REDACTED]"
        else:
            text = value.decode("latin-1")
        headers.append([header, text])
    path = request.scope.get("raw_path", request.url.path.encode()).decode("latin-1")
    query = request.scope.get("query_string", b"").decode("latin-1")
    return {
        "method": request.method,
        "target": path + (f"?{query}" if query else ""),
        "httpVersion": request.scope.get("http_version", "1.1"),
        "headers": headers,
        "bodyBase64": base64.b64encode(await request.body()).decode("ascii"),
        "redactedHeaders": sorted(redacted),
    }


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
