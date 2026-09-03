from __future__ import annotations

import base64
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from runner import generated as protocol
from runner.api import RunnerAPI
from runner.artifact_store import ArtifactStore
from runner.metrics import RunnerMetrics
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.actions import local_action_providers
from runner.toolkit.nemo.registry import NeMoRuntimeRegistry
from runner.toolkit.nemo.runtime import NeMoRuntime
from runner.toolkit.runtime.context import CallContextStore
from runner.toolkit.runtime.service import GuardrailRuntimeService


FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "artifacts" / "local-secrets-v1"
RUNTIME_CREDENTIAL = "fixture-runtime-secret"


class Telemetry:
    def __init__(self) -> None:
        self.events: list[dict[str, object]] = []

    async def emit(self, event: dict[str, object]) -> None:
        self.events.append(event)


@pytest.mark.asyncio
async def test_runner_executes_a_precompiled_artifact_through_real_litellm_callbacks(
    tmp_path: Path,
) -> None:
    store, registry, engine = _runtime(tmp_path)
    telemetry = Telemetry()
    app = FastAPI()
    app.include_router(RunnerAPI(
        GuardrailRuntimeService(engine, store, contexts=CallContextStore()),
        store,
        RunnerMetrics(4),
        telemetry,  # type: ignore[arg-type]
        "fixture-runner",
        "controller-token",
    ).router)
    headers = {"x-api-key": RUNTIME_CREDENTIAL}
    endpoint = (
        "/runtime/v1/integrations/fixture-integration/"
        "beta/litellm_basic_guardrail_api"
    )
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://runner",
        ) as client:
            unauthorized = await client.post(
                endpoint,
                headers={"x-api-key": "wrong"},
                json={
                    "input_type": "request",
                    "texts": ["hello"],
                    "request_data": {},
                },
            )
            verification = await client.post(
                "/runtime/v1/integrations/fixture-integration/verify",
                headers=headers,
                json={},
            )
            safe_input = await client.post(
                endpoint,
                headers=headers,
                json={
                    "input_type": "request",
                    "litellm_call_id": "safe-call",
                    "texts": ["Summarize the quarterly report."],
                    "request_data": {},
                },
            )
            safe_output = await client.post(
                endpoint,
                headers=headers,
                json={
                    "input_type": "response",
                    "litellm_call_id": "safe-call",
                    "texts": ["Quarterly revenue increased."],
                    "request_data": {},
                },
            )
            blocked_input = await client.post(
                endpoint,
                headers=headers,
                json={
                    "input_type": "request",
                    "litellm_call_id": "blocked-call",
                    "texts": ["api_key=abcdefghijklmnop"],
                    "request_data": {},
                },
            )

        assert unauthorized.status_code == 401
        assert verification.json() == {
            "ready": True,
            "adapter_id": "litellm-generic-guardrail",
            "protocol": "litellm",
        }
        assert safe_input.json()["action"] == "NONE"
        assert safe_output.json()["action"] == "NONE"
        assert blocked_input.json()["action"] == "BLOCKED"
        assert store.generation == 1
        assert registry.readiness()["ready"] is True
        assert [event["direction"] for event in telemetry.events] == [
            "incoming",
            "outgoing",
            "incoming",
        ]
    finally:
        await engine.shutdown()


@pytest.mark.parametrize("input_type", ["request", "response"])
async def test_precompiled_ordered_artifact_forwards_redacted_content_before_later_checks(tmp_path, input_type):
    fixture = FIXTURE.parent / "ordered-local-v1"
    store, _registry, engine = _runtime(tmp_path, fixture)
    app = FastAPI()
    app.include_router(RunnerAPI(
        GuardrailRuntimeService(engine, store, contexts=CallContextStore()),
        store, RunnerMetrics(4), Telemetry(), "fixture-runner", "controller-token",
    ).router)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
            response = await client.post(
                "/runtime/v1/integrations/fixture-integration/beta/litellm_basic_guardrail_api",
                headers={"x-api-key": RUNTIME_CREDENTIAL},
                json={"input_type": input_type, "texts": ["Email alice@example.com; api_key=abcdefghijklmnopqrstuvwx"], "request_data": {}},
            )
        assert response.status_code == 200
        payload = response.json()
        # The later Secrets Policy would block the original key. It must see
        # the Pattern Policy's replacement instead, in both traffic directions.
        assert payload["action"] == "GUARDRAIL_INTERVENED", payload
        assert "abcdefghijklmnopqrstuvwx" not in str(payload["texts"])
        assert "alice@example.com" not in str(payload["texts"])
    finally:
        await engine.shutdown()


