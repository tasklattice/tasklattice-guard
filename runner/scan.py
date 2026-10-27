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
from pydantic import BaseModel, ConfigDict, ValidationError

from .routing import RoutingError
from .toolkit.runtime.contracts import GuardContentBlock, ProtectionDecision, ProtectionRequest, RequestContext

SCAN_PATH = "/runtime/v1/endpoints/{endpoint_id}/backend/v1/scans"
SCAN_ADAPTER = "f5-scan"
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


def validate_scan_decision(decision: ProtectionDecision) -> None:
    """Never turn an unevaluated or failed check into a successful safe result."""
    if decision.protection_mode in {"monitor", "bypass"}:
        return
    assessments = decision.assessments
    matched = any(a.status == "intervene" for a in assessments)
    short_circuit = decision.decision == "block" and matched
    failed = (
        (decision.usage is not None and decision.usage.fail_closed)
        or any(a.status in {"error", "needs_context"} for a in assessments)
        or any(a.status == "uncovered" for a in assessments) and not short_circuit
    )
    coverage = decision.coverage
    if failed or coverage is None or coverage.required_modules_total < 1 or (
        not short_circuit and (coverage.status != "complete" or
            coverage.required_modules_completed != coverage.required_modules_total)
    ):
        raise ScanFailure(503, "scan_execution_failed", "The required scan could not be completed.")
    if decision.decision == "transform" and not decision.texts:
        raise ScanFailure(500, "invalid_scan_result", "The scan did not return its transformed text.")


def scan_response(payload: ScanRequest, decision: ProtectionDecision, scan_id: str,
                  started: datetime, completed: datetime) -> ScanResponse:
    validate_scan_decision(decision)
    # Assessments reflect terminal evaluations; raw findings may include superseded retries.
    enforced = decision.protection_mode == "enforce"
    matched = enforced and (decision.decision in {"block", "transform"} or any(a.status == "intervene" for a in decision.assessments))
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
        openapi_extra={"requestBody": {"required": True, "content": {"application/json": {"schema": ScanRequest.model_json_schema()}}},
                       "responses": {"422": {"description": "Invalid Scan request"}}})
    async def scan(endpoint_id: str, request: Request):
        """Scan with full evidence, including observations whose action is Allow.

        Full-buffered plans without custom flows continue reachable checks after
        Block. This can increase model calls and latency; a later error or timeout
        fails the scan. Neither flagOnly nor verbose changes this execution scope.
        Custom flows and streaming plans retain their own short-circuit behavior.
        """
        scan_id = str(uuid4())
        response_headers = {"X-Request-ID": scan_id, "X-TaskLattice-Scan-Compatibility": "v1"}
        try:
            authorization = request.headers.getlist("authorization")
            parts = authorization[0].split() if len(authorization) == 1 else []
            token = parts[1] if len(parts) == 2 and parts[0].lower() == "bearer" else None
            authenticated = api._store.authenticate_endpoint(endpoint_id, token)
            api._metrics.observe_authentication("scan", authenticated)
            if not authenticated:
                response_headers["WWW-Authenticate"] = "Bearer"
                raise ScanFailure(401, "invalid_credential", "Endpoint credential is invalid.")
            if api._store.endpoint_adapter(endpoint_id) != SCAN_ADAPTER:
                raise ScanFailure(403, "adapter_mismatch", "Endpoint does not support Scan.")
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
                payload = payload.model_copy(update={"flagOnly": api._store.endpoint_scan_flag_only_default(endpoint_id)})
            phase = "input" if payload.scanDirection == "request" else "output"
            source = "user_input" if phase == "input" else "model_output"
            # Scan deliberately collects full evidence, even with verbose=False
            # or flagOnly=True. On supported plans this also disables Block early
            # exit, so later checks can add model cost, latency or execution errors.
            protection_request = ProtectionRequest(
                phase=phase, texts=(payload.input,), mode="enforce", evidence_scope="full",
                content_blocks=(GuardContentBlock(id=f"{phase}:0", text=payload.input, role=source, source=source, trust="untrusted"),),
                context=RequestContext(protocol="scan", endpoint_id=endpoint_id, call_id=scan_id,
                    headers=tuple((k, v) for k, v in request.headers.items() if k.lower() not in SENSITIVE_HEADERS),
                    fields=(("protocol", "scan"), ("endpoint.id", endpoint_id), ("auth.principal", endpoint_id),
                            ("scan.direction", payload.scanDirection), ("http.method", request.method),
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
                def checked(value):
                    nonlocal decision
                    decision = value
                    validate_scan_decision(value)
                try:
                    decision = await api._runtime.evaluate_standalone(protection_request,
                        on_resolved=resolved, validate_decision=checked, timeout_seconds=timeout_seconds)
                    result = scan_response(payload, decision, scan_id, execution_started, datetime.now(UTC))
                    observation.complete(decision)
                    api._metrics.observe_route("scan", phase, True)
                except BaseException:
                    observation.fail("runtime", "scan_execution_failed")
                    raise
                finally:
                    await api._emit_telemetry(request_id=scan_id, call_id=scan_id, endpoint_id=endpoint_id,
                        phase=phase, protocol="scan", mode="enforce", started=started, decision=decision,
                        content_before=(payload.input,), http_request=request, observation=observation,
                        stream_metadata={"scanDirection": payload.scanDirection, "flagOnly": payload.flagOnly,
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
            elif isinstance(error, TimeoutError):
                status, code, message = 504, "scan_timeout", "The scan timed out."
            elif isinstance(error, (RoutingError, LookupError)):
                status, code, message = 503, "scan_unavailable", "The scan route or runtime is unavailable."
            else:
                status, code, message = 500, "scan_internal_error", "The scan could not be processed."
            return JSONResponse(status_code=status, headers=response_headers,
                content={"detail": {"code": code, "message": message, "requestId": scan_id}})
