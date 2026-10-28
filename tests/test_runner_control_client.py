from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from runner.control_client import RunnerControlClient
from runner.control_transport import CONTROL_CHANNEL_OPTIONS
from runner import generated as protocol
from tests.capability_binding import capability_binding


@pytest.mark.parametrize("tls", [False, True])
def test_both_controller_transports_use_finite_message_limits(monkeypatch, tmp_path, tls):
    from unittest.mock import Mock

    certificate = tmp_path / "certificate.pem"
    certificate.write_bytes(b"test-certificate")
    settings = SimpleNamespace(
        **vars(_settings()), controller_target="127.0.0.1:9090",
        controller_ca_path=certificate if tls else None,
        client_key_path=certificate, client_certificate_path=certificate,
    )
    secure = Mock()
    insecure = Mock()
    credentials = Mock(return_value="test-credentials")
    monkeypatch.setattr("grpc.aio.secure_channel", secure)
    monkeypatch.setattr("grpc.aio.insecure_channel", insecure)
    monkeypatch.setattr("grpc.ssl_channel_credentials", credentials)
    client = RunnerControlClient(settings, Store(), Metrics())
    client._channel()
    if tls:
        secure.assert_called_once_with(settings.controller_target, "test-credentials", options=CONTROL_CHANNEL_OPTIONS)
        insecure.assert_not_called()
    else:
        insecure.assert_called_once_with(settings.controller_target, options=CONTROL_CHANNEL_OPTIONS)
        secure.assert_not_called()


class Store:
    model_revision_id = ""
    generation = 0
    protection_generation = 0
    providers = None
    fail = False

    def apply(self, desired_state, *, providers=None, native_models=None, materialization_key=None):
        if self.fail:
            raise RuntimeError("provider prewarm failed")
        self.providers = providers
        self.native_models = native_models
        self.materialization_key = materialization_key
        self.generation = desired_state.generation

    def verify(self, _artifact):
        return None

    def observability_counts(self):
        return 0, 0, 0


async def test_runner_nacks_real_old_signed_artifact_without_becoming_ready(tmp_path):
    from runner.artifact_store import ArtifactStore
    from tests.test_runner_artifact_store import LEGACY_FIXTURE, Registry, legacy_state
    store = ArtifactStore(LEGACY_FIXTURE / "public-key.pem", tmp_path)
    registry = Registry()
    store.attach_registry(registry)
    client = RunnerControlClient(_settings(), store, Metrics())
    await client._apply_desired_state(legacy_state())
    rejected = await client._outgoing.get()
    assert not rejected.artifact_result.accepted
    assert "artifact_recompile_required" in rejected.artifact_result.reason
    rejected_state = await client._outgoing.get()
    assert not rejected_state.desired_state_result.accepted
    assert "artifact_recompile_required" in rejected_state.desired_state_result.reason
    assert not client.synchronized
    assert store.generation == registry.preparations == 0


class Metrics:
    def observe_control_message(self, *_args):
        pass

    def set_control_state(self, **_kwargs):
        return None

    def set_desired_generation(self, _generation):
        return None

    def observe_desired_state_apply(self, *_args, **_kwargs):
        return None

    def observe_failure(self, *_args, **_kwargs):
        return None

    def set_desired_state(self, **_kwargs):
        return None

    def observe_heartbeat_sent(self):
        return None

    def set_control_queue_depth(self, _depth):
        return None

    def heartbeat(self):
        return protocol.RunnerLoad(max_concurrency=8)


@pytest.mark.asyncio
async def test_runner_acknowledges_an_endpoint_only_generation_immediately():
    settings = SimpleNamespace(
        runner_id="runner-0",
        pool_id="default",
        compiler_capable=False,
    )
    client = RunnerControlClient(settings, Store(), Metrics())  # type: ignore[arg-type]
    assert client.synchronized is False

    await client._apply_desired_state(protocol.DesiredState(generation=11))
    assert client.synchronized is True

    client._connected.clear()
    assert client.synchronized is True

    message = await client._outgoing.get()
    assert message.WhichOneof("body") == "desired_state_result"
    assert message.desired_state_result.accepted is True
    assert message.desired_state_result.generation == 11
    heartbeat = await client._outgoing.get()
    assert heartbeat.WhichOneof("body") == "heartbeat"
    assert heartbeat.heartbeat.runner_id == "runner-0"
    assert heartbeat.heartbeat.applied_generation == 11