def test_runner_rejects_a_corrupt_generation_and_keeps_last_known_good(
    tmp_path: Path,
) -> None:
    store, registry, _engine = _runtime(tmp_path)
    corrupt = _desired_state()
    corrupt.generation = 2
    corrupt.artifacts[0].config_yaml += "\n# changed after signing"

    with pytest.raises(ValueError, match="checksum"):
        store.apply(corrupt)

    assert store.generation == 1
    assert store.resolve_guardrail("fixture-secrets", 1).deployment_id == "fixture-deployment"
    assert registry.readiness()["ready"] is True


@pytest.mark.parametrize("input_type", ["request", "response"])
async def test_frozen_default_artifact_forwards_complete_redactions_and_blocks_without_models(tmp_path, input_type):
    store, registry, engine = _runtime(tmp_path, FIXTURE.parent / "default-local-v1")
    telemetry = Telemetry()
    app = FastAPI()
    app.include_router(RunnerAPI(
        GuardrailRuntimeService(engine, store, contexts=CallContextStore()),
        store, RunnerMetrics(4), telemetry, "fixture-runner", "controller-token",
    ).router)
    endpoint = "/runtime/v1/integrations/fixture-integration/beta/litellm_basic_guardrail_api"
    samples = [
        ("Passport: E12345678", "Passport: [passport_china_REDACTED]"),
        ("Emirates ID: 784-1990-1234567-1", "Emirates ID: [uae_emirates_id_REDACTED]"),
        ("Driver's licence A1234-56789-01234.", "Driver's licence [ca_on_drivers_licence_REDACTED]."),
        ("Bank account 12345-001-1234567.", "Bank account [ca_bank_account_REDACTED]."),
        ("TCard number 1234567890123456.", "TCard number [uoft_tcard_REDACTED]."),
        ("Phone: +1 (212) 555 1234", "Phone: +[us_phone_REDACTED]"),
        ("Card: 3411 111111 11111", "Card: [amex_REDACTED]"),
        ("VAT AT00000000", "VAT [eu_vat_REDACTED]"),
    ]
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
            async def evaluate(text):
                response = await client.post(endpoint, headers={"x-api-key": RUNTIME_CREDENTIAL}, json={
                    "input_type": input_type, "texts": [text], "request_data": {},
                })
                assert response.status_code == 200
                return response.json()
            for text, expected in samples:
                result = await evaluate(text)
                assert result["action"] == "GUARDRAIL_INTERVENED", (text, result)
                assert result["texts"] == [expected], (text, result)
            safe = await evaluate("Explain how this application works.")
            assert safe["action"] == "NONE"
            blocked = await evaluate("You are a fucking idiot.")
            assert blocked["action"] == "BLOCKED"
            credential = await evaluate("xoxp-0000000000-0000000000-aaaaaaaaaaaaaaaaaaaaaaaa")
            assert credential["action"] == ("BLOCKED" if input_type == "request" else "GUARDRAIL_INTERVENED")
            if input_type == "response":
                assert credential["texts"] == ["[slack_token_REDACTED]"]
        assert registry.readiness()["ready"] is True
        assert telemetry.events
        assert all(event["metadata"]["usage"]["model_invocations"] == 0 for event in telemetry.events)
    finally:
        await engine.shutdown()


def test_runner_restores_the_precompiled_last_known_good_without_controller(
    tmp_path: Path,
) -> None:
    first, _registry, _engine = _runtime(tmp_path)
    assert first.generation == 1

    restarted = ArtifactStore(FIXTURE / "public-key.pem", tmp_path / "state")
    restarted_registry = NeMoRuntimeRegistry(
        restarted,
        action_providers(*local_action_providers()),
        max_concurrency_per_guardrail=4,
    )
    restarted.attach_registry(restarted_registry)

    assert restarted.generation == 1
    assert restarted_registry.readiness()["ready"] is True
    assert restarted.authenticate_integration(
        "fixture-integration",
        RUNTIME_CREDENTIAL,
    )


def _runtime(
    tmp_path: Path,
    fixture: Path = FIXTURE,
) -> tuple[ArtifactStore, NeMoRuntimeRegistry, NeMoRuntime]:
    store = ArtifactStore(fixture / "public-key.pem", tmp_path / "state")
    registry = NeMoRuntimeRegistry(
        store,
        action_providers(*local_action_providers()),
        max_concurrency_per_guardrail=4,
    )
    store.attach_registry(registry)
    store.apply(_desired_state(fixture))
    return store, registry, NeMoRuntime(registry)


def _desired_state(fixture: Path = FIXTURE) -> protocol.DesiredState:
    message = protocol.DesiredState()
    message.ParseFromString(base64.b64decode(
        (fixture / "desired-state.pb.b64").read_text(encoding="utf-8").strip()
    ))
    return message
