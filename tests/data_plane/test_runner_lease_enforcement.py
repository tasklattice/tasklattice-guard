from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from runner import generated as protocol
from runner.control_client import RunnerControlClient
from runner.serving_lease import ServingLease
from runner.synchronization import RuntimeSynchronizationMiddleware
from tests.test_runner_control_client import Metrics, Store, _settings


@pytest.fixture
def enforced(monkeypatch):
    now = [100.0]
    monkeypatch.setattr("runner.control_client.ServingLease", lambda maximum: ServingLease(maximum, clock=lambda: now[0]))
    settings = SimpleNamespace(**vars(_settings()), control_token="pool-token", experimental_lease_enforcement=True)
    return RunnerControlClient(settings, Store(), Metrics()), now


async def apply(client, *, generation=11, epoch=3, nonce="snapshot-a"):
    await client._apply_desired_state(protocol.DesiredState(generation=generation,
        snapshot_nonce=nonce, allocation_epoch=epoch))


def challenge(client):
    request = client._serving_lease.challenge()
    client._pending_lease = (request, client._lease_snapshot_nonce)
    client._lease_reply = asyncio.Event()
    return request


def response(request, snapshot="snapshot-a", **changes):
    fields = dict(nonce=request.nonce, granted=True, epoch=request.epoch, generation=request.generation,
                  snapshot_nonce=snapshot, duration_ms=5_000)
    return protocol.ServingLeaseResponse(**{**fields, **changes})


@pytest.mark.asyncio
async def test_applied_snapshot_stays_fenced_until_matching_grant(enforced):
    client, _ = enforced
    await apply(client)
    assert client._store.generation == 11
    assert not client.synchronized
    assert client.synchronization_lost.is_set()
    queued = [await client._outgoing.get(), await client._outgoing.get()]
    assert queued[0].WhichOneof("body") == "desired_state_result"
    assert queued[0].desired_state_result.accepted
    request = challenge(client)
    client._accept_lease_response(response(request))
    assert client.synchronized
    assert not client.synchronization_lost.is_set()
    client._revoke_synchronization()


@pytest.mark.asyncio
@pytest.mark.parametrize("state", [protocol.DesiredState(generation=1),
    protocol.DesiredState(generation=1, snapshot_nonce="challenge"),
    protocol.DesiredState(generation=1, allocation_epoch=0),
    protocol.DesiredState(generation=1, snapshot_nonce="challenge", allocation_epoch=-1)])
async def test_missing_or_invalid_epoch_never_defaults_to_zero(enforced, state):
    client, _ = enforced
    await client._apply_desired_state(state)
    assert not client.synchronized
    assert client._store.generation == 0
    result = await client._outgoing.get()
    assert not result.desired_state_result.accepted
    assert not client._lease_snapshot_ready.is_set()


@pytest.mark.asyncio
async def test_rejected_initial_snapshot_wakes_supervisor_without_ever_requesting_a_grant(enforced):
    client, _ = enforced
    cancel = Mock()
    renewal = asyncio.create_task(client._lease_renewals(cancel))
    try:
        await asyncio.sleep(0)
        await client._apply_desired_state(protocol.DesiredState(generation=1, snapshot_nonce="missing-epoch"))
        await asyncio.wait_for(renewal, 1)
        cancel.assert_called_once()
        assert client._lease_reconnect.is_set()
        assert not client.synchronized
        queued = []
        while not client._outgoing.empty():
            queued.append(client._outgoing.get_nowait())
        assert any(message.WhichOneof("body") == "desired_state_result" and not message.desired_state_result.accepted
                   for message in queued)
        assert all(message.WhichOneof("body") != "serving_lease_request" for message in queued)
    finally:
        renewal.cancel()
        await asyncio.gather(renewal, return_exceptions=True)


@pytest.mark.asyncio
async def test_waiting_for_first_snapshot_is_fenced_and_supervisor_is_cancelable(enforced):
    client, _ = enforced
    cancel = Mock()
    renewal = asyncio.create_task(client._lease_renewals(cancel))
    try:
        await asyncio.sleep(0)
        assert not client.synchronized
        assert client.synchronization_lost.is_set()
        assert client._outgoing.empty()
        cancel.assert_not_called()
    finally:
        renewal.cancel()
        await asyncio.gather(renewal, return_exceptions=True)
    assert renewal.cancelled()


@pytest.mark.asyncio
@pytest.mark.parametrize("changes", [{"epoch": 4}, {"generation": 12}, {"snapshot_nonce": "other"},
    {"duration_ms": 5_001}, {"duration_ms": 0}, {"granted": False}])
async def test_conflicting_or_denied_grant_fails_closed(enforced, changes):
    client, _ = enforced
    await apply(client)
    request = challenge(client)
    client._accept_lease_response(response(request, **changes))
    assert not client.synchronized
    assert client._lease_reconnect.is_set()
    assert client._lease_reply.is_set()


