"""Lease primitive tests; these do not assert Controller-side reallocation safety."""
from __future__ import annotations

import asyncio
import time
from dataclasses import replace

import pytest

from runner.serving_lease import ServingLease


class Clock:
    def __init__(self) -> None:
        self.value = 100.0

    def __call__(self) -> float:
        return self.value


def grant(lease, challenge, duration=5):
    return lease.accept(challenge, epoch=challenge.epoch, generation=challenge.generation,
                        nonce=challenge.nonce, duration_seconds=duration)


@pytest.mark.asyncio
async def test_first_lease_requires_applied_allocation_and_exact_controller_echo():
    clock = Clock()
    lease = ServingLease(10, clock=clock)
    assert not lease.synchronized and lease.synchronization_lost.is_set()
    with pytest.raises(RuntimeError):
        lease.challenge()
    lease.activate_allocation(7, 12)
    challenge = lease.challenge()
    assert not lease.accept(challenge, epoch=8, generation=12, nonce=challenge.nonce, duration_seconds=5)
    assert not lease.accept(challenge, epoch=7, generation=13, nonce=challenge.nonce, duration_seconds=5)
    assert not lease.accept(challenge, epoch=7, generation=12, nonce="wrong", duration_seconds=5)
    assert grant(lease, challenge)
    assert lease.synchronized and not lease.synchronization_lost.is_set()
    assert not grant(lease, challenge)  # consumed ACK cannot replay
    lease.revoke()


@pytest.mark.asyncio
async def test_delayed_ack_uses_request_start_deadline_and_does_not_revive_expired_lease():
    clock = Clock()
    lease = ServingLease(10, clock=clock)
    lease.activate_allocation(1, 1)
    first = lease.challenge()
    clock.value += 2
    assert grant(lease, first, 5)
    assert lease.deadline == 105
    old_period = lease.synchronization_lost
    renewal = lease.challenge()
    clock.value = 105
    assert not grant(lease, renewal, 10)
    assert not lease.synchronized and old_period.is_set()
    with pytest.raises(RuntimeError):
        lease.challenge()
    # Reverification and a fresh challenge are needed for another serving period.
    lease.activate_allocation(1, 1)
    assert grant(lease, lease.challenge())
    assert old_period.is_set() and not lease.synchronization_lost.is_set()
    lease.revoke()


@pytest.mark.asyncio
async def test_newer_challenges_fence_stale_reordered_replies_and_old_epochs():
    clock = Clock()
    lease = ServingLease(10, clock=clock)
    lease.activate_allocation(1, 10)
    previous = lease.challenge()
    clock.value += 1
    current = lease.challenge()
    assert not grant(lease, previous)
    assert grant(lease, current)
    clock.value += 1
    stale = lease.challenge()
    lease.activate_allocation(2, 11)
    assert not grant(lease, stale)
    assert not grant(lease, replace(stale, epoch=2, generation=11))
    assert grant(lease, lease.challenge())
    lease.revoke()


@pytest.mark.asyncio
async def test_reject_invalid_duration_and_apply_shorter_renewal():
    clock = Clock()
    lease = ServingLease(10, clock=clock)
    lease.activate_allocation(1, 1)
    for duration in (0, -1, float("inf"), float("nan"), 11):
        assert not grant(lease, lease.challenge(), duration)
        assert not lease.synchronized
    assert grant(lease, lease.challenge(), 5)
    clock.value += 1
    # A shorter acknowledgement must conservatively shorten the current grant.
    assert grant(lease, lease.challenge(), 1)
    assert lease.synchronized and lease.deadline == 102
    lease.revoke()


@pytest.mark.asyncio
async def test_watchdog_revokes_idle_lease_and_notifies_inflight_waiters():
    lease = ServingLease(1, clock=time.monotonic)
    lease.activate_allocation(1, 1)
    assert grant(lease, lease.challenge(), 0.2)
    lost = lease.synchronization_lost
    await asyncio.wait_for(lost.wait(), 1)
    assert not lease.synchronized and lease.deadline is None


@pytest.mark.asyncio
async def test_expiry_is_checked_synchronously_even_if_watchdog_is_delayed():
    clock = Clock()
    lease = ServingLease(10, clock=clock)
    lease.activate_allocation(1, 1)
    assert grant(lease, lease.challenge(), 5)
    loss = lease.synchronization_lost
    clock.value = 105
    assert not lease.synchronized
    assert loss.is_set()


