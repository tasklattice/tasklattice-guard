"""Capture model HTTP exchanges inside an explicit Catalog Rail validation case."""
from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager, contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, Iterator
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx
from .model_http_evidence import httpx_request, httpx_response, active_model_http_call


logger = logging.getLogger("uvicorn.error.tasklattice.model_validation")
_CURRENT: ContextVar["ValidationDiagnostics | None"] = ContextVar("model_validation_diagnostics", default=None)
_BODY_LIMIT = 32_768
_EXCHANGE_LIMIT = 16
_REDACTED = "[REDACTED]"
_SENSITIVE_KEYS = frozenset({"authorization", "proxyauthorization", "cookie", "setcookie", "apikey", "xapikey", "password", "secret", "clientsecret", "token", "accesstoken", "refreshtoken", "credential", "signature"})
_HEADERS = frozenset({"content-type", "accept", "x-request-id", "request-id", "traceparent"})
_REQUEST_EXTENSION = "tasklattice.validation_exchange"


def _sensitive(key: str) -> bool:
    return key.casefold().replace("-", "").replace("_", "") in _SENSITIVE_KEYS


@dataclass
class ValidationDiagnostics:
    identity: dict[str, str]
    secrets: tuple[str, ...]
    exchanges: list[dict[str, Any]] = field(default_factory=list)
    dropped_exchanges: int = 0

    def clean(self, value: Any) -> Any:
        if isinstance(value, str):
            for secret in self.secrets:
                value = value.replace(secret, _REDACTED)
            return value
        if isinstance(value, dict):
            return {self.clean(str(key)): _REDACTED if _sensitive(str(key)) else self.clean(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [self.clean(item) for item in value]
        return value

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
        return {"body": text[:_BODY_LIMIT], "body_truncated": len(text) > _BODY_LIMIT}

    def headers(self, values: Any) -> dict[str, str]:
        return {str(key): _REDACTED if _sensitive(str(key)) else self.clean(str(value))
                for key, value in values.items() if str(key).lower() in _HEADERS or _sensitive(str(key))}

    def url(self, value: str) -> str:
        parsed = urlsplit(value)
        query = [(key, _REDACTED if _sensitive(key) else self.clean(item)) for key, item in parse_qsl(parsed.query, keep_blank_values=True)]
        # Keep the destination and path, excluding URL userinfo credentials.
        return self.clean(urlunsplit((parsed.scheme, parsed.netloc.rsplit("@", 1)[-1], parsed.path, urlencode(query), "")))

    def request(self, *, method: str, url: str, headers: Any, body: Any) -> dict[str, Any] | None:
        if len(self.exchanges) >= _EXCHANGE_LIMIT:
            self.dropped_exchanges += 1
            return None
        exchange = {"request": {"method": method, "url": self.url(url), "headers": self.headers(headers), **self.body(body)}, "response": None}
        self.exchanges.append(exchange)
        return exchange

    def response(self, exchange: dict[str, Any] | None, *, status: int, headers: Any, body: Any) -> None:
        if exchange is not None:
            exchange["response"] = {"status": status, "headers": self.headers(headers), **self.body(body)}

    def failure(self, *, expected: str, actual: str, reason: str) -> None:
        detail = self.clean({**self.identity, "expected_decision": expected, "actual_decision": actual, "reason": reason})
        logger.warning("%s", json.dumps({"event": "rail_validation_case_failed", **detail, "exchange_count": len(self.exchanges), "dropped_exchanges": self.dropped_exchanges}, ensure_ascii=False))
        for index, exchange in enumerate(self.exchanges):
            logger.warning("%s", json.dumps({"event": "rail_validation_model_exchange", **detail, "exchange_index": index + 1, **exchange}, ensure_ascii=False))


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
        diagnostics.exchanges[-1]["error"] = diagnostics.clean({"type": type(error).__name__, "message": str(error)})


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
        response = await self._delegate.request(method, url, **kwargs)
        if call:
            exchange["request"]["headers"] = call.headers(response.request_info.headers)
            call.response(exchange, response.status, response.headers, b"")
            exchange["response"]["bodyComplete"] = False
            call.response(exchange, response.status, response.headers, await response.read())
        return response


class _ObservedRetryClient:
    """Per-model proxy for NeMo 0.24's aiohttp native engine client."""

    def __init__(self, delegate: Any) -> None:
        self._delegate = delegate

    def __getattr__(self, name: str) -> Any:
        return getattr(self._delegate, name)

    @asynccontextmanager
    async def post(self, url: str, **kwargs: Any):
        diagnostics = _CURRENT.get()
        exchange = diagnostics.request(method="POST", url=str(url), headers=kwargs.get("headers", {}), body=kwargs.get("json")) if diagnostics is not None else None
        try:
            async with self._delegate.post(url, **kwargs) as response:
                if diagnostics is not None:
                    # aiohttp caches read(), so NeMo's status/JSON checks still see
                    # the original response, including non-JSON error bodies.
                    diagnostics.response(exchange, status=response.status, headers=response.headers, body="")
                    diagnostics.response(exchange, status=response.status, headers=response.headers, body=await response.read())
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
