from __future__ import annotations

import base64
from pathlib import Path
from types import SimpleNamespace

import grpc
import pytest

from runner import generated as protocol
from runner.artifact_store import ArtifactStore
from runner.control_client import RunnerControlClient
from runner.generated import runner_control_pb2_grpc as services
from runner.metrics import RunnerMetrics
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.actions import local_action_providers
from runner.toolkit.evaluation.contracts import (
    CONTRACT_CONTENT_SAFETY,
    CONTRACT_JAILBREAK,
    CONTRACT_PII_SEMANTIC,
)
from runner.toolkit.nemo.registry import NeMoRuntimeRegistry


FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "artifacts" / "local-secrets-v1"


class MockController(services.RunnerControlServicer):
    def __init__(self, desired_state: protocol.DesiredState) -> None:
        self.desired_state = desired_state
        self.received: list[protocol.RunnerMessage] = []

    async def Connect(self, request_iterator, context):  # noqa: N802
        metadata = dict(context.invocation_metadata())
        assert metadata["authorization"] == "Bearer e2e-runner-token"
        registration = await request_iterator.__anext__()
        self.received.append(registration)
        assert registration.WhichOneof("body") == "registration"
        yield protocol.ControllerMessage(
            message_id="registration-accepted",
            registration_accepted=protocol.RegistrationAccepted(
                desired_generation=self.desired_state.generation,
                heartbeat_interval_seconds=30,
            ),
        )
        yield protocol.ControllerMessage(
            message_id="desired-state",
            desired_state=self.desired_state,
        )
        async for message in request_iterator:
            self.received.append(message)
            if message.WhichOneof("body") == "desired_state_result":
                return


@pytest.mark.asyncio
async def test_mock_controller_and_real_runner_exchange_and_apply_desired_state(
    tmp_path: Path,
) -> None:
    desired_state = _desired_state()
    controller = MockController(desired_state)
    server = grpc.aio.server()
    services.add_RunnerControlServicer_to_server(controller, server)
    port = server.add_insecure_port("127.0.0.1:0")
    await server.start()

    store = ArtifactStore(FIXTURE / "public-key.pem", tmp_path / "runner-state")
    registry = NeMoRuntimeRegistry(
        store,
        action_providers(*local_action_providers()),
        max_concurrency_per_guardrail=4,
    )
    store.attach_registry(registry)
    settings = SimpleNamespace(
        runner_id="e2e-runner",
        pool_id="default",
        compiler_capable=False,
        max_concurrency=4,
        controller_ca_path=None,
        client_key_path=None,
        client_certificate_path=None,
        controller_target=f"127.0.0.1:{port}",
        controller_token="e2e-runner-token",
    )
    client = RunnerControlClient(
        settings,  # type: ignore[arg-type]
        store,
        RunnerMetrics(4),
    )
    try:
        await client._connect_once()
    finally:
        await server.stop(grace=0)

    bodies = [message.WhichOneof("body") for message in controller.received]
    assert bodies[:3] == ["registration", "artifact_result", "desired_state_result"]
    result = next(
        message.desired_state_result
        for message in controller.received
        if message.WhichOneof("body") == "desired_state_result"
    )
    assert result.runner_id == "e2e-runner"
    assert result.generation == 1
    assert result.accepted is True
    assert store.generation == 1
    assert client.synchronized is True
    assert registry.readiness()["ready"] is True