@pytest.mark.asyncio
async def test_expired_and_replayed_responses_cannot_reopen_authority(enforced):
    client, now = enforced
    await apply(client)
    request = challenge(client)
    client._accept_lease_response(response(request))
    period = client.synchronization_lost
    now[0] += 5
    assert not client.synchronized
    assert period.is_set()
    client._accept_lease_response(response(request))
    assert not client.synchronized
    assert period.is_set()
    await apply(client, generation=12, nonce="snapshot-b")
    client._accept_lease_response(response(request))
    assert not client.synchronized
    fresh = challenge(client)
    client._accept_lease_response(response(fresh, snapshot="snapshot-b"))
    assert client.synchronized
    assert period.is_set()
    client._revoke_synchronization()


@pytest.mark.asyncio
async def test_delayed_initial_reply_is_measured_from_request_start(enforced):
    client, now = enforced
    await apply(client)
    request = challenge(client)
    now[0] += 5
    client._accept_lease_response(response(request))
    assert not client.synchronized
    assert client._lease_reconnect.is_set()


@pytest.mark.asyncio
async def test_renewal_request_follows_ack_and_rejection_reconnects(enforced):
    client, _ = enforced
    cancel = Mock()
    await apply(client)
    task = asyncio.create_task(client._lease_renewals(cancel))
    try:
        ack = await client._outgoing.get()
        heartbeat = await client._outgoing.get()
        renewal = await asyncio.wait_for(client._outgoing.get(), 1)
        assert ack.WhichOneof("body") == "desired_state_result"
        assert heartbeat.WhichOneof("body") == "heartbeat"
        assert renewal.WhichOneof("body") == "serving_lease_request"
        request = renewal.serving_lease_request
        assert (request.epoch, request.generation, request.snapshot_nonce) == (3, 11, "snapshot-a")
        client._accept_lease_response(protocol.ServingLeaseResponse(nonce=request.nonce, granted=False))
        await asyncio.wait_for(task, 1)
        cancel.assert_called_once()
        assert not client.synchronized
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_direct_control_work_is_canceled_when_lease_expires(enforced):
    client, now = enforced
    await apply(client)
    request = challenge(client)
    client._accept_lease_response(response(request))
    entered, canceled = asyncio.Event(), asyncio.Event()
    async def work():
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            canceled.set()
    task = asyncio.create_task(client._lease_bound_work(work))
    await entered.wait()
    now[0] += 5
    assert not client.synchronized  # Deadline check signals the loss event.
    with pytest.raises(RuntimeError, match="lease was lost"):
        await asyncio.wait_for(task, 1)
    assert canceled.is_set()


@pytest.mark.asyncio
async def test_lease_response_is_not_blocked_by_an_ordered_long_command(enforced):
    client, _ = enforced
    await apply(client)
    request = challenge(client)
    entered, release = asyncio.Event(), asyncio.Event()
    original = client._handle
    async def handle(message):
        if message.WhichOneof("body") == "validation_request":
            entered.set()
            await release.wait()
        else:
            await original(message)
    client._handle = handle
    async def stream():
        yield protocol.ControllerMessage(validation_request=protocol.ValidationRequest(run_id="long"))
        await entered.wait()
        yield protocol.ControllerMessage(serving_lease_response=response(request))
        assert client.synchronized
        release.set()
    await asyncio.wait_for(client._receive_messages(stream()), 1)
    assert client.synchronized
    client._revoke_synchronization()


@pytest.mark.asyncio
async def test_unleased_validation_never_executes_or_replays_cached_result(enforced):
    client, _ = enforced
    client._execute_validation = AsyncMock()
    await client._validate(protocol.ValidationRequest(run_id="run"))
    client._execute_validation.assert_not_called()
    result = await client._outgoing.get()
    assert result.WhichOneof("body") == "validation_status_notice"
    assert result.validation_status_notice.status == protocol.VALIDATION_STATUS_FAILED
    assert result.validation_status_notice.reason == "Runner serving lease is unavailable."


@pytest.mark.asyncio
async def test_silent_stream_or_blocked_send_forces_reconnect(enforced, monkeypatch):
    client, _ = enforced
    monkeypatch.setattr("runner.control_client._LEASE_RESPONSE_TIMEOUT_SECONDS", 0.01)
    await apply(client)
    cancel = Mock()
    # A saturated transport queue must count against the same response budget.
    async def blocked_send(_message):
        await asyncio.Event().wait()
    client._send = blocked_send
    await asyncio.wait_for(client._lease_renewals(cancel), 1)
    assert not client.synchronized
    assert client._lease_reconnect.is_set()
    cancel.assert_called_once()