@pytest.mark.asyncio
async def test_runner_leases_models_prewarm_registry_and_acknowledges_the_revision():
    store = Store()
    client = RunnerControlClient(_settings(), store, Metrics())  # type: ignore[arg-type]
    client._model_credentials = AsyncMock(  # type: ignore[method-assign]
        return_value={"provider-1": "leased-secret"}
    )

    await client._apply_desired_state(_model_desired_state(generation=12))

    result = await client._outgoing.get()
    assert result.WhichOneof("body") == "desired_state_result"
    assert result.desired_state_result.accepted is True
    assert result.desired_state_result.generation == 12
    assert result.desired_state_result.model_revision_id == "revision-12"
    assert store.providers is not None
    assert store.generation == 12


@pytest.mark.asyncio
async def test_runner_nacks_model_revision_when_atomic_prewarm_fails():
    store = Store()
    store.fail = True
    client = RunnerControlClient(_settings(), store, Metrics())  # type: ignore[arg-type]
    client._model_credentials = AsyncMock(  # type: ignore[method-assign]
        return_value={"provider-1": "leased-secret"}
    )

    await client._apply_desired_state(_model_desired_state(generation=13))

    result = await client._outgoing.get()
    assert result.WhichOneof("body") == "desired_state_result"
    assert result.desired_state_result.accepted is False
    assert result.desired_state_result.generation == 13
    assert result.desired_state_result.model_revision_id == "revision-13"
    assert "provider prewarm failed" in result.desired_state_result.reason
    assert store.generation == 0
    assert client.synchronized is False


def _settings():
    return SimpleNamespace(
        runner_id="runner-0",
        pool_id="default",
        compiler_capable=False,
    )


def test_registration_advertises_explicit_views_support():
    settings = _settings()
    settings.max_concurrency = 4
    client = RunnerControlClient(settings, Store(), Metrics())


def _model_desired_state(*, generation: int) -> protocol.DesiredState:
    return protocol.DesiredState(
        generation=generation,
        model_configuration=protocol.DataPlaneModelConfiguration(
            revision_id=f"revision-{generation}",
            revision=generation,
            runtimes=[protocol.ModelRuntime(
                id="safety",
                base_url="http://safety.mock/v1",
                credential_ref="provider-1",
                model="Qwen/Qwen3Guard-Gen-8B",
                profile_ref="tali.qwen3guard.v1",
                timeout_seconds=20,
                max_tokens=128,
            )],
            bindings=[capability_binding(
                detector_type="content_safety",
                model_ref="safety",
                profile_ref="tali.qwen3guard.v1",
                contract_refs=["tali.guard.content-safety.v1"],
            )],
        ),
    )


@pytest.mark.asyncio
async def test_route_updates_reuse_models_but_credential_rotation_rebuilds_them():
    store = Store()
    client = RunnerControlClient(_settings(), store, Metrics())
    client._model_credentials = AsyncMock(return_value={"provider-1": "first-secret"})
    state = _model_desired_state(generation=20)
    await client._apply_desired_state(state)
    original_providers = client._providers
    original_key = store.materialization_key
    assert original_providers is not None

    state.generation = 21
    await client._apply_desired_state(state)
    assert store.providers is None  # An unchanged model set does not trigger replacement.
    assert client._providers is original_providers
    assert store.materialization_key == original_key

    client._model_credentials.return_value = {"provider-1": "rotated-secret"}
    state.generation = 22
    await client._apply_desired_state(state)
    assert store.providers is not None and store.providers is not original_providers
    assert store.materialization_key != original_key
    assert "secret" not in store.materialization_key


@pytest.mark.asyncio
async def test_failed_apply_does_not_cache_unapplied_model_configuration():
    store = Store()
    client = RunnerControlClient(_settings(), store, Metrics())
    client._model_credentials = AsyncMock(return_value={"provider-1": "test-secret"})
    state = _model_desired_state(generation=23)
    store.fail = True
    await client._apply_desired_state(state)
    assert client._materialization_key is None
    store.fail = False
    await client._apply_desired_state(state)
    assert store.providers is not None and store.generation == 23