@pytest.mark.parametrize(
    "configuration,credentials",
    [
        pytest.param(
            lambda: _nvidia_trio_configuration(),
            {"provider-nvidia": "mock-nvidia-key"},
            id="nvidia-trio",
        ),
        pytest.param(
            lambda: _qwen3guard_configuration(),
            {"provider-qwen-mock": "mock-qwen-key"},
            id="qwen3guard-mock",
        ),
    ],
)
@pytest.mark.asyncio
async def test_runner_accepts_replaceable_model_configuration_in_desired_state(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    configuration,
    credentials: dict[str, str],
) -> None:
    model_configuration = configuration()
    desired_state = _desired_state()
    desired_state.model_configuration.CopyFrom(model_configuration)
    controller = MockController(desired_state)
    server = grpc.aio.server()
    services.add_RunnerControlServicer_to_server(controller, server)
    port = server.add_insecure_port("127.0.0.1:0")
    await server.start()

    async def resolve_credentials(_client, _configuration):
        return credentials

    monkeypatch.setattr(RunnerControlClient, "_model_credentials", resolve_credentials)
    store = ArtifactStore(FIXTURE / "public-key.pem", tmp_path / "runner-state")
    registry = NeMoRuntimeRegistry(
        store,
        action_providers(*local_action_providers()),
        max_concurrency_per_guardrail=4,
    )
    store.attach_registry(registry)
    settings = SimpleNamespace(
        runner_id="e2e-runner",
        pool_id="default",
        compiler_capable=False,
        max_concurrency=4,
        controller_ca_path=None,
        client_key_path=None,
        client_certificate_path=None,
        controller_target=f"127.0.0.1:{port}",
        controller_token="e2e-runner-token",
    )
    client = RunnerControlClient(
        settings,  # type: ignore[arg-type]
        store,
        RunnerMetrics(4),
    )
    try:
        await client._connect_once()
    finally:
        await server.stop(grace=0)

    result = next(
        message.desired_state_result
        for message in controller.received
        if message.WhichOneof("body") == "desired_state_result"
    )
    assert result.accepted is True
    assert result.model_revision_id == model_configuration.revision_id
    assert client.synchronized is True
    assert client._providers is not None
    assert registry.readiness()["ready"] is True


def _desired_state() -> protocol.DesiredState:
    message = protocol.DesiredState()
    message.ParseFromString(base64.b64decode(
        (FIXTURE / "desired-state.pb.b64").read_text(encoding="utf-8").strip()
    ))
    return message


def _nvidia_trio_configuration() -> protocol.DataPlaneModelConfiguration:
    return protocol.DataPlaneModelConfiguration(
        revision_id="revision-nvidia-trio",
        revision=5,
        runtimes=[
            protocol.ModelRuntime(
                id="nvidia-safety",
                base_url="http://nvidia.mock/v1",
                credential_ref="provider-nvidia",
                model="nvidia/llama-3.1-nemotron-safety-guard-8b-v3",
                profile_ref="tali.nemotron-safety-guard-v3.v1",
                timeout_seconds=20,
                max_tokens=128,
            ),
            protocol.ModelRuntime(
                id="nvidia-topic",
                base_url="http://nvidia.mock/v1",
                credential_ref="provider-nvidia",
                model="nvidia/llama-3.1-nemoguard-8b-topic-control",
                profile_ref="tali.nemoguard-topic-control.v1",
                timeout_seconds=20,
                max_tokens=32,
            ),
            protocol.ModelRuntime(
                id="nvidia-jailbreak",
                base_url="http://nvidia.mock/v1",
                credential_ref="provider-nvidia",
                model="nvidia/nvidia-nemotron-nano-9b-v2",
                profile_ref="tali.nemotron-nano-jailbreak.v1",
                timeout_seconds=20,
                max_tokens=32,
            ),
        ],
        assignments=[
            protocol.ModelAssignment(
                role="safety_evaluator",
                model_ref="nvidia-safety",
                profile_ref="tali.nemotron-safety-guard-v3.v1",
                contract_refs=[CONTRACT_CONTENT_SAFETY],
            ),
            protocol.ModelAssignment(
                role="topic_policy_judge",
                model_ref="nvidia-topic",
                profile_ref="tali.nemoguard-topic-control.v1",
                contract_refs=[
                    "tali.guard.topic-control.semantic.v1",
                    "tali.guard.company-policy.v1",
                ],
            ),
            protocol.ModelAssignment(
                role="jailbreak_evaluator",
                model_ref="nvidia-jailbreak",
                profile_ref="tali.nemotron-nano-jailbreak.v1",
                contract_refs=[CONTRACT_JAILBREAK],
            ),
        ],
    )


def _qwen3guard_configuration() -> protocol.DataPlaneModelConfiguration:
    return protocol.DataPlaneModelConfiguration(
        revision_id="revision-qwen-mock",
        revision=6,
        runtimes=[protocol.ModelRuntime(
            id="qwen3guard",
            base_url="http://qwen3guard.mock/v1",
            credential_ref="provider-qwen-mock",
            model="Qwen/Qwen3Guard-Gen-8B",
            profile_ref="tali.qwen3guard.v1",
            timeout_seconds=20,
            max_tokens=128,
        )],
        assignments=[protocol.ModelAssignment(
            role="safety_evaluator",
            model_ref="qwen3guard",
            profile_ref="tali.qwen3guard.v1",
            contract_refs=[
                CONTRACT_CONTENT_SAFETY,
                CONTRACT_JAILBREAK,
                CONTRACT_PII_SEMANTIC,
            ],
        )],
    )
