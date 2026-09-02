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
) -> tuple[ArtifactStore, NeMoRuntimeRegistry, NeMoRuntime]:
    store = ArtifactStore(FIXTURE / "public-key.pem", tmp_path / "state")
    registry = NeMoRuntimeRegistry(
        store,
        action_providers(*local_action_providers()),
        max_concurrency_per_guardrail=4,
    )
    store.attach_registry(registry)
    store.apply(_desired_state())
    return store, registry, NeMoRuntime(registry)


def _desired_state() -> protocol.DesiredState:
    message = protocol.DesiredState()
    message.ParseFromString(base64.b64decode(
        (FIXTURE / "desired-state.pb.b64").read_text(encoding="utf-8").strip()
    ))
    return message