@pytest.mark.asyncio
async def test_duplicate_validation_requests_share_execution_and_replay_terminal_failure():
    import asyncio
    from unittest.mock import Mock
    client = RunnerControlClient(_settings(), Store(), Metrics())
    client._metrics.job = Mock()
    client._validator = SimpleNamespace(run=AsyncMock(side_effect=RuntimeError("synthetic test failure")))
    request = protocol.ValidationRequest(run_id="same-run")
    await asyncio.gather(client._validate(request), client._validate(request))
    first = (await client._outgoing.get()).validation_result
    second = (await client._outgoing.get()).validation_result
    client._validator.run.assert_awaited_once()
    assert first == second
    assert not first.accepted
    assert client._validation_result_bytes <= client._validation_result_budget


@pytest.mark.asyncio
async def test_validation_replay_cache_evicts_by_bytes():
    from unittest.mock import Mock
    client = RunnerControlClient(_settings(), Store(), Metrics())
    client._metrics.job = Mock()
    client._validator = SimpleNamespace(run=AsyncMock(side_effect=RuntimeError("synthetic test failure")))
    await client._validate(protocol.ValidationRequest(run_id="run-1"))
    client._validation_result_budget = client._validation_result_bytes
    await client._validate(protocol.ValidationRequest(run_id="run-2"))
    assert list(client._validation_results) == ["run-2"]
    assert client._validation_result_bytes <= client._validation_result_budget
    await client._validate(protocol.ValidationRequest(run_id="run-2"))
    assert client._validator.run.await_count == 2


@pytest.mark.asyncio
async def test_failed_test_returns_compiled_candidate_without_marking_passed():
    from unittest.mock import Mock
    client = RunnerControlClient(_settings(), Store(), Metrics())
    client._metrics.job = Mock()
    client._store.model_revision_id = "models-1"
    artifact = protocol.Artifact(guardrail_id="guardrail-default", guardrail_version="candidate")
    client._validator = SimpleNamespace(compiler_model_types=[], run=AsyncMock(return_value=SimpleNamespace(
        status="failed", metrics={}, results=[], artifact=artifact, test_scope=None)))
    await client._execute_validation(protocol.ValidationRequest(run_id="failed"))
    result = (await client._outgoing.get()).validation_result
    assert result.accepted and result.status == protocol.VALIDATION_STATUS_FAILED
    assert result.candidate_artifact == artifact


@pytest.mark.asyncio
async def test_modes_overtake_model_preparation_and_report_nacks(tmp_path):
    import asyncio
    from runner.artifact_store import ArtifactStore
    from tests.test_runner_artifact_store import FIXTURE
    store = ArtifactStore(FIXTURE / "public-key.pem", tmp_path / "state")
    client = RunnerControlClient(_settings(), store, Metrics())
    started, finish = asyncio.Event(), asyncio.Event()
    async def prepare(_):
        started.set()
        await finish.wait()
    client._apply_desired_state = prepare
    async def incoming():
        yield protocol.ControllerMessage(desired_state=protocol.DesiredState(generation=1))
        await started.wait()
        yield protocol.ControllerMessage(protection_state=protocol.GuardrailProtectionState(generation=2, modes={"g": "bypass"}))
        result = await client._outgoing.get()
        assert result.protection_result.accepted and result.protection_result.generation == 2
        assert store.protection_mode("g") == "bypass" and not finish.is_set()
        yield protocol.ControllerMessage(protection_state=protocol.GuardrailProtectionState(generation=3, modes={"g": "unknown"}))
        result = await client._outgoing.get()
        assert not result.protection_result.accepted and result.protection_result.reason
        assert store.protection_mode("g") == "bypass"
        finish.set()
    await asyncio.wait_for(client._receive_messages(incoming()), 3)


@pytest.mark.asyncio
async def test_offline_compilation_reports_failures_and_capacity_without_state_changes():
    from unittest.mock import Mock

    settings = _settings()
    settings.compiler_capable = True
    compiler = Mock()
    compiler.compile_offline.side_effect = ValueError("Invalid plan")
    client = RunnerControlClient(settings, Store(), Metrics(), compiler=compiler)
    request = protocol.CompileRequest(compile_id="bad-plan")
    await client._compile_artifact(request)
    reply = await client._outgoing.get()
    assert reply.artifact_compilation_result.error == "Invalid plan"
    assert not reply.artifact_compilation_result.HasField("artifact")
    client._capability_tasks = set(range(4))
    await client._handle(protocol.ControllerMessage(artifact_compilation_request=request))
    reply = await client._outgoing.get()
    assert "capacity" in reply.artifact_compilation_result.error
    assert compiler.compile_offline.call_count == 1
    client._capability_tasks.clear()
