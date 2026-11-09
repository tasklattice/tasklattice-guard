"""Model exchanges, held per request for protected evidence storage.

Payloads never enter usage dataclasses, logs, spans or ordinary telemetry.
Runtime evidence is encrypted; validation evidence uses protected reports.
Runtime drops healthy attempts; validation explicitly retains them for evidence.
Cancelled calls always drop their transient HTTP buffers.
"""
from __future__ import annotations

import base64
import json
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

_SENSITIVE = frozenset({'authorization', 'proxyauthorization', 'cookie', 'setcookie', 'apikey', 'xapikey', 'password', 'secret', 'clientsecret', 'token', 'accesstoken', 'refreshtoken', 'credential', 'signature'})
_CURRENT: ContextVar[list[dict] | None] = ContextVar('model_http_evidence_request', default=None)
_INCLUDE_SUCCESS: ContextVar[bool] = ContextVar('model_http_evidence_include_success', default=False)
_ACTIVE: ContextVar['CallEvidence | None'] = ContextVar('model_http_evidence_call', default=None)
_EXTENSION = 'tasklattice.model_http_evidence'


def _sensitive(name):
    return name.lower().replace('-', '').replace('_', '') in _SENSITIVE


def _pairs(headers):
    return list(headers.multi_items() if hasattr(headers, 'multi_items') else headers.items())


@dataclass
class CallEvidence:
    call_id: str
    provider: str
    model: str
    exchanges: list[dict] = field(default_factory=list)
    secrets: set[str] = field(default_factory=set)
    request_sent: bool | None = None

    def headers(self, values):
        pairs = _pairs(values)
        for key, value in pairs:
            if _sensitive(key) and value:
                self.secrets.add(str(value))
                if key.lower() in {'authorization', 'proxy-authorization'} and ' ' in value:
                    self.secrets.add(value.split(' ', 1)[1])
        return [[str(k), '[REDACTED]' if _sensitive(k) else str(v)] for k, v in pairs]

    def clean(self, text):
        for secret in sorted(self.secrets, key=len, reverse=True):
            text = text.replace(secret, '[REDACTED]')
        return text

    def request(self, method, url, headers, body):
        safe_headers = self.headers(headers)
        parsed = urlsplit(str(url))
        if parsed.username: self.secrets.add(parsed.username)
        if parsed.password: self.secrets.add(parsed.password)
        query = []
        for key, value in parse_qsl(parsed.query, keep_blank_values=True):
            if _sensitive(key) and value:
                self.secrets.add(value)
            query.append((key, '[REDACTED]' if _sensitive(key) else value))
        safe_url = urlunsplit((parsed.scheme, parsed.netloc.rsplit('@', 1)[-1], parsed.path, urlencode(query), ''))
        if not isinstance(body, bytes):
            body = body.encode() if isinstance(body, str) else json.dumps(body).encode()
        exchange = {'request': {'method': method, 'url': safe_url, 'headers': safe_headers, '_body': body, 'sent': self.request_sent}, 'response': None}
        self.exchanges.append(exchange)
        return exchange

    def response(self, exchange, status, headers, body):
        exchange['response'] = {'status': status, 'headers': self.headers(headers), '_body': body, 'bodyComplete': True}

    def export(self, result, error_type):
        exchanges = []
        for raw in self.exchanges:
            healthy = result == 'success' and raw['response'] is not None and raw['response']['status'] < 400 and raw['response'].get('bodyComplete', True)
            if healthy and not _INCLUDE_SUCCESS.get():
                continue
            item = {'modelCallId': self.call_id, 'provider': self.provider, 'model': self.model,
                    'result': 'success' if healthy else 'recovered_failure' if result == 'success' else result, 'errorType': error_type, 'response': None}
            for side in ('request', 'response'):
                if raw[side] is None:
                    continue
                record = dict(raw[side])
                body = record.pop('_body')
                for secret in sorted(self.secrets, key=len, reverse=True):
                    body = body.replace(secret.encode(), b'[REDACTED]')
                record['bodyBase64'] = base64.b64encode(body).decode('ascii')
                record['bodyBytes'] = len(body)
                record['headers'] = [[self.clean(k), self.clean(v)] for k, v in record['headers']]
                if 'url' in record:
                    record['url'] = self.clean(record['url'])
                item[side] = record
            exchanges.append(item)
        return exchanges


@contextmanager
def capture_model_http_evidence(*, enabled=True, include_success=False):
    token = _CURRENT.set([] if enabled else None)
    scope = _INCLUDE_SUCCESS.set(include_success)
    try:
        yield
    finally:
        _CURRENT.reset(token)
        _INCLUDE_SUCCESS.reset(scope)


def begin_model_http_call(call_id, provider, model):
    return _ACTIVE.set(CallEvidence(call_id, provider, model) if _CURRENT.get() is not None else None)


def finish_model_http_call(token, result, error_type):
    call = _ACTIVE.get()
    try:
        target = _CURRENT.get()
        if call is not None and target is not None and result != 'cancelled':
            target.extend(call.export(result, error_type))
    finally:
        _ACTIVE.reset(token)


def failed_model_http_evidence(call_ids=None):
    return [item for item in (_CURRENT.get() or []) if call_ids is None or item['modelCallId'] in call_ids]


async def httpx_request(request):
    call = _ACTIVE.get()
    if call is not None:
        exchange = call.request(request.method, request.url, request.headers, request.content)
        request.extensions[_EXTENSION] = (call, exchange)


async def httpx_response(response):
    captured = response.request.extensions.get(_EXTENSION)
    if captured:
        call, exchange = captured
        call.response(exchange, response.status_code, response.headers, b'')
        exchange['response']['bodyComplete'] = False
        call.response(exchange, response.status_code, response.headers, await response.aread())


def mark_model_request_sent(sent):
    call = _ACTIVE.get()
    if call is not None:
        call.request_sent = sent
        if call.exchanges and call.exchanges[-1]['response'] is None:
            call.exchanges[-1]['request']['sent'] = sent


def active_model_http_call():
    return _ACTIVE.get()


def attach_validation_http_evidence(decision):
    """Use the existing permission-scoped validation report evidence channel."""
    from dataclasses import replace
    from runner.toolkit.runtime.contracts import RuntimeTraceStep
    records = failed_model_http_evidence()
    return replace(decision, trace=(*decision.trace, *(RuntimeTraceStep(
        id=f'{record["modelCallId"]}:http-evidence:{index}', kind='model_http_evidence',
        name='Model HTTP evidence', status='completed', detail='Full model exchange; authentication values redacted.',
        model_call_id=record['modelCallId'], provider_name=record['provider'], model_name=record['model'],
        evidence=json.dumps(record, ensure_ascii=False),
    ) for index, record in enumerate(records))))