@pytest.mark.asyncio
async def test_lease_watchdog_fences_and_cancels_inflight_http():
    import httpx
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from runner.synchronization import RuntimeSynchronizationMiddleware

    lease = ServingLease(1, clock=time.monotonic)
    lease.activate_allocation(2, 4)
    assert grant(lease, lease.challenge(), 0.2)
    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def slow(_request):
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()
        return JSONResponse({"unsafe": True})

    app = Starlette(routes=[Route("/runtime/v1/endpoints/a/verify", slow, methods=["POST"])])
    app.add_middleware(RuntimeSynchronizationMiddleware, control=lease)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://runner") as client:
        request = asyncio.create_task(client.post("/runtime/v1/endpoints/a/verify"))
        await asyncio.wait_for(started.wait(), 1)
        assert (await asyncio.wait_for(request, 1)).status_code == 503
        assert cancelled.is_set()
        assert (await client.post("/runtime/v1/endpoints/a/verify")).status_code == 503


@pytest.mark.asyncio
async def test_lease_watchdog_closes_inflight_websocket():
    from runner.synchronization import RuntimeSynchronizationMiddleware

    lease = ServingLease(1, clock=time.monotonic)
    lease.activate_allocation(2, 4)
    assert grant(lease, lease.challenge(), 0.2)
    sent = []
    started = asyncio.Event()

    async def app(_scope, _receive, send):
        await send({"type": "websocket.accept"})
        started.set()
        await asyncio.Event().wait()

    async def receive():
        return {"type": "websocket.connect"}

    async def send(message):
        sent.append(message)

    scope = {"type": "websocket", "path": "/runtime/v1/endpoints/a/guardrails/output-stream"}
    task = asyncio.create_task(RuntimeSynchronizationMiddleware(app, lease)(scope, receive, send))
    await asyncio.wait_for(started.wait(), 1)
    await asyncio.wait_for(task, 1)
    assert [item["type"] for item in sent] == ["websocket.accept", "websocket.close"]
    assert sent[-1]["code"] == 1013


def test_timer_setup_failure_does_not_leave_a_serving_grant():
    lease = ServingLease(10, clock=time.monotonic)
    lease.activate_allocation(1, 1)
    challenge = lease.challenge()
    with pytest.raises(RuntimeError, match="no running event loop"):
        grant(lease, challenge)
    assert not lease.synchronized and lease.synchronization_lost.is_set()


def test_lease_requires_suspend_aware_clock_when_system_does_not_offer_one(monkeypatch):
    monkeypatch.delattr("runner.serving_lease.time.CLOCK_BOOTTIME", raising=False)
    with pytest.raises(RuntimeError, match="suspend-aware"):
        ServingLease(1)


@pytest.mark.parametrize("epoch,generation", [(-1, 0), (0, -1), (True, 1), (1, False), (1.5, 1), (1, float("nan"))])
def test_allocation_rejects_invalid_epoch_or_generation(epoch, generation):
    lease = ServingLease(1, clock=time.monotonic)
    with pytest.raises(ValueError):
        lease.activate_allocation(epoch, generation)
    assert not lease.synchronized


@pytest.mark.asyncio
async def test_invalid_allocation_update_fences_prior_serving_period():
    lease = ServingLease(1, clock=time.monotonic)
    lease.activate_allocation(1, 1)
    assert grant(lease, lease.challenge(), 0.5)
    previous_loss = lease.synchronization_lost
    with pytest.raises(ValueError):
        lease.activate_allocation(-1, 2)
    assert previous_loss.is_set() and not lease.synchronized


@pytest.mark.asyncio
async def test_overdue_lease_cannot_release_a_response_before_delayed_watchdog():
    import httpx
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from runner.synchronization import RuntimeSynchronizationMiddleware

    clock = Clock()
    lease = ServingLease(10, clock=clock)
    lease.activate_allocation(1, 1)
    assert grant(lease, lease.challenge(), 5)

    async def work(_request):
        # Simulate a clock advance while no watchdog callback has run.
        clock.value = 105
        return JSONResponse({"unsafe": True})

    app = Starlette(routes=[Route("/runtime/v1/endpoints/a/verify", work, methods=["POST"])])
    app.add_middleware(RuntimeSynchronizationMiddleware, control=lease)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://runner") as client:
        response = await client.post("/runtime/v1/endpoints/a/verify")
        assert response.status_code == 503
        assert not lease.synchronized
