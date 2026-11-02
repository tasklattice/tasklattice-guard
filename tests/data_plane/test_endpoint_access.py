"""Credential requirement changes through real Runner configuration and transports."""
import aiohttp
import httpx
import pytest
from fastapi import FastAPI
from prometheus_client import generate_latest

from runner.api import RunnerAPI, LiteLLMGuardrailRequest, _litellm_protection_request
from runner.metrics import RunnerMetrics
from runner.toolkit.runtime.service import GuardrailRuntimeService
from tests.data_plane.test_artifact_execution import _runtime, _desired_state, RUNTIME_CREDENTIAL
from tests.stream_client import runner, connection, exchange, released
from tests.test_runner_api import Telemetry


@pytest.mark.parametrize("adapter", ["litellm-generic-guardrail", "f5-scan"])
@pytest.mark.parametrize("credential", [None, "incorrect", RUNTIME_CREDENTIAL])
async def test_anonymous_requests_still_enforce_policy_and_reenable_preserves_credentials(tmp_path, adapter, credential):
    store, _, engine = _runtime(tmp_path)
    state = _desired_state()
    state.generation += 1
    endpoint = state.endpoints[0]
    endpoint.adapter = adapter
    endpoint.credential_required = False
    store.apply(state)
    service = GuardrailRuntimeService(engine, store)
    telemetry, metrics = Telemetry(), RunnerMetrics(4)
    app = FastAPI()
    app.include_router(RunnerAPI(service, store, metrics, telemetry, "test", "internal").router)
    is_scan = adapter == "f5-scan"
    url = "/runtime/v1/endpoints/fixture-endpoint/" + ("backend/v1/scans" if is_scan else "beta/litellm_basic_guardrail_api")
    secret = "api_key=abcdefghijklmnopqrstuvwx"
    payload = {"input": secret, "flagOnly": False} if is_scan else {"input_type": "request", "texts": [secret]}
    def headers(value):
        return ({"Authorization": f"Bearer {value}"} if is_scan else {"x-api-key": value}) if value is not None else {}
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://runner") as client:
            response = await client.post(url, headers=headers(credential), json=payload)
            assert response.status_code == 200, response.text
            assert (response.json()["result"]["outcome"] if is_scan else response.json()["action"]) == ("blocked" if is_scan else "BLOCKED")
            assert telemetry.events[-1]["metadata"]["authentication"] == "anonymous"
            metric_text = generate_latest(metrics.registry).decode()
            assert 'result="anonymous"} 1.0' in metric_text
            assert 'result="accepted"' not in metric_text
            if not is_scan:
                assert (await client.post("/runtime/v1/endpoints/fixture-endpoint/verify")).status_code == 200
            endpoint.credential_required = True
            state.generation += 1
            store.apply(state)
            for missing_or_bad in [None, "incorrect"]:
                assert (await client.post(url, headers=headers(missing_or_bad), json=payload)).status_code == 401
            # Same secret, no rotation, after applying the changed mode.
            assert (await client.post(url, headers=headers(RUNTIME_CREDENTIAL), json=payload)).status_code == 200
            assert telemetry.events[-1]["metadata"]["authentication"] == "credential"
            assert (await client.post(url.replace("fixture-endpoint", "missing"), json=payload)).status_code == 401
            # Endpoint disable/removal must still deny access even after anonymous use.
            state.ClearField("endpoints")
            state.disabled_endpoint_ids.append("fixture-endpoint")
            state.generation += 1
            store.apply(state)
            assert (await client.post(url, headers=headers(RUNTIME_CREDENTIAL), json=payload)).status_code == 401
    finally:
        await engine.shutdown()


def test_anonymous_identity_is_not_derived_from_caller_fields_and_call_contexts_are_separate():
    payload = LiteLLMGuardrailRequest(input_type="request", texts=["hello"], litellm_call_id="call-1",
        request_data={"user_api_key_hash": "claimed-identity"})
    authenticated = _litellm_protection_request(payload, "endpoint-1")
    anonymous = _litellm_protection_request(payload, "endpoint-1", authenticated=False)
    assert "auth.principal" not in dict(anonymous.context.fields)
    assert dict(anonymous.context.fields)["auth.mode"] == "anonymous"
    assert anonymous.context.endpoint_id == "endpoint-1"
    assert authenticated.call_id != anonymous.call_id
    # A caller-supplied pre-scoped ID cannot cross the anonymous namespace.
    spoofed = _litellm_protection_request(payload.model_copy(update={"litellm_call_id": anonymous.call_id}), "endpoint-1")
    assert spoofed.call_id != anonymous.call_id


@pytest.mark.parametrize("credential", [None, "incorrect"])
async def test_websocket_mode_changes_affect_new_connections_and_keep_existing_streams(tmp_path, credential):
    async with runner(tmp_path) as (url, _, _, telemetry, store):
        with pytest.raises(aiohttp.WSServerHandshakeError):
            async with connection(url, credential=credential):
                pytest.fail("Credential required by default")
        state = _desired_state()
        state.generation += 1
        state.endpoints[0].credential_required = False
        store.apply(state)
        async with connection(url, credential=credential) as (socket, ready):
            assert ready["type"] == "ready"
            state.generation += 1
            state.endpoints[0].credential_required = True
            store.apply(state)
            events = await exchange(socket, ["safe output"])
            assert events[-1]["type"] == "completed"
            assert released(events) == "safe output"
        assert telemetry.events[-1]["metadata"]["authentication"] == "anonymous"
        with pytest.raises(aiohttp.WSServerHandshakeError):
            async with connection(url, credential=credential):
                pytest.fail("New connection must use credentials")
        async with connection(url) as (socket, ready):
            assert ready["type"] == "ready"
            events = await exchange(socket, ["api_key=abcdefghijklmnopqrstuvwx"])
            assert events[-1]["type"] == "blocked"
            assert released(events) == ""
        assert telemetry.events[-1]["metadata"]["authentication"] == "credential"
