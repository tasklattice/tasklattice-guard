from __future__ import annotations

from types import SimpleNamespace

import pytest

from runner.control_client import RunnerControlClient
from runner import generated as protocol


class Store:
    generation = 0

    def apply(self, desired_state):
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
    assert message.WhichOneof("body") == "heartbeat"
    assert message.heartbeat.runner_id == "runner-0"
    assert message.heartbeat.applied_generation == 11