@pytest.mark.asyncio
async def test_expiry_fences_new_and_active_runtime_and_internal_requests(enforced):
    import httpx
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    client, now = enforced
    await apply(client)
    request = challenge(client)
    client._accept_lease_response(response(request))
    entered, canceled = asyncio.Event(), asyncio.Event()
    async def slow(_request):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            canceled.set()
    async def ok(_request):
        return JSONResponse({"ok": True})
    app = Starlette(routes=[Route('/runtime/test', slow), Route('/internal/test', ok), Route('/health/ready', ok)])
    app.add_middleware(RuntimeSynchronizationMiddleware, control=client)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://runner') as http:
        active = asyncio.create_task(http.get('/runtime/test'))
        await entered.wait()
        now[0] += 5
        assert not client.synchronized
        assert (await asyncio.wait_for(active, 1)).status_code == 503
        assert canceled.is_set()
        assert (await http.get('/internal/test')).status_code == 503
        assert (await http.get('/health/ready')).status_code == 200  # Health routes are outside middleware.


@pytest.mark.asyncio
async def test_expiry_rechecked_before_stream_frame_send(enforced):
    client, now = enforced
    await apply(client)
    request = challenge(client)
    client._accept_lease_response(response(request))
    emitted = []
    async def app(_scope, _receive, send):
        await send({'type': 'websocket.accept'})
        now[0] += 5
        await send({'type': 'websocket.send', 'text': 'must-not-escape'})
    async def receive():
        return {'type': 'websocket.connect'}
    async def send(message):
        emitted.append(message)
    middleware = RuntimeSynchronizationMiddleware(app, client)
    await middleware({'type': 'websocket', 'path': '/runtime/stream'}, receive, send)
    assert emitted[0]['type'] == 'websocket.accept'
    assert not any(message.get('text') == 'must-not-escape' for message in emitted)
    assert emitted[-1]['type'] == 'websocket.close'


@pytest.mark.asyncio
async def test_queued_control_work_result_is_withheld_after_expiry(enforced):
    client, now = enforced
    await apply(client)
    while not client._outgoing.empty():
        client._outgoing.get_nowait()
    request = challenge(client)
    client._accept_lease_response(response(request))
    await client._send(protocol.RunnerMessage(validation_report_chunk=protocol.ValidationReportChunk(run_id='stale', gzip_result=b'private-report')))
    await client._send(protocol.RunnerMessage(heartbeat=protocol.RunnerHeartbeat(runner_id='runner')))
    now[0] += 5
    messages = client._messages(protocol.RunnerMessage(registration=protocol.RunnerRegistration(runner_id='runner')))
    assert (await anext(messages)).WhichOneof('body') == 'registration'
    assert (await asyncio.wait_for(anext(messages), 1)).WhichOneof('body') == 'heartbeat'
    await messages.aclose()


@pytest.mark.asyncio
async def test_old_period_result_is_not_released_after_a_new_grant(enforced):
    client, _ = enforced
    await apply(client)
    while not client._outgoing.empty():
        client._outgoing.get_nowait()
    initial = challenge(client)
    client._accept_lease_response(response(initial))
    await client._send(protocol.RunnerMessage(validation_report_chunk=protocol.ValidationReportChunk(run_id='private-old', gzip_result=b'private-report')))
    old_period = client.synchronization_lost
    await apply(client, generation=12, nonce='snapshot-b')
    fresh = challenge(client)
    client._accept_lease_response(response(fresh, snapshot='snapshot-b'))
    assert client.synchronized and old_period.is_set()
    messages = client._messages(protocol.RunnerMessage(registration=protocol.RunnerRegistration(runner_id='runner')))
    assert (await anext(messages)).WhichOneof('body') == 'registration'
    assert (await anext(messages)).WhichOneof('body') == 'desired_state_result'
    assert (await anext(messages)).WhichOneof('body') == 'heartbeat'
    await messages.aclose()
    client._revoke_synchronization()


@pytest.mark.asyncio
async def test_old_task_context_cannot_enqueue_private_result_after_regrant(enforced):
    client, _ = enforced
    await apply(client)
    initial = challenge(client)
    client._accept_lease_response(response(initial))
    entered, release = asyncio.Event(), asyncio.Event()
    async def work():
        entered.set()
        try:
            await release.wait()
        except asyncio.CancelledError:
            # A slow/cooperative cleanup that reaches a result after a new
            # grant must still carry the old work period's permanent fence.
            await release.wait()
        await client._send(protocol.RunnerMessage(validation_report_chunk=protocol.ValidationReportChunk(run_id='private-old', gzip_result=b'private-report')))
    task = asyncio.create_task(client._lease_bound_work(work))
    await entered.wait()
    await apply(client, generation=12, nonce='snapshot-b')
    fresh = challenge(client)
    client._accept_lease_response(response(fresh, snapshot='snapshot-b'))
    assert client.synchronized
    release.set()
    with pytest.raises(RuntimeError, match='lease was lost'):
        await asyncio.wait_for(task, 1)
    queued = []
    while not client._outgoing.empty():
        queued.append(client._outgoing.get_nowait())
    assert all(message.WhichOneof('body') != 'validation_report_chunk' for message in queued)
    client._revoke_synchronization()
