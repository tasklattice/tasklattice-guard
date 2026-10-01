from __future__ import annotations

import base64
import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import grpc
import pytest

from runner import generated as protocol
from runner.artifact_store import ArtifactStore
from runner.control_client import RunnerControlClient
from runner.control_transport import CONTROL_CHANNEL_OPTIONS
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
from tests.capability_binding import capability_binding


FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "artifacts" / "local-secrets-v1"


@pytest.mark.asyncio
@pytest.mark.parametrize("server_abort", [False, True])
async def test_large_validation_round_trip_and_reconnect_sender_cleanup(tmp_path: Path, server_abort: bool) -> None:
    """Real protobuf/socket/Runner dispatch, mocked validation computation only."""
    content = "synthetic transport evidence " * 700
    request = protocol.ValidationRequest(run_id="large-validation", test_cases=[
        protocol.ValidationTestCase(id=f"case-{index}", content=content)
        for index in range(321)
    ])
    assert request.ByteSize() > 4 * 1024 * 1024
    results = [{"caseId": case.id, "passed": True, "outputContent": case.content}
               for case in request.test_cases]
    received = []

    class ValidationController(services.RunnerControlServicer):
        async def Connect(self, request_iterator, context):  # noqa: N802
            assert (await request_iterator.__anext__()).WhichOneof("body") == "registration"
            yield protocol.ControllerMessage(validation_request=request)
            async for message in request_iterator:
                if message.WhichOneof("body") == "validation_result":
                    received.append(message.validation_result)
                    if server_abort:
                        await context.abort(grpc.StatusCode.UNAVAILABLE, "synthetic connection loss")
                    return

    server = grpc.aio.server(options=CONTROL_CHANNEL_OPTIONS)
    services.add_RunnerControlServicer_to_server(ValidationController(), server)
    port = server.add_insecure_port("127.0.0.1:0")
    await server.start()
    settings = SimpleNamespace(
        runner_id="e2e-runner", pool_id="default", compiler_capable=False,
        max_concurrency=4, controller_ca_path=None,
        controller_target=f"127.0.0.1:{port}", controller_token="e2e-runner-token",
    )
    client = RunnerControlClient(settings, ArtifactStore(FIXTURE / "public-key.pem", tmp_path), RunnerMetrics(4))
    client._validator = SimpleNamespace(validate=AsyncMock(return_value=(
        "passed", {"total": 321, "passed": 321}, results,
    )))
    baseline_tasks = asyncio.all_tasks()
    try:
        for _ in range(3):
            if server_abort:
                with pytest.raises(grpc.aio.AioRpcError) as failure:
                    await asyncio.wait_for(client._connect_once(), timeout=10)
                assert failure.value.code() == grpc.StatusCode.UNAVAILABLE
            else:
                await asyncio.wait_for(client._connect_once(), timeout=10)
            # A completed stream must not leave a sender waiting on the old queue.
            assert not [task for task in asyncio.all_tasks() - baseline_tasks
                        if task.get_name() == "guard-control-writer"]
    finally:
        await server.stop(grace=0)
    assert len(received) == 3
    for result in received:
        assert result.ByteSize() > 4 * 1024 * 1024
        assert result.accepted and result.metrics.passed == 321
        assert len(result.results) == 321
        assert [item.case_id for item in result.results] == [item.id for item in request.test_cases]
        assert all(item.output_content == content for item in result.results)
    assert not client.connected


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
        accepted = False
        async for message in request_iterator:
            self.received.append(message)
            if message.WhichOneof("body") == "desired_state_result":
                if not message.desired_state_result.accepted:
                    return
                accepted = True
            # Applying desired state also sends its new generation immediately.
            # Closing after the ACK races that required heartbeat write in gRPC.
            if (accepted and message.WhichOneof("body") == "heartbeat"
                    and message.heartbeat.applied_generation == self.desired_state.generation):
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
    assert controller.received[-1].heartbeat.applied_generation == 1
    assert store.generation == 1
    assert client.synchronized is True
    assert registry.readiness()["ready"] is True


@pytest.mark.parametrize(
    "configuration,credentials",
    [
        pytest.param(
            lambda: _split_guard_configuration(),
            {"provider-nvidia": "mock-nvidia-key"},
            id="split-guard-stack",
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
    assert controller.received[-1].heartbeat.applied_generation == desired_state.generation
    assert client.synchronized is True
    assert client._providers is not None
    assert registry.readiness()["ready"] is True


def _desired_state() -> protocol.DesiredState:
    message = protocol.DesiredState()
    message.ParseFromString(base64.b64decode(
        (FIXTURE / "desired-state.pb.b64").read_text(encoding="utf-8").strip()
    ))
    return message


def _split_guard_configuration() -> protocol.DataPlaneModelConfiguration:
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
                id="chat-jailbreak",
                base_url="http://nvidia.mock/v1",
                credential_ref="provider-nvidia",
                model="example/jailbreak-judge",
                profile_ref="tali.openai-compatible-jailbreak.v1",
                timeout_seconds=20,
                max_tokens=32,
            ),
        ],
        bindings=[
            capability_binding(
                detector_type="content_safety",
                model_ref="nvidia-safety",
                profile_ref="tali.nemotron-safety-guard-v3.v1",
                contract_refs=[CONTRACT_CONTENT_SAFETY],
            ),
            capability_binding(
                detector_type="topic_control",
                model_ref="nvidia-topic",
                profile_ref="tali.nemoguard-topic-control.v1",
                contract_refs=[
                    "tali.guard.topic-control.semantic.v1",
                    "tali.guard.company-policy.v1",
                ],
            ),
            capability_binding(
                detector_type="jailbreak_detection",
                model_ref="chat-jailbreak",
                profile_ref="tali.openai-compatible-jailbreak.v1",
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
        bindings=[capability_binding(
            detector_type="content_safety",
            model_ref="qwen3guard",
            profile_ref="tali.qwen3guard.v1",
            contract_refs=[
                CONTRACT_CONTENT_SAFETY,
                CONTRACT_JAILBREAK,
                CONTRACT_PII_SEMANTIC,
            ],
        )],
    )
