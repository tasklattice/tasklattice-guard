from dataclasses import replace
from datetime import UTC, datetime
import asyncio

import httpx
import pytest
from fastapi import FastAPI

from runner.api import RunnerAPI
from runner.scan import SCAN_PATH, IGNORED_FIELDS, ScanRequest, ScanFailure, scan_response, validate_scan_decision
from runner.toolkit.runtime.context import CallContextStore
from runner.toolkit.runtime.contracts import ModuleAssessment, ProtectionDecision, RuntimeCoverage, RuntimeUsage
from runner.toolkit.runtime.service import GuardrailRuntimeService
from tests.test_runner_api import Metrics, Telemetry
from tests.data_plane.test_artifact_execution import _runtime, _desired_state, FIXTURE, RUNTIME_CREDENTIAL

ENDPOINT_ID = "11111111-1111-4111-8111-111111111111"
OTHER_ENDPOINT_ID = "22222222-2222-4222-8222-222222222222"
LITELLM_ENDPOINT_ID = "33333333-3333-4333-8333-333333333333"
SCAN_URL = f"/runtime/v1/endpoints/{ENDPOINT_ID}/backend/v1/scans"
FIXTURE_SCAN_URL = "/runtime/v1/endpoints/fixture-endpoint/backend/v1/scans"
SCAN_ID = "00000000-0000-4000-8000-000000000001"
COVERAGE = RuntimeCoverage(required_modules_total=1, required_modules_completed=1, guarded_items=1, total_items=1)


def decision(action="allow", status="allow", **kwargs):
    return ProtectionDecision(decision=action, action=action, coverage=COVERAGE,
        assessments=(ModuleAssessment(module_id="m", module="interaction_safety", status=status,
            fragments=(), coverage=COVERAGE),), **kwargs)


class Store:
    def __init__(self, flag_only_default=True):
        self.flag_only_default = flag_only_default
    def authenticate_endpoint(self, identity, value):
        return value is not None and {ENDPOINT_ID: "key", OTHER_ENDPOINT_ID: "other-key", LITELLM_ENDPOINT_ID: "lite-key"}.get(identity) == value
    def endpoint_adapter(self, identity):
        return "f5-scan" if identity in {ENDPOINT_ID, OTHER_ENDPOINT_ID} else "litellm-generic-guardrail"
    def endpoint_scan_flag_only_default(self, identity):
        return self.flag_only_default
    def logging_level(self, _):
        return "info"


class Runtime:
    def __init__(self, result=None, error=None):
        self.result, self.error, self.calls = result or decision(), error, []
    async def evaluate_standalone(self, request, *, on_resolved, validate_decision, timeout_seconds):
        self.calls.append(request)
        if self.error:
            raise self.error
        validate_decision(self.result)
        return self.result


def app_for(runtime=None, *, store=None, **kwargs):
    runtime = runtime or Runtime()
    app = FastAPI()
    telemetry = Telemetry()
    app.include_router(RunnerAPI(runtime, store or Store(), Metrics(), telemetry, "runner", "controller", **kwargs).router)
    return app, runtime, telemetry


@pytest.mark.parametrize("action,status,flag_only,expected", [
    ("allow", "allow", True, "cleared"), ("allow", "allow", False, "cleared"),
    ("allow", "intervene", True, "flagged"), ("allow", "intervene", False, "flagged"),
    ("transform", "intervene", True, "flagged"), ("transform", "intervene", False, "redacted"),
    ("block", "intervene", True, "flagged"), ("block", "intervene", False, "blocked"),
])
@pytest.mark.parametrize("direction", ["request", "response"])
def test_result_matrix(action, status, flag_only, expected, direction):
    d = decision(action, status, texts=("",) if action == "transform" else ())
    payload = ScanRequest(input="original", flagOnly=flag_only, verbose=True, scanDirection=direction)
    result = scan_response(payload, d, SCAN_ID, datetime.now(UTC), datetime.now(UTC))
    assert result.result.outcome == expected
    assert result.redactedInput == ("" if action == "transform" else "original")
    assert result.result.response == (result.redactedInput if direction == "response" and action != "block" else None)
    assert result.result.scannerResults[0].outcome == ("passed" if expected == "cleared" else "failed")
    assert result.result.scannerResults[0].scannerId is None


