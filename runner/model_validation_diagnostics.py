"""Capture model calls inside an explicit Catalog Rail validation case."""
from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone
from contextlib import asynccontextmanager, contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx
from .model_http_evidence import httpx_request, httpx_response, active_model_http_call


logger = logging.getLogger("uvicorn.error.tasklattice.model_validation")
_CURRENT: ContextVar["ValidationDiagnostics | None"] = ContextVar("model_validation_diagnostics", default=None)
_BODY_LIMIT = 32_768
_LOG_BODY_LIMIT = 512
_EXCHANGE_LIMIT = 16
_REDACTED = "[REDACTED]"
_SENSITIVE_KEYS = frozenset({"authorization", "proxyauthorization", "cookie", "setcookie", "apikey", "xapikey", "password", "secret", "clientsecret", "token", "accesstoken", "refreshtoken", "credential", "signature"})
_REQUEST_EXTENSION = "tasklattice.validation_exchange"


def _sensitive(key: str) -> bool:
    return key.casefold().replace("-", "").replace("_", "") in _SENSITIVE_KEYS


def _clean(value: Any, secrets: tuple[str, ...], depth: int | None = None) -> Any:
    if depth == 0:
        return {"capture_error": "Maximum JSON nesting depth exceeded."}
    if depth is not None:
        depth -= 1
    if isinstance(value, str):
        for secret in secrets:
            value = value.replace(secret, _REDACTED)
        return value
    if isinstance(value, dict):
        return {_clean(str(key), secrets): _REDACTED if _sensitive(str(key)) else _clean(item, secrets, depth)
                for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean(item, secrets, depth) for item in value]
    return value


def _local_model_part(name: str, value: Any, secrets: tuple[str, ...]) -> dict[str, Any]:
    try:
        encoded = json.dumps(_clean(value, secrets, depth=32), ensure_ascii=False,
                             default=lambda item: {"unavailable_type": type(item).__name__})
        # Diagnostic data must remain serializable even when the SDK returns
        # non-finite numbers, unsupported objects, or malformed Unicode.
        encoded = encoded.encode("utf-8", errors="replace").decode("utf-8")
        if len(encoded) > _BODY_LIMIT:
            return {name: {"json_preview": encoded[:_BODY_LIMIT]}, f"{name}_truncated": True}
        return {name: json.loads(encoded, parse_constant=str)}
    except Exception:
        return {name: {"capture_error": "Value could not be represented as JSON."}}


@dataclass
class LocalModelCapture:
    calls: list[dict[str, Any]]
    secrets: tuple[str, ...]

    def invoke(self, arguments: dict[str, Any], predict: Callable[[], dict]) -> dict:
        call = {
            **_local_model_part("input", arguments, self.secrets),
            "result": {"output": None, "error": {
                "type": "NoModelOutput", "message": "No model output was captured before the sample ended.",
            }},
        }
        self.calls.append(call)
        try:
            output = predict()
        except Exception as error:
            call["result"] = {"output": None, "error": {
                "type": type(error).__name__, "message": "Built-in Laya CPU forward failed.",
            }}
            raise
        call["result"] = _local_model_part("output", output, self.secrets)
        return output


def local_model_capture() -> LocalModelCapture | None:
    diagnostics = _CURRENT.get()
    if diagnostics is None:
        return None
    # The executor can outlive a timed-out sample. Retain its original list,
    # never the session whose per-sample state gets reset for the next sample.
    return LocalModelCapture(diagnostics.local_model_calls, diagnostics.secrets)


