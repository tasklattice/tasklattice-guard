"""Atomic starts, not simultaneous execution; real Redis uses random pool keys."""
from __future__ import annotations

import asyncio
import json
import os
import uuid

import pytest
import pytest_asyncio
from redis.exceptions import ConnectionError

from runner.distributed_rate_admission import DistributedRateConfiguration, RedisRateAdmission
from runner.tenant_admission import AdmissionRejected, AdmissionUnavailable, EndpointAdmission, TenantAdmission


def policy(**values):
    return DistributedRateConfiguration.from_json(json.dumps({"pool_id": f"test-{uuid.uuid4().hex}",
        "revision": "v1", "window_ms": 10_000, "pool_limit": 17,
        "tenant_limits": {"tenantA": 11, "tenantB": 13}, **values}))


@pytest.mark.parametrize("change", [
    {"pool_id": ""}, {"pool_id": " padded"}, {"revision": ""}, {"revision": "bad\ud800"},
    {"window_ms": True}, {"window_ms": 99}, {"window_ms": 86_400_001},
    {"pool_limit": False}, {"pool_limit": 0}, {"pool_limit": 100_001},
    {"tenant_limits": {}}, {"tenant_limits": {" tenant": 1}}, {"tenant_limits": {"bad\ud800": 1}},
    {"tenant_limits": {"tenantA": 1.2}}, {"unknown": 1},
    {"pool_limit": 100_000, "tenant_limits": {"a": 100_000, "b": 1}},
])
def test_strict_policy_rejects_invalid_or_unknown_fields(change):
    with pytest.raises(ValueError):
        policy(**change)


def test_policy_duplicate_keys_and_non_object_rejected_and_digest_is_canonical():
    with pytest.raises(ValueError, match="duplicate"):
        DistributedRateConfiguration.from_json('{"pool_id":"x","pool_id":"y"}')
    with pytest.raises(ValueError):
        DistributedRateConfiguration.from_json("[]")
    first = policy(pool_id="pool", tenant_limits={"b": 2, "a": 1})
    second = policy(pool_id="pool", tenant_limits={"a": 1, "b": 2})
    assert first.digest == second.digest
    with pytest.raises(TypeError):
        first.tenant_limits["a"] = 3


class UnavailableRedis:
    def __init__(self, response=None, error=None):
        self.response, self.error = response, error
        self.calls = 0

    async def eval(self, *_args):
        self.calls += 1
        if self.error:
            raise self.error
        return self.response


@pytest.mark.asyncio
@pytest.mark.parametrize("response", [None, [], [1], [-1, 0], [0, 0], [2, 0], [True, 0], [1, "bad"], [1, 1]])
async def test_malformed_or_missing_state_fails_closed(response):
    client = UnavailableRedis(response=response)
    admission = RedisRateAdmission(client, policy())
    with pytest.raises(AdmissionUnavailable):
        await admission.admit("tenantA")
    assert client.calls == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("error", [ConnectionError("unavailable"), TimeoutError("response lost")])
async def test_outage_or_ambiguous_response_never_retried(error):
    client = UnavailableRedis(error=error)
    admission = RedisRateAdmission(client, policy())
    with pytest.raises(AdmissionUnavailable):
        await admission.admit("tenantA")
    assert client.calls == 1
    with pytest.raises(AdmissionUnavailable):
        await admission.admit("forged-tenant")
    assert client.calls == 1


@pytest.mark.asyncio
async def test_rate_rejection_carries_rounded_retry_seconds():
    admission = RedisRateAdmission(UnavailableRedis(response=[0, 1501]), policy())
    with pytest.raises(AdmissionRejected) as rejected:
        await admission.admit("tenantA")
    assert rejected.value.reason == "rate_limited" and rejected.value.retry_after == 2


class Owner:
    tenant = "tenantA"

    def authenticated_endpoint_tenant(self, _endpoint, credential):
        return self.tenant if credential == "key" else None


