"""Real gRPC loopback check for the opt-in Runner lease consumer."""
from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace

import grpc
import pytest

from runner import generated as protocol
from runner.generated import runner_control_pb2_grpc as services
from runner.control_client import RunnerControlClient
from runner.serving_lease import ServingLease
from tests.test_runner_control_client import Metrics, Store


@pytest.mark.asyncio
async def test_lease_expiry_reconnects_and_requires_a_fresh_challenged_snapshot(monkeypatch):
    # This transport test explicitly uses a test clock; platform clock safety is
    # covered separately and is not inferred from this loopback test.
    monkeypatch.setattr("runner.control_client.ServingLease", lambda maximum: ServingLease(maximum, clock=time.monotonic))
    granted, replaced = asyncio.Event(), asyncio.Event()
    sessions = []

    class Controller(services.RunnerControlServicer):
        async def Connect(self, requests, context):
            hello = await anext(requests)
            assert dict(context.invocation_metadata())['authorization'] == 'Bearer pool-credential'
            assert hello.registration.labels['tasklattice.lease-probe'] == '1'
            sessions.append(hello.registration.boot_id)
            serial = len(sessions)
            nonce = f'snapshot-{serial}'
            yield protocol.ControllerMessage(desired_state=protocol.DesiredState(
                generation=serial, snapshot_nonce=nonce, allocation_epoch=4))
            acknowledged = False
            async for message in requests:
                if message.WhichOneof('body') == 'desired_state_result':
                    acknowledged = message.desired_state_result.accepted and message.desired_state_result.snapshot_nonce == nonce
                if message.WhichOneof('body') != 'serving_lease_request':
                    continue
                assert acknowledged
                request = message.serving_lease_request
                assert request.snapshot_nonce == nonce and request.epoch == 4 and request.generation == serial
                if serial == 1:
                    yield protocol.ControllerMessage(serving_lease_response=protocol.ServingLeaseResponse(
                        granted=True, nonce=request.nonce, epoch=4, generation=serial, snapshot_nonce=nonce, duration_ms=200))
                    granted.set()
                else:
                    replaced.set()
                    # No second grant: reapplying a snapshot alone must stay fenced.

    server = grpc.aio.server()
    services.add_RunnerControlServicer_to_server(Controller(), server)
    port = server.add_insecure_port('127.0.0.1:0')
    assert port > 0
    await server.start()
    settings = SimpleNamespace(runner_id='runner', pool_id='pool-a', compiler_capable=False,
        max_concurrency=1, controller_token='legacy', control_token='pool-credential',
        controller_target=f'127.0.0.1:{port}', controller_ca_path=None, experimental_lease_enforcement=True)
    client = RunnerControlClient(settings, Store(), Metrics())
    task = asyncio.create_task(client.run())
    try:
        await asyncio.wait_for(granted.wait(), 2)
        for _ in range(100):
            if client.synchronized:
                break
            await asyncio.sleep(0.001)
        assert client.synchronized
        period = client.synchronization_lost
        await asyncio.wait_for(replaced.wait(), 3)
        assert sessions[0] == sessions[1]  # A reconnect is the same boot, fresh stream.
        assert period.is_set()
        assert client._store.generation == 2
        assert not client.synchronized
        assert not task.done()
    finally:
        await client.stop()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await server.stop(None)