@dataclass
class ValidationDiagnostics:
    identity: dict[str, str]
    secrets: tuple[str, ...]
    body_limit: int | None = _BODY_LIMIT
    exchanges: list[dict[str, Any]] = field(default_factory=list)
    dropped_exchanges: int = 0
    started: dict[int, float] = field(default_factory=dict, repr=False)
    local_model_calls: list[dict[str, Any]] = field(default_factory=list, repr=False)

    def clean(self, value: Any) -> Any:
        return _clean(value, self.secrets)

    def local_evidence(self) -> dict[str, Any]:
        calls = [{**{key: value for key, value in call.items() if key != "result"}, **call["result"]}
                 for call in self.local_model_calls.copy()]
        return {"local_model_calls": calls} if calls else {}

    def body(self, value: bytes | str | Any) -> dict[str, Any]:
        if isinstance(value, bytes):
            value = value.decode("utf-8", errors="replace")
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except (ValueError, TypeError):
                pass
        value = self.clean(value)
        text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
        return {"body": text[:self.body_limit], "body_truncated": self.body_limit is not None and len(text) > self.body_limit}

    def headers(self, values: Any) -> dict[str, str] | list[list[str]]:
        # Learn response credentials too, so an echoed cookie/token in a body
        # cannot leak through a successful validation export.
        pairs = list(values.multi_items() if hasattr(values, "multi_items") else values.items())
        sensitive_values = [str(value) for key, value in pairs if _sensitive(str(key)) and value]
        self.secrets = tuple(sorted(set(self.secrets).union(sensitive_values), key=len, reverse=True))
        cleaned = [[str(key), _REDACTED if _sensitive(str(key)) else self.clean(str(value))] for key, value in pairs]
        # Retain repeated field names without changing the common single-value shape.
        return cleaned if len({key.casefold() for key, _ in cleaned}) < len(cleaned) else dict(cleaned)

    def url(self, value: str) -> str:
        parsed = urlsplit(value)
        query = [(key, _REDACTED if _sensitive(key) else self.clean(item)) for key, item in parse_qsl(parsed.query, keep_blank_values=True)]
        # Keep the destination and path, excluding URL userinfo credentials.
        return self.clean(urlunsplit((parsed.scheme, parsed.netloc.rsplit("@", 1)[-1], parsed.path, urlencode(query), "")))

    def request(self, *, method: str, url: str, headers: Any, body: Any) -> dict[str, Any] | None:
        # Keep the most recent attempts: a retried model usually fails on its last
        # attempt, so dropping the tail would discard the evidence an operator needs.
        while len(self.exchanges) >= _EXCHANGE_LIMIT:
            oldest = self.exchanges.pop(0)
            self.started.pop(id(oldest), None)
            self.dropped_exchanges += 1
        exchange = {"started_at": datetime.now(timezone.utc).isoformat(),
                    "request": {"method": method, "url": self.url(url), "headers": self.headers(headers), **self.body(body)}, "response": None}
        self.exchanges.append(exchange)
        self.started[id(exchange)] = time.perf_counter()
        return exchange

    def response(self, exchange: dict[str, Any] | None, *, status: int, headers: Any, body: Any) -> None:
        if exchange is not None:
            exchange["response"] = {"status": status, "headers": self.headers(headers), **self.body(body)}
            started = self.started.pop(id(exchange), None)
            # The response may be recorded twice (headers first, body second).
            if started is not None:
                exchange["duration_ms"] = round((time.perf_counter() - started) * 1000)

    def failure(self, *, expected: str, actual: str, reason: str, failure_class: str | None = None) -> None:
        detail = self.clean({**self.identity, "expected_decision": expected, "actual_decision": actual,
                             "failure_class": failure_class, "reason": reason})
        logger.warning("%s", json.dumps({"event": "rail_validation_case_failed", **detail, "exchange_count": len(self.exchanges), "dropped_exchanges": self.dropped_exchanges}, ensure_ascii=False))
        for index, exchange in enumerate(self.exchanges):
            # Exports retain full bodies; keep log events bounded.
            preview = {**exchange}
            for part in ("request", "response"):
                if exchange.get(part):
                    value = exchange[part]
                    preview[part] = {**value, "body": value["body"][:_LOG_BODY_LIMIT],
                                     "body_truncated": value["body_truncated"] or len(value["body"]) > _LOG_BODY_LIMIT}
            logger.warning("%s", json.dumps(self.clean({"event": "rail_validation_model_exchange", **detail, "exchange_index": index + 1, **preview}), ensure_ascii=False))


@contextmanager
def capture_validation_case(*, enabled: bool, secrets: tuple[str, ...], session: ValidationDiagnostics | None = None, **identity: str) -> Iterator[ValidationDiagnostics | None]:
    diagnostics = (session or ValidationDiagnostics({}, ())) if enabled else None
    if diagnostics is not None:
        # NeMo's native admission workers inherit the first submitter's context.
        # Reuse one capture object for this candidate's sequential cases so those
        # workers observe the current case. Separate validations never share it.
        diagnostics.identity = identity
        diagnostics.secrets = tuple(sorted((item for item in secrets if item), key=len, reverse=True))
        diagnostics.exchanges = []
        diagnostics.dropped_exchanges = 0
        diagnostics.started = {}
        diagnostics.local_model_calls = []
    token = _CURRENT.set(diagnostics)
    try:
        yield diagnostics
    except BaseException as error:
        record_validation_error(error)
        if diagnostics is not None:
            diagnostics.failure(expected=identity.get("expected_decision", "unknown"), actual="error", reason=f"Validation execution raised {type(error).__name__}: {error}")
        raise
    finally:
        _CURRENT.reset(token)


