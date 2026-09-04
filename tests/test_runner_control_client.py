from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from runner.control_client import RunnerControlClient
from runner import generated as protocol


class Store:
    generation = 0
    providers = None
    fail = False

    def apply(self, desired_state, *, providers=None, native_models=None):
        if self.fail:
            raise RuntimeError("provider prewarm failed")
        self.providers = providers
        self.native_models = native_models
        self.generation = desired_state.generation

    def observability_counts(self):
        return 0, 0, 0


class Metrics:
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
async def test_runner_acknowledges_an_integration_only_generation_immediately():
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
            assignments=[protocol.ModelAssignment(
                role="safety_evaluator",
                model_ref="safety",
                profile_ref="tali.qwen3guard.v1",
                contract_refs=["tali.guard.content-safety.v1"],
            )],
        ),
    )