@pytest.mark.asyncio
@pytest.mark.parametrize("invalidate", ["owner", "lease", "credential"])
async def test_after_redis_wait_owner_credential_and_authority_rechecked(invalidate):
    entered, finish = asyncio.Event(), asyncio.Event()
    state = {"authority": True}
    owner = Owner()

    class Rate:
        async def admit(self, tenant):
            assert tenant == "tenantA"
            entered.set()
            await finish.wait()

    local = TenantAdmission(capacity=1, tenant_limits={"tenantA": 1}, max_queued=0, max_queued_per_tenant=0)
    gate = EndpointAdmission(local, timeout_seconds=0, serving_authority=lambda: state["authority"], rate=Rate())
    task = asyncio.create_task(gate.acquire(owner, "endpoint", "key"))
    await entered.wait()
    if invalidate == "lease":
        state["authority"] = False
    else:
        owner.tenant = "other" if invalidate == "owner" else None
    finish.set()
    with pytest.raises(AdmissionUnavailable):
        await task
    assert local._active_total == 0


@pytest.mark.asyncio
async def test_cancellation_during_rate_wait_releases_local_permit():
    entered = asyncio.Event()

    class Rate:
        async def admit(self, tenant):
            entered.set()
            await asyncio.Event().wait()

    local = TenantAdmission(capacity=1, tenant_limits={"tenantA": 1}, max_queued=0, max_queued_per_tenant=0)
    gate = EndpointAdmission(local, timeout_seconds=0, serving_authority=lambda: True, rate=Rate())
    task = asyncio.create_task(gate.acquire(Owner(), "endpoint", "key"))
    await entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert local._active_total == 0


@pytest_asyncio.fixture
async def real_rate():
    url = os.environ.get("GUARD_TEST_REDIS_URL")
    if not url:
        pytest.skip("Set GUARD_TEST_REDIS_URL to isolated loopback Redis")
    instances = []

    async def create(**values):
        configuration = policy(**values)
        pair = [RedisRateAdmission.connect(url, configuration) for _ in range(2)]
        instances.extend(pair)
        await pair[0].provision()
        return pair

    try:
        yield create
    finally:
        # Delete only this test's randomly named pool keys; never FLUSHDB.
        for admission in instances[::2]:
            await admission._redis.delete(*admission.state_keys)
        for admission in instances:
            await admission.aclose()


@pytest.mark.asyncio
async def test_real_two_clients_atomically_enforce_tenant_and_pool_starts(real_rate):
    pair = await real_rate()
    tenants = ["tenantA", "tenantB"] * 40

    async def attempt(index, tenant):
        try:
            await pair[index % 2].admit(tenant)
            return tenant
        except AdmissionRejected:
            return None

    accepted = await asyncio.gather(*(attempt(i, tenant) for i, tenant in enumerate(tenants)))
    assert sum(value is not None for value in accepted) == 17
    assert accepted.count("tenantA") <= 11 and accepted.count("tenantB") <= 13
    assert await pair[0]._redis.zcard(pair[0].state_keys[1]) == 18  # starts + sentinel
    assert all(value == -1 for value in await asyncio.gather(*(pair[0]._redis.pttl(key) for key in pair[0].state_keys)))


@pytest.mark.asyncio
async def test_real_tenant_denial_does_not_spend_pool_budget(real_rate):
    first, second = await real_rate(pool_limit=2, tenant_limits={"tenantA": 1, "tenantB": 2})
    await first.admit("tenantA")
    with pytest.raises(AdmissionRejected):
        await second.admit("tenantA")
    await second.admit("tenantB")
    with pytest.raises(AdmissionRejected):
        await first.admit("tenantB")


@pytest.mark.asyncio
async def test_real_window_progresses_but_does_not_limit_simultaneous_execution(real_rate):
    first, second = await real_rate(window_ms=100, pool_limit=1, tenant_limits={"tenantA": 1})
    local = TenantAdmission(capacity=2, tenant_limits={"tenantA": 2}, max_queued=0, max_queued_per_tenant=0)
    gate = EndpointAdmission(local, timeout_seconds=0, serving_authority=lambda: True, rate=first)
    permit = await gate.acquire(Owner(), "endpoint", "key")
    with pytest.raises(AdmissionRejected):
        await second.admit("tenantA")
    await asyncio.sleep(0.15)
    other = await gate.acquire(Owner(), "endpoint", "key")
    assert local._active_total == 2  # first execution can outlive its rate window
    await other.release()
    await permit.release()


