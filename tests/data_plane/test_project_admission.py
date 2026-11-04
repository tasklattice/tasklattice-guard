"""Single-process admission behavior; not distributed quota tests."""
import asyncio

import pytest

from runner.project_admission import AdmissionRejected, ProjectAdmission


def admission(**overrides):
    options = dict(capacity=1, project_limits={"a": 1, "b": 1, "c": 1}, max_queued=8, max_queued_per_project=4)
    options.update(overrides)
    return ProjectAdmission(**options)


@pytest.mark.asyncio
async def test_project_caps_keep_a_peak_from_consuming_b_slot():
    limiter = admission(capacity=2, project_limits={"a": 1, "b": 1})
    a = await limiter.acquire("a")
    queued_a = asyncio.create_task(limiter.acquire("a"))
    await asyncio.sleep(0)
    b = await limiter.acquire("b", timeout=0.1)
    assert not queued_a.done()
    await b.release()
    assert not queued_a.done()
    await a.release()
    a2 = await queued_a
    await a2.release()


@pytest.mark.asyncio
async def test_round_robin_across_projects_fifo_within_each():
    limiter = admission()
    first = await limiter.acquire("c")
    order = []

    async def worker(project, name):
        async with limiter.slot(project):
            order.append(name)
            await asyncio.sleep(0)

    tasks = [asyncio.create_task(worker(project, name)) for project, name in
             [("a", "a1"), ("a", "a2"), ("b", "b1"), ("b", "b2")]]
    await asyncio.sleep(0)
    await first.release()
    await asyncio.gather(*tasks)
    assert order == ["a1", "b1", "a2", "b2"]


@pytest.mark.asyncio
async def test_full_queues_are_bounded_and_independent_project_can_use_free_capacity():
    limiter = admission(capacity=2, project_limits={"a": 1, "b": 1}, max_queued=1, max_queued_per_project=1)
    a = await limiter.acquire("a")
    queued_a = asyncio.create_task(limiter.acquire("a"))
    await asyncio.sleep(0)
    with pytest.raises(AdmissionRejected, match="queue_full"):
        await limiter.acquire("a")
    b = await limiter.acquire("b")
    with pytest.raises(AdmissionRejected, match="queue_full"):
        await limiter.acquire("b")
    queued_a.cancel()
    with pytest.raises(asyncio.CancelledError):
        await queued_a
    await a.release()
    await b.release()
    async with limiter.slot("a"):
        pass


@pytest.mark.asyncio
async def test_zero_queue_and_unknown_project_fail_closed():
    limiter = admission(max_queued=0, max_queued_per_project=0)
    permit = await limiter.acquire("a")
    with pytest.raises(AdmissionRejected, match="queue_full"):
        await limiter.acquire("b")
    with pytest.raises(AdmissionRejected, match="unknown_project"):
        await limiter.acquire("unknown")
    await permit.release()


@pytest.mark.asyncio
async def test_timeout_and_waiter_cancellation_do_not_leak_capacity_or_queue():
    limiter = admission(max_queued=1, max_queued_per_project=1)
    held = await limiter.acquire("a")
    with pytest.raises(AdmissionRejected, match="timeout"):
        await limiter.acquire("b", timeout=0.001)
    waiting = asyncio.create_task(limiter.acquire("b"))
    await asyncio.sleep(0)
    waiting.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiting
    waiting2 = asyncio.create_task(limiter.acquire("b"))
    await asyncio.sleep(0)
    await held.release()
    permit = await waiting2
    await permit.release()


@pytest.mark.asyncio
async def test_cancel_after_grant_before_waiter_resumes_releases_permit():
    limiter = admission(max_queued=1)
    first = await limiter.acquire("a")
    waiter = asyncio.create_task(limiter.acquire("b"))
    await asyncio.sleep(0)
    await first.release()
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    async with limiter.slot("c", timeout=0.1):
        pass


@pytest.mark.asyncio
async def test_duplicate_release_does_not_allow_excess_work():
    limiter = admission(max_queued=0)
    first = await limiter.acquire("a")
    await asyncio.gather(first.release(), first.release())
    second = await limiter.acquire("b")
    with pytest.raises(AdmissionRejected, match="queue_full"):
        await limiter.acquire("c")
    await second.release()


@pytest.mark.asyncio
async def test_context_releases_on_cancellation():
    limiter = admission(max_queued=0)
    entered = asyncio.Event()

    async def work():
        async with limiter.slot("a"):
            entered.set()
            await asyncio.Event().wait()

    task = asyncio.create_task(work())
    await entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    async with limiter.slot("b"):
        pass


@pytest.mark.parametrize("options", [
    {"capacity": 0}, {"capacity": True}, {"max_queued": -1},
    {"max_queued_per_project": False}, {"project_limits": {}},
    {"project_limits": {"": 1}}, {"project_limits": {"a": 0}},
    {"project_limits": {"a": True}},
])
def test_invalid_configuration_rejected(options):
    with pytest.raises(ValueError):
        admission(**options)


@pytest.mark.asyncio
@pytest.mark.parametrize("timeout", [-1, float("inf"), float("nan"), True])
async def test_invalid_timeout_rejected(timeout):
    with pytest.raises(ValueError):
        await admission().acquire("a", timeout=timeout)
