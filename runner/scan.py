"""F5 Scan wire adapter; execution remains owned by the Endpoint's Router."""
from __future__ import annotations

from datetime import UTC, datetime
import json
import time
from typing import Literal
from uuid import UUID, uuid4

from fastapi import Depends, Request
from fastapi.responses import JSONResponse
from fastapi.security import HTTPBearer
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from .guard_context import GuardrailContext, _request_content
from .routing import RoutingError
from .project_admission import AdmissionRejected, AdmissionUnavailable
from .toolkit.runtime.outcome import GuardrailExecutionError
from .toolkit.runtime.contracts import GuardContentBlock, ProtectionDecision, ProtectionRequest, RequestContext

SCAN_PATH = "/runtime/v1/endpoints/{endpoint_id}/backend/v1/scans"
SCAN_ADAPTER = "f5-scan"
CONTEXT_HEADER = "X-TaskLattice-Scan-Context"
CONTEXT_VERSION = "v1"
IGNORED_FIELDS = ("project", "externalMetadata", "requestPromptId", "configOverrides", "disabled", "forceEnabled")


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"Invalid JSON constant: {value}")


def _request_schema(schema):
    schema["properties"]["flagOnly"].pop("default", None)
    schema["properties"]["flagOnly"]["description"] = (
        "When omitted, use the Endpoint's configured default (initially true). "
        "An explicit boolean overrides that default."
    )
    for name in IGNORED_FIELDS:
        schema["properties"][name] = {
            "description": "Not applicable. Compatibility placeholder; any JSON value is accepted and ignored.",
            "x-tasklattice-effect": "ignored",
        }
    schema["additionalProperties"] = True


class ScanRequest(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True, json_schema_extra=_request_schema)
    input: str
    scanDirection: Literal["request", "response"] = "request"
    flagOnly: bool = True
    verbose: bool = False
    guardrail_context: GuardrailContext | None = Field(default=None, description=(
        "TaskLattice extension (not an F5 standard field): untrusted task, external-content "
        "and memory-boundary evidence. Accepted context is acknowledged by X-TaskLattice-Scan-Context: v1."
    ))

    @model_validator(mode="after")
    def context_direction(self):
        context = self.guardrail_context
        if context and context.memory and context.target_source is not None:
            expected = "tool_output" if context.memory.operation == "write" else "retrieved_content"
            if context.target_source != expected:
                raise ValueError("target_source conflicts with the memory operation.")
        if context and self.scanDirection == "response" and (
            context.memory or context.target_source in {"retrieved_content", "tool_output"}
        ):
            raise ValueError("External content and memory boundaries require scanDirection=request.")
        return self


def scan_request_schema():
    # This schema is embedded in a manually bounded HTTP handler. Inline nested
    # definitions so OpenAPI does not contain dangling #/$defs references.
    schema = ScanRequest.model_json_schema()
    definitions = schema.pop("$defs", {})
    def inline(value):
        if isinstance(value, list):
            return [inline(item) for item in value]
        if not isinstance(value, dict):
            return value
        if "$ref" in value:
            return inline({**definitions[value["$ref"].split("/")[-1]],
                           **{k: v for k, v in value.items() if k != "$ref"}})
        return {key: inline(item) for key, item in value.items()}
    return inline(schema)


class ScannerResult(BaseModel):
    outcome: Literal["passed", "failed"]
    data: dict[Literal["type"], Literal["custom"]]
    startedDate: datetime
    completedDate: datetime
    scanDirection: Literal["request", "response"]
    scannerId: UUID | None = None
    scannerVersionMeta: None = None
    message: None = None
    customConfig: Literal[False] = False


class ScanResult(BaseModel):
    outcome: Literal["cleared", "flagged", "redacted", "blocked"]
    response: str | None
    scannerResults: list[ScannerResult]


class ScanResponse(BaseModel):
    id: UUID
    result: ScanResult
    redactedInput: str
    scanners: None = None