@pytest.mark.asyncio
@pytest.mark.parametrize("corrupt", ["delete", "sentinel", "negative", "ttl", "type", "digest", "clock", "clock_type"])
async def test_real_state_loss_mismatch_expiry_or_backward_clock_fails_closed(real_rate, corrupt):
    first, second = await real_rate()
    await first.admit("tenantA")
    client, tenant = first._redis, first._tenant_key("tenantA")
    if corrupt == "delete":
        await client.delete(tenant)
    elif corrupt == "sentinel":
        await client.zrem(tenant, "!initialized")
    elif corrupt == "negative":
        await client.zadd(tenant, {"malformed-negative-history": -2})
    elif corrupt == "ttl":
        await client.pexpire(tenant, 30_000)
    elif corrupt == "type":
        await client.delete(tenant)
        await client.set(tenant, "bad")
    elif corrupt == "digest":
        await client.hset(first.state_keys[0], "digest", "different-policy")
    elif corrupt == "clock_type":
        await client.hset(first.state_keys[0], "last_ms", "invalid")
    else:
        await client.hset(first.state_keys[0], "last_ms", "9999999999999")
    with pytest.raises(AdmissionUnavailable):
        await second.admit("tenantA")
    with pytest.raises(AdmissionUnavailable, match="already exists"):
        await second.provision()


@pytest.mark.asyncio
async def test_real_missing_initial_policy_and_revision_change_never_auto_initialize(real_rate):
    first, _second = await real_rate()
    changed = policy(pool_id=first.configuration.pool_id, revision="v2")
    mismatched = RedisRateAdmission(first._redis, changed)
    with pytest.raises(AdmissionUnavailable):
        await mismatched.admit("tenantA")
    missing = RedisRateAdmission(first._redis, policy())
    with pytest.raises(AdmissionUnavailable):
        await missing.admit("tenantA")
    assert await first._redis.exists(*missing.state_keys) == 0


@pytest.mark.asyncio
async def test_real_cancellation_after_charge_never_refunds_start(real_rate):
    first, second = await real_rate(pool_limit=1, tenant_limits={"tenantA": 1})
    charged = asyncio.Event()

    class Rate:
        async def admit(self, tenant):
            await first.admit(tenant)
            charged.set()
            await asyncio.Event().wait()

    local = TenantAdmission(capacity=1, tenant_limits={"tenantA": 1}, max_queued=0, max_queued_per_tenant=0)
    gate = EndpointAdmission(local, timeout_seconds=0, serving_authority=lambda: True, rate=Rate())
    task = asyncio.create_task(gate.acquire(Owner(), "endpoint", "key"))
    await charged.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert local._active_total == 0
    with pytest.raises(AdmissionRejected):
        await second.admit("tenantA")


@pytest.mark.asyncio
async def test_real_response_loss_keeps_charge_and_never_authorizes_execution(real_rate):
    first, second = await real_rate(pool_limit=1, tenant_limits={"tenantA": 1})

    class LoseResponse:
        calls = 0

        async def eval(self, *args):
            self.calls += 1
            await first._redis.eval(*args)
            raise TimeoutError("reply lost after successful Redis write")

    transport = LoseResponse()
    gate = EndpointAdmission(TenantAdmission(capacity=1, tenant_limits={"tenantA": 1},
        max_queued=0, max_queued_per_tenant=0), timeout_seconds=0, serving_authority=lambda: True,
        rate=RedisRateAdmission(transport, first.configuration))
    with pytest.raises(AdmissionUnavailable):
        await gate.acquire(Owner(), "endpoint", "key")
    assert transport.calls == 1 and gate._admission._active_total == 0
    with pytest.raises(AdmissionRejected):
        await second.admit("tenantA")


@pytest.mark.asyncio
async def test_real_two_runner_apis_share_start_budget_and_ignore_forged_tenant(real_rate):
    import httpx
    from tests.data_plane.test_endpoint_tenant_admission import app_for, request

    first, second = await real_rate(pool_limit=2, tenant_limits={"tenantA": 1, "tenantB": 2})
    app1, runtime1, _, _, _ = app_for(rate=first)
    app2, runtime2, _, _, _ = app_for(rate=second)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app1), base_url="http://one") as one, \
               httpx.AsyncClient(transport=httpx.ASGITransport(app=app2), base_url="http://two") as two:
        assert (await request(one)).status_code == 200
        denied = await request(two, **{"x-tenant-id": "tenantB"})
        assert denied.status_code == 429 and int(denied.headers["retry-after"]) >= 1
        assert (await request(two, "b")).status_code == 200
        assert runtime1.calls == ["a"] and runtime2.calls == ["b"]