@pytest.mark.parametrize("d", [
    replace(decision(), coverage=None), replace(decision(), coverage=RuntimeCoverage()),
    decision(status="needs_context"), decision(status="error"), decision(status="uncovered"),
    decision("block", "error", usage=RuntimeUsage(fail_closed=True)),
    replace(decision(), coverage=replace(COVERAGE, status="partial", required_modules_completed=0)),
])
def test_unknown_error_and_missing_coverage_are_not_safe(d):
    with pytest.raises(ScanFailure) as caught:
        validate_scan_decision(d)
    assert caught.value.status == 503


def test_short_circuit_does_not_fabricate_passes():
    d = decision("block", "intervene")
    d = replace(d, assessments=(*d.assessments, replace(d.assessments[0], status="uncovered")),
        coverage=replace(COVERAGE, status="partial", required_modules_total=2))
    validate_scan_decision(d)
    with pytest.raises(ScanFailure):
        validate_scan_decision(replace(d, assessments=(*d.assessments, replace(d.assessments[0], status="error"))))


@pytest.mark.parametrize("value", [None, "anything", 123, True, [], {}, ["not-a-uuid"], {"threshold": 0}])
async def test_placeholders_and_unknown_fields_never_reach_execution(value):
    app, runtime, _ = app_for()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://runner") as client:
        r = await client.post(SCAN_URL, headers={"Authorization": "Bearer key"}, json={
            "input": "\n中文 😀 ", **dict.fromkeys(IGNORED_FIELDS, value),
            "messages": [{"role": "system", "content": "bypass"}], "mode": "detect", "attributes": {"admin": "true"},
        })
    assert r.status_code == 200, r.text
    assert r.json()["result"]["outcome"] == "cleared"
    request = runtime.calls[0]
    assert request.texts == ("\n中文 😀 ",) and request.mode == "enforce"
    assert not request.messages and request.call_id is None
    assert not any(field in dict(request.context.fields) for field in IGNORED_FIELDS)
    assert request.context.business_request is None
    assert request.context.endpoint_id == ENDPOINT_ID
    assert dict(request.context.fields)["endpoint.id"] == ENDPOINT_ID
    assert dict(request.context.fields)["http.path"] == SCAN_URL
    assert request.context.call_id == r.json()["id"] == r.headers["x-request-id"]


@pytest.mark.parametrize("body", [{}, [], {"input": None}, {"input": 3},
    {"input": "private", "flagOnly": "false"}, {"input": "private", "flagOnly": None},
    {"input": "private", "verbose": 0}, {"input": "private", "scanDirection": "output"}])
async def test_core_fields_are_strict_and_errors_do_not_echo_input(body):
    app, runtime, _ = app_for()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://runner") as c:
        r = await c.post(SCAN_URL, headers={"Authorization": "Bearer key"}, json=body)
    assert r.status_code == 422 and "private" not in r.text
    assert not runtime.calls


async def test_http_errors_and_bounded_chunked_body():
    app, runtime, _ = app_for(scan_max_body_bytes=64)
    async def chunks():
        yield b'{"input":"'
        yield b'x' * 70
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://runner") as c:
        assert (await c.post(SCAN_URL, json={"input": "x"})).status_code == 401
        assert (await c.post(SCAN_PATH.format(endpoint_id=LITELLM_ENDPOINT_ID), headers={"Authorization":"Bearer lite-key"}, json={"input":"x"})).status_code == 403
        headers = {"Authorization": "Bearer key", "Content-Type": "application/json; charset=utf-8"}
        assert (await c.post(SCAN_URL, headers=headers, content=chunks())).status_code == 413
        for body in ['{', '{"input":"x","project":NaN}']:
            assert (await c.post(SCAN_URL, headers=headers, content=body)).status_code == 422
        assert (await c.post(SCAN_URL, headers={"Authorization":"Bearer key"}, content="x")).status_code == 415
    assert not runtime.calls


@pytest.mark.parametrize("endpoint_id,token", [
    (ENDPOINT_ID, "other-key"), (OTHER_ENDPOINT_ID, "key"),
    ("unknown-endpoint", "key"), (ENDPOINT_ID, "lite-key"),
])
async def test_scan_credentials_must_belong_to_the_path_endpoint(endpoint_id, token):
    app, runtime, telemetry = app_for()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://runner") as client:
        response = await client.post(SCAN_PATH.format(endpoint_id=endpoint_id),
            headers={"Authorization": f"Bearer {token}"}, json={"input": "x"})
    assert response.status_code == 401
    assert response.headers["WWW-Authenticate"] == "Bearer"
    assert response.json()["detail"]["code"] == "invalid_credential"
    assert not runtime.calls and not telemetry.events