class ScanFailure(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def scan_response(payload: ScanRequest, decision: ProtectionDecision, scan_id: str,
                  started: datetime, completed: datetime) -> ScanResponse:
    enforced = decision.protection_mode == "enforce"
    matched = decision.flagged
    outcome = "cleared"
    if matched:
        outcome = "flagged" if payload.flagOnly else {"block": "blocked", "transform": "redacted"}.get(decision.decision, "flagged")
    text = decision.texts[0] if decision.texts else payload.input
    scanner_id = None
    if decision.guardrail_id:
        try:
            scanner_id = UUID(decision.guardrail_id)
        except ValueError:
            pass
    details = [ScannerResult(
        outcome="failed" if matched else "passed", data={"type": "custom"},
        startedDate=started, completedDate=completed,
        scanDirection=payload.scanDirection, scannerId=scanner_id,
    )] if payload.verbose and enforced else []
    return ScanResponse(id=UUID(scan_id), redactedInput=text, result=ScanResult(
        outcome=outcome,
        response=text if payload.scanDirection == "response" and decision.decision != "block" else None,
        scannerResults=details,
    ))


def register_scan(api, *, max_body_bytes: int, timeout_seconds: float) -> None:
    from .api import SENSITIVE_HEADERS, _endpoint_source

    @api.router.post(SCAN_PATH, response_model=ScanResponse, tags=["Scans"],
        dependencies=[Depends(HTTPBearer(auto_error=False, scheme_name="ScanBearer"))],
        openapi_extra={"requestBody": {"required": True, "content": {"application/json": {"schema": scan_request_schema()}}},
                       "responses": {"422": {"description": "Invalid Scan request"}}})
    async def scan(endpoint_id: str, request: Request):
        """Map Scan traffic to the Endpoint's Guardrail and map its final result.

        The Guardrail owns short-circuiting and execution status. flagOnly and
        verbose affect response shape only; they never change policy execution.
        """
        scan_id = str(uuid4())
        decision = None
        response_headers = {"X-Request-ID": scan_id, "X-TaskLattice-Scan-Compatibility": "v1"}
        permit = None
        try:
            authorization = request.headers.getlist("authorization")
            parts = authorization[0].split() if len(authorization) == 1 else []
            token = parts[1] if len(parts) == 2 and parts[0].lower() == "bearer" else None
            access, endpoint_snapshot = api._authenticate_endpoint(endpoint_id, token)
            api._metrics.observe_authentication("scan", access.authenticated)
            if not access.allowed:
                response_headers["WWW-Authenticate"] = "Bearer"
                raise ScanFailure(401, "invalid_credential", "Endpoint credential is invalid.")
            if access.adapter != SCAN_ADAPTER:
                raise ScanFailure(403, "adapter_mismatch", "Endpoint does not support Scan.")
            try:
                permit = await api._acquire_project_permit(endpoint_id, token)
            except AdmissionRejected as error:
                response_headers["Retry-After"] = str(error.retry_after)
                raise ScanFailure(429, "project_admission_rejected", "Project admission capacity is unavailable. Retry shortly.") from error
            except AdmissionUnavailable as error:
                response_headers["Retry-After"] = "1"
                raise ScanFailure(503, "project_admission_unavailable", "Endpoint admission allocation is unavailable.") from error
            if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
                raise ScanFailure(415, "unsupported_media_type", "Use application/json.")
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > max_body_bytes:
                    raise ScanFailure(413, "request_too_large", "Scan request exceeds the body size limit.")
            # Preserve the bounded body for the existing encrypted HTTP capture path.
            request._body = bytes(body)
            try:
                raw = json.loads(body, parse_constant=_reject_json_constant)
            except (ValueError, UnicodeError, RecursionError):
                return JSONResponse(status_code=422, headers=response_headers,
                    content={"detail": [{"loc": ["body"], "msg": "Invalid JSON", "type": "json_invalid"}]})
            try:
                payload = ScanRequest.model_validate(raw)
            except ValidationError as error:
                return JSONResponse(status_code=422, headers=response_headers, content={"detail": [
                    {"loc": ["body", *item["loc"]], "msg": item["msg"], "type": item["type"]}
                    for item in error.errors(include_input=False, include_context=False, include_url=False)
                ]})
            if "flagOnly" not in payload.model_fields_set:
                payload = payload.model_copy(update={"flagOnly": endpoint_snapshot.scan_flag_only_default if endpoint_snapshot is not None
                    else api._store.endpoint_scan_flag_only_default(endpoint_id)})
            phase = "input" if payload.scanDirection == "request" else "output"
            source = "user_input" if phase == "input" else "model_output"
            if payload.guardrail_context is not None:
                response_headers[CONTEXT_HEADER] = CONTEXT_VERSION
            protection_request = ProtectionRequest(
                phase=phase, texts=(payload.input,), mode="enforce",
                content_blocks=_request_content(phase, (payload.input,), payload.guardrail_context, source) or (
                    GuardContentBlock(id=f"{phase}:0", text=payload.input, role=source, source=source, trust="untrusted"),),
                context=RequestContext(protocol="scan", endpoint_id=endpoint_id, call_id=scan_id,
                    endpoint_snapshot=endpoint_snapshot,
                    headers=tuple((k, v) for k, v in request.headers.items() if k.lower() not in SENSITIVE_HEADERS),
                    fields=(("protocol", "scan"), ("endpoint.id", endpoint_id),
                            *((("auth.principal", endpoint_id),) if access.authenticated else ()),
                            ("auth.mode", "credential" if access.authenticated else "anonymous"),
                            ("scan.direction", payload.scanDirection),
                            *((("scan.context_version", CONTEXT_VERSION),) if payload.guardrail_context is not None else ()),
                            ("http.method", request.method),
                            ("http.path", request.url.path), ("http.host", request.url.hostname or "")),
                    endpoint_request=_endpoint_source(request)),
            )
            decision = None
            result = None
            started = time.perf_counter()
            execution_started = datetime.now(UTC)
            with api._metrics.request("runtime", "scan", phase, endpoint_id=endpoint_id) as observation:
                def resolved(resolution):
                    nonlocal execution_started
                    execution_started = datetime.now(UTC)
                    observation.resolve(resolution)
                try:
                    decision = await api._runtime.evaluate_standalone(protection_request,
                        on_resolved=resolved, timeout_seconds=timeout_seconds)
                    result = scan_response(payload, decision, scan_id, execution_started, datetime.now(UTC))
                    observation.complete(decision)
                    api._metrics.observe_route("scan", phase, True)
                except BaseException as error:
                    if isinstance(error, GuardrailExecutionError):
                        decision = error.decision
                        observation.complete(decision)
                    observation.fail("runtime", "timeout" if isinstance(error, TimeoutError)
                        or isinstance(error, GuardrailExecutionError) and error.timed_out else "scan_execution_failed")
                    raise
                finally:
                    await api._emit_telemetry(request_id=scan_id, call_id=scan_id, endpoint_id=endpoint_id,
                        endpoint_context_id=getattr(endpoint_snapshot, "telemetry_context_id", None),
                        phase=phase, protocol="scan", mode="enforce", started=started, decision=decision,
                        content_before=(payload.input,), http_request=request, observation=observation,
                        stream_metadata={"authentication": "credential" if access.authenticated else "anonymous", "scanDirection": payload.scanDirection, "flagOnly": payload.flagOnly,
                            "scanContextVersion": CONTEXT_VERSION if payload.guardrail_context is not None else None,
                            "verbose": payload.verbose, "scanExecutionStatus": "completed" if result is not None else "error",
                            "scanOutcome": result.result.outcome if result is not None else None})
                response = JSONResponse(result.model_dump(mode="json"), headers=response_headers)
                api._path_response_headers(response, decision)
                if request.headers.get("x-guard-evidence") == "evaluations-v1":
                    from .evaluation_evidence import RESPONSE_HEADER, evaluation_evidence
                    response.headers[RESPONSE_HEADER] = evaluation_evidence(decision)
                return response
        except Exception as error:
            if isinstance(error, ScanFailure):
                status, code, message = error.status, error.code, error.message
            elif isinstance(error, GuardrailExecutionError):
                status = 504 if error.timed_out else 503
                code, message = error.code, str(error)
            elif isinstance(error, TimeoutError):
                status, code, message = 504, "scan_timeout", "The scan timed out."
            elif isinstance(error, (RoutingError, LookupError)):
                status, code, message = 503, "scan_unavailable", "The scan route or runtime is unavailable."
            else:
                status, code, message = 500, "scan_internal_error", "The scan could not be processed."
            if decision is not None:
                if request.headers.get("x-guard-evidence") == "evaluations-v1":
                    from .evaluation_evidence import RESPONSE_HEADER, evaluation_evidence
                    response_headers[RESPONSE_HEADER] = evaluation_evidence(decision)
            return JSONResponse(status_code=status, headers=response_headers,
                content={"detail": {"code": code, "message": message, "requestId": scan_id}})
        finally:
            await api._release_project_permit(permit)