def record_validation_error(error: BaseException) -> None:
    diagnostics = _CURRENT.get()
    if diagnostics is not None and diagnostics.exchanges:
        exchange = diagnostics.exchanges[-1]
        exchange["error"] = diagnostics.clean({"type": type(error).__name__, "message": str(error)})
        started = diagnostics.started.pop(id(exchange), None)
        if started is not None:
            exchange["duration_ms"] = round((time.perf_counter() - started) * 1000)


async def _httpx_request(request: httpx.Request) -> None:
    diagnostics = _CURRENT.get()
    if diagnostics is not None:
        exchange = diagnostics.request(method=request.method, url=str(request.url), headers=request.headers, body=request.content)
        request.extensions[_REQUEST_EXTENSION] = (diagnostics, exchange)


async def _httpx_response(response: httpx.Response) -> None:
    recorded = response.request.extensions.get(_REQUEST_EXTENSION)
    if recorded is not None:
        diagnostics, exchange = recorded
        diagnostics.response(exchange, status=response.status_code, headers=response.headers, body="")
        try:
            diagnostics.response(exchange, status=response.status_code, headers=response.headers, body=await response.aread())
        except BaseException as error:
            record_validation_error(error)
            raise


def validation_http_hooks() -> dict[str, list[Any]]:
    return {"request": [httpx_request, _httpx_request], "response": [httpx_response, _httpx_response]} if _CURRENT.get() is not None or active_model_http_call() is not None else {}


class _ObservedAiohttpSession:
    """Capture every RetryClient attempt, not just its final response."""
    def __init__(self, delegate):
        self._delegate = delegate

    def __getattr__(self, name):
        return getattr(self._delegate, name)

    async def request(self, method, url, **kwargs):
        call = active_model_http_call()
        exchange = call.request(method, url, kwargs.get("headers", {}), kwargs.get("json", kwargs.get("data", b""))) if call else None
        diagnostics = _CURRENT.get()
        captured = diagnostics.request(method=method, url=str(url), headers=kwargs.get("headers", {}), body=kwargs.get("json", kwargs.get("data", b""))) if diagnostics is not None else None
        try:
            response = await self._delegate.request(method, url, **kwargs)
            if call is None and diagnostics is None:
                return response
            if diagnostics is not None:
                if captured is not None:
                    captured["request"]["headers"] = diagnostics.headers(response.request_info.headers)
                diagnostics.response(captured, status=response.status, headers=response.headers, body="")
            if call:
                exchange["request"]["headers"] = call.headers(response.request_info.headers)
                call.response(exchange, response.status, response.headers, b"")
                exchange["response"]["bodyComplete"] = False
            body = await response.read()
            if diagnostics is not None:
                diagnostics.response(captured, status=response.status, headers=response.headers, body=body)
            if call:
                call.response(exchange, response.status, response.headers, body)
            return response
        except BaseException as error:
            record_validation_error(error)
            raise


class _ObservedRetryClient:
    """Per-model proxy for NeMo 0.24's aiohttp native engine client."""

    def __init__(self, delegate: Any) -> None:
        self._delegate = delegate

    def __getattr__(self, name: str) -> Any:
        return getattr(self._delegate, name)

    @asynccontextmanager
    async def post(self, url: str, **kwargs: Any):
        try:
            async with self._delegate.post(url, **kwargs) as response:
                yield response
        except BaseException as error:
            record_validation_error(error)
            raise


def instrument_native_validation_http(model: Any) -> None:
    """Instrument this candidate instance, never global SDK clients or live traffic."""
    from nemoguardrails.guardrails.model_engine import ModelEngine
    from nemoguardrails.llm.models.openai_chat import OpenAIChatModel

    # LLMRails may wrap the model with our metrics adapter.
    while hasattr(model, "_delegate"):
        model = model._delegate
    if isinstance(model, ModelEngine):
        if model._client is not None and not isinstance(model._client, _ObservedRetryClient):
            if not isinstance(model._client._client, _ObservedAiohttpSession):
                model._client._client = _ObservedAiohttpSession(model._client._client)
            model._client = _ObservedRetryClient(model._client)
    elif isinstance(model, OpenAIChatModel):
        client = model._client._client
        for event, hook in (("request", httpx_request), ("response", httpx_response), ("request", _httpx_request), ("response", _httpx_response)):
            if hook not in client.event_hooks[event]:
                client.event_hooks[event].append(hook)