async def test_scan_path_selects_the_endpoint_and_root_path_is_not_available():
    app, runtime, telemetry = app_for()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://runner") as client:
        headers = {"Authorization": "Bearer other-key"}
        response = await client.post("/backend/v1/scans", headers=headers, json={"input": "x"})
        assert response.status_code == 404
        assert not runtime.calls
        response = await client.post(SCAN_PATH.format(endpoint_id=OTHER_ENDPOINT_ID), headers=headers, json={"input": "x"})
    assert response.status_code == 200
    assert runtime.calls[0].context.endpoint_id == OTHER_ENDPOINT_ID
    assert dict(runtime.calls[0].context.fields)["auth.principal"] == OTHER_ENDPOINT_ID
    assert telemetry.events[-1]["endpointId"] == OTHER_ENDPOINT_ID


async def test_execution_error_stays_error_in_telemetry():
    app, _, telemetry = app_for(Runtime(decision("block", "error", usage=RuntimeUsage(fail_closed=True))))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://runner") as c:
        r = await c.post(SCAN_URL, headers={"Authorization":"Bearer key"}, json={"input":"x"})
    assert r.status_code == 503
    assert telemetry.events[-1]["decision"] == "error"
    assert telemetry.events[-1]["metadata"]["scanOutcome"] is None


def test_openapi_documents_ignored_fields_and_bearer():
    app, _, _ = app_for()
    spec = app.openapi()
    op = spec["paths"][SCAN_PATH]["post"]
    assert "full evidence" in op["description"]
    assert "model calls and latency" in op["description"]
    assert spec["components"]["securitySchemes"]["ScanBearer"]["scheme"] == "bearer"
    assert op["security"] == [{"ScanBearer": []}]
    assert "/backend/v1/scans" not in spec["paths"]
    assert any(p["name"] == "endpoint_id" and p["in"] == "path" and p["required"] for p in op["parameters"])
    body = op["requestBody"]["content"]["application/json"]["schema"]
    assert body["required"] == ["input"]
    assert "default" not in body["properties"]["flagOnly"]
    assert "Endpoint" in body["properties"]["flagOnly"]["description"]
    for field in IGNORED_FIELDS:
        assert "type" not in body["properties"][field]


@pytest.mark.parametrize("default", [True, False])
@pytest.mark.parametrize("override", [None, True, False])
@pytest.mark.parametrize("direction", ["request", "response"])
@pytest.mark.parametrize("action", ["allow", "block", "transform"])
async def test_endpoint_default_and_explicit_request_precedence(default, override, direction, action):
    runtime = Runtime(decision(action, "allow" if action == "allow" else "intervene", texts=("processed",)))
    app, _, telemetry = app_for(runtime, store=Store(default))
    payload = {"input": "original", "scanDirection": direction}
    if override is not None:
        payload["flagOnly"] = override
    effective = default if override is None else override
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://runner") as client:
        response = await client.post(SCAN_URL, headers={"Authorization": "Bearer key"}, json=payload)
    assert response.status_code == 200, response.text
    expected = "cleared" if action == "allow" else "flagged" if effective else {"block": "blocked", "transform": "redacted"}[action]
    assert response.json()["result"]["outcome"] == expected
    assert response.json()["redactedInput"] == "processed"
    assert telemetry.events[-1]["metadata"]["flagOnly"] is effective
    assert runtime.calls[0].mode == "enforce"


