import asyncio

import pytest
from prometheus_client import CollectorRegistry, generate_latest

from runner.admission_metrics import TenantAdmissionMetrics
from runner.tenant_admission import AdmissionRejected, AdmissionUnavailable, TenantAdmissionConfiguration


class Owner:
    tenant = "a"

    def authenticated_endpoint_tenant(self, endpoint_id, credential):
        return self.tenant if credential == "valid" else None


def setup(*, rate=None, queue=2):
    registry = CollectorRegistry()
    observer = TenantAdmissionMetrics(registry, 2, {"a": 1, "b": 1})
    configuration = TenantAdmissionConfiguration(2, {"a": 1, "b": 1}, queue, queue, 0.1)
    gate = configuration.build(lambda: True, rate=rate, observer=observer)
    return registry, gate, Owner()


def sample(registry, name, tenant="a", **labels):
    return registry.get_sample_value("guard_runner_tenant_admission_" + name, {"tenant_id": tenant, **labels})


@pytest.mark.asyncio
async def test_measures_real_occupancy_queue_and_cleanup_with_independent_tenant_capacity():
    registry, gate, owner = setup()
    first = await gate.acquire(owner, "endpoint", "valid")
    queued = asyncio.create_task(gate.acquire(owner, "endpoint", "valid"))
    await asyncio.sleep(0)
    assert sample(registry, "active") == 1
    assert sample(registry, "queued") == 1
    owner.tenant = "b"
    independent = await gate.acquire(owner, "endpoint-b", "valid")
    assert sample(registry, "active", tenant="b") == 1
    assert sample(registry, "queued") == 1
    queued.cancel()
    with pytest.raises(asyncio.CancelledError):
        await queued
    assert sample(registry, "queued") == 0
    assert sample(registry, "attempts_total", outcome="cancelled") == 1
    await first.release()
    await first.release()
    await independent.release()
    assert sample(registry, "active") == sample(registry, "active", tenant="b") == 0
    assert sample(registry, "held_seconds_count") == 1
    assert sample(registry, "attempts_total", outcome="admitted") == 1
    assert sample(registry, "wait_seconds_count", outcome="admitted") == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("error,outcome", [(AdmissionRejected("rate_limited"), "rate_limited"), (AdmissionUnavailable("Redis unavailable"), "unavailable")])
async def test_distributed_denial_is_counted_without_holding_a_permit(error, outcome):
    class Rate:
        async def admit(self, tenant):
            raise error
    registry, gate, owner = setup(rate=Rate())
    with pytest.raises(type(error)):
        await gate.acquire(owner, "endpoint", "valid")
    assert sample(registry, "active") == 0
    assert sample(registry, "attempts_total", outcome=outcome) == 1
    assert sample(registry, "attempts_total", outcome="admitted") is None
    assert sample(registry, "held_seconds_count") == 1


@pytest.mark.asyncio
async def test_queue_full_and_timeout_have_distinct_bounded_outcomes():
    registry, gate, owner = setup(queue=1)
    first = await gate.acquire(owner, "endpoint", "valid")
    queued = asyncio.create_task(gate.acquire(owner, "endpoint", "valid"))
    await asyncio.sleep(0)
    with pytest.raises(AdmissionRejected, match="queue_full"):
        await gate.acquire(owner, "endpoint", "valid")
    with pytest.raises(AdmissionRejected, match="timeout"):
        await queued
    assert sample(registry, "attempts_total", outcome="queue_full") == 1
    assert sample(registry, "attempts_total", outcome="queue_timeout") == 1
    assert sample(registry, "queued") == 0
    await first.release()


@pytest.mark.asyncio
async def test_redis_wait_is_occupied_and_changed_owner_does_not_become_an_admission():
    entered, proceed = asyncio.Event(), asyncio.Event()
    class Rate:
        async def admit(self, tenant):
            entered.set()
            await proceed.wait()
    registry, gate, owner = setup(rate=Rate())
    pending = asyncio.create_task(gate.acquire(owner, "endpoint", "valid"))
    await entered.wait()
    assert sample(registry, "active") == 1
    assert sample(registry, "queued") == 0
    owner.tenant = "b"
    proceed.set()
    with pytest.raises(AdmissionUnavailable):
        await pending
    assert sample(registry, "active") == 0
    assert sample(registry, "attempts_total", outcome="unavailable") == 1
    assert sample(registry, "attempts_total", tenant="b", outcome="admitted") is None


@pytest.mark.asyncio
async def test_unknown_or_invalid_owners_cannot_create_metric_labels():
    registry, gate, owner = setup()
    owner.tenant = "client-selected-secret"
    with pytest.raises(AdmissionUnavailable):
        await gate.acquire(owner, "endpoint", "valid")
    owner.tenant = "a"
    with pytest.raises(AdmissionUnavailable):
        await gate.acquire(owner, "endpoint", "invalid")
    assert "client-selected-secret" not in generate_latest(registry).decode()
    assert sample(registry, "attempts_total", outcome="admitted") is None


def test_metric_cardinality_is_bounded_and_uses_configured_caps():
    registry, _, _ = setup()
    assert registry.get_sample_value("guard_runner_tenant_admission_capacity") == 2
    assert sample(registry, "limit") == 1
    with pytest.raises(ValueError, match="1000"):
        TenantAdmissionMetrics(CollectorRegistry(), 2000, {str(index): 1 for index in range(1001)})


@pytest.mark.asyncio
async def test_instrumentation_failure_cannot_strand_a_grant_or_queued_waiter():
    class BrokenObserver:
        def state(self, *args):
            raise RuntimeError("state observer failed")
        def outcome(self, *args):
            raise RuntimeError("outcome observer failed")
        def released(self, *args):
            raise RuntimeError("release observer failed")
    gate = TenantAdmissionConfiguration(1, {"a": 1}, 1, 1, 1).build(lambda: True, observer=BrokenObserver())
    owner = Owner()
    first = await gate.acquire(owner, "endpoint", "valid")
    queued = asyncio.create_task(gate.acquire(owner, "endpoint", "valid"))
    await asyncio.sleep(0)
    await first.release()
    next_permit = await asyncio.wait_for(queued, 0.2)
    await next_permit.release()
    # A third request proves both the immediate and dispatched grants released.
    final = await asyncio.wait_for(gate.acquire(owner, "endpoint", "valid"), 0.2)
    await final.release()