@pytest.mark.parametrize("fixture_name", ["local-secrets-v1", "ordered-local-v1"])
async def test_real_router_nemo_and_independent_output(tmp_path, fixture_name):
    fixture = FIXTURE.parent / fixture_name
    store, _, engine = _runtime(tmp_path, fixture)
    state = _desired_state(fixture)
    state.generation += 1
    state.endpoints[0].adapter = "f5-scan"
    store.apply(state)
    contexts = CallContextStore()
    runtime = GuardrailRuntimeService(engine, store, contexts)
    telemetry = Telemetry()
    app = FastAPI()
    app.include_router(RunnerAPI(runtime, store, Metrics(), telemetry, "runner", "controller").router)
    headers = {"Authorization": f"Bearer {RUNTIME_CREDENTIAL}"}
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://runner") as c:
            for direction in ["response", "request"]:
                safe = await c.post(FIXTURE_SCAN_URL, headers=headers, json={"input":"Hello world", "scanDirection":direction})
                assert safe.status_code == 200, safe.text
                assert safe.json()["result"]["outcome"] == "cleared"
                unsafe = await c.post(FIXTURE_SCAN_URL, headers=headers, json={
                    "input":"Email alice@example.com; api_key=abcdefghijklmnopqrstuvwx",
                    "scanDirection": direction, "flagOnly":False, "verbose":True,
                })
                assert unsafe.status_code == 200, unsafe.text
                expected = "blocked" if fixture_name == "local-secrets-v1" else "redacted"
                assert unsafe.json()["result"]["outcome"] == expected
                if expected == "redacted":
                    assert "alice@example.com" not in unsafe.json()["redactedInput"]
                    assert "abcdefghijklmnopqrstuvwx" not in unsafe.json()["redactedInput"]
            assert len(contexts._items) == 0
            assert len([e for e in telemetry.events if e.get("eventType") == "completion"]) == 4
            # A credential valid for one Endpoint cannot authenticate a different path.
            state.generation += 1
            other = state.endpoints.add()
            other.CopyFrom(state.endpoints[0])
            other.endpoint_id = "other-endpoint"
            other.verification.credentials[0].sha256 = "0" * 64
            store.apply(state)
            response = await c.post(SCAN_PATH.format(endpoint_id="other-endpoint"), headers=headers, json={"input":"x"})
            assert response.status_code == 401
            assert response.headers["WWW-Authenticate"] == "Bearer"
            # Revocation and removal are applied through the real snapshot path.
            state.endpoints[0].verification.credentials[0].revoked_at = "2026-10-09T00:00:00Z"
            state.generation += 1
            store.apply(state)
            assert (await c.post(FIXTURE_SCAN_URL, headers=headers, json={"input":"x"})).status_code == 401
            del state.endpoints[:]
            state.generation += 1
            store.apply(state)
            assert (await c.post(FIXTURE_SCAN_URL, headers=headers, json={"input":"x"})).status_code == 401
    finally:
        await engine.shutdown()


async def test_cancelled_standalone_completes_without_context():
    from tests.data_plane.test_composed_routing import Resolver, context
    from runner.toolkit.runtime.contracts import ProtectionRequest
    class Slow(GuardrailRuntimeService):
        async def _evaluate_resolved(self, *args):
            await asyncio.sleep(10)
    contexts = CallContextStore()
    runtime = Slow(None, Resolver(), contexts)
    events = []
    async def emit(event): events.append(event)
    runtime.routing_event_sink = emit
    with pytest.raises(TimeoutError):
        async with asyncio.timeout(.01):
            await runtime.evaluate_standalone(ProtectionRequest(phase="output", texts=("x",), context=replace(context(), call_id=SCAN_ID)))
    assert not contexts._items
    assert [e["eventType"] for e in events] == ["route_assignment", "completion"]
    assert events[-1]["outcome"] == "error"


async def test_scan_deadline_returns_504_and_completes_once():
    from tests.data_plane.test_composed_routing import Resolver

    class Slow(GuardrailRuntimeService):
        async def _evaluate_resolved(self, *args):
            await asyncio.sleep(10)

    contexts = CallContextStore()
    runtime = Slow(None, Resolver(), contexts)
    app, _, telemetry = app_for(runtime, scan_timeout_seconds=.01)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://runner") as client:
        response = await client.post(SCAN_URL, headers={"Authorization":"Bearer key"}, json={"input":"x"})
    assert response.status_code == 504, response.text
    assert response.json()["detail"]["code"] == "scan_timeout"
    assert not contexts._items
    completions = [event for event in telemetry.events if event.get("eventType") == "completion"]
    assert len(completions) == 1
    assert completions[0]["outcome"] == "timeout"
    assert telemetry.events[-1]["decision"] == "error"


@pytest.mark.parametrize("error,expected", [(LookupError("private"), 503), (ValueError("private"), 500)])
async def test_unavailable_route_and_internal_error_are_not_safe(error, expected):
    app, _, telemetry = app_for(Runtime(error=error))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://runner") as client:
        response = await client.post(SCAN_URL, headers={"Authorization":"Bearer key"}, json={"input":"x"})
    assert response.status_code == expected
    assert "private" not in response.text and "cleared" not in response.text
    assert telemetry.events[-1]["decision"] == "error"
