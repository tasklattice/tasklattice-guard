"""Group v2 starts across pools; no distributed execution/concurrency claim."""
from __future__ import annotations

import asyncio
import json
import os
import uuid
from dataclasses import replace
from types import SimpleNamespace

import httpx
import pytest
import pytest_asyncio
from redis.exceptions import ConnectionError

from runner import generated as protocol
from runner.artifact_store import ArtifactStore, AuthenticatedEndpointAllocation
from runner.control_client import RunnerControlClient
from runner.group_rate_admission import GroupRateConfiguration, RedisGroupRateAdmission
from runner.tenant_admission import AdmissionRejected, AdmissionUnavailable, EndpointAdmission, TenantAdmission
from tests.data_plane.test_distributed_rate_admission import UnavailableRedis
from tests.data_plane.test_endpoint_tenant_admission import app_for, request
from tests.test_runner_artifact_store import FIXTURE, Registry
from tests.test_runner_control_client import Metrics, Store, _settings


def policy(**changes):
    return GroupRateConfiguration.from_json(json.dumps({"group_id": f"test-group-{uuid.uuid4().hex}", "revision": "v2",
        "window_ms": 10_000, "group_limit": 17, "tenant_limits": {"tenantA": 11, "tenantB": 13},
        "pool_limits": {"pool-a": 10, "pool-b": 12}, "pool_epochs": {"pool-a": 0, "pool-b": 0}, **changes}))


@pytest.mark.parametrize("changes", [{"group_id": ""}, {"revision": " padded"}, {"group_id": "bad\ud800"},
    {"group_limit": True}, {"group_limit": 100001}, {"window_ms": 99}, {"pool_limits": {}},
    {"pool_limits": {" padded": 2}}, {"pool_epochs": {"pool-a": 0}}, {"pool_epochs": {"pool-a": True, "pool-b": 0}},
    {"pool_epochs": {"pool-a": -1, "pool-b": 0}}, {"pool_epochs": {"pool-a": 9007199254740992, "pool-b": 0}},
    {"tenant_limits": {}}, {"tenant_limits": {"bad\ud800": 1}}, {"unknown": 1},
    {"group_limit": 100000, "tenant_limits": {"a": 100000, "b": 1}},
    {"group_limit": 100000, "pool_limits": {"pool-a": 100000, "pool-b": 1}}])
def test_group_policy_rejects_ambiguous_unknown_or_unbounded_values(changes):
    with pytest.raises(ValueError):
        policy(**changes)


def test_group_policy_canonical_digest_immutable_maps_and_runner_scope():
    configured = policy(group_id="group")
    assert configured.digest == policy(group_id="group", pool_limits={"pool-b": 12, "pool-a": 10},
        pool_epochs={"pool-b": 0, "pool-a": 0}).digest
    with pytest.raises(ValueError, match="duplicate"):
        GroupRateConfiguration.from_json('{"group_id":"a","group_id":"b"}')
    with pytest.raises(TypeError):
        configured.pool_epochs["pool-a"] = 2
    configured.validate_runner("pool-a", {"tenantA": 1})
    with pytest.raises(ValueError):
        configured.validate_runner("unknown", {"tenantA": 1})
    with pytest.raises(ValueError):
        configured.validate_runner("pool-a", {"unknown": 1})


def test_group_mode_settings_are_explicit_scoped_and_mutually_exclusive(monkeypatch):
    from runner.config import RunnerSettings
    from tests.test_runner_model_config import _required_runner_env
    _required_runner_env(monkeypatch)
    monkeypatch.delenv("GUARD_RUNNER_GROUP_RATE_ENABLED", raising=False)
    monkeypatch.delenv("GUARD_RUNNER_GROUP_RATE_JSON", raising=False)
    monkeypatch.setenv("GUARD_RUNNER_DISTRIBUTED_RATE_ENABLED", "false")
    monkeypatch.delenv("GUARD_RUNNER_DISTRIBUTED_RATE_JSON", raising=False)
    assert RunnerSettings.from_env().group_rate_admission is None
    configured = policy(pool_limits={"default": 3}, pool_epochs={"default": 0})
    monkeypatch.setenv("GUARD_RUNNER_GROUP_RATE_JSON", configured.canonical_json)
    with pytest.raises(ValueError, match="requires GUARD_RUNNER_GROUP_RATE_ENABLED"):
        RunnerSettings.from_env()
    monkeypatch.setenv("GUARD_RUNNER_GROUP_RATE_ENABLED", "true")
    with pytest.raises(ValueError, match="requires strict group JSON"):
        RunnerSettings.from_env()
    monkeypatch.setenv("GUARD_RUNNER_CONTROL_TOKEN", "pool-control-token-with-at-least-32-characters")
    monkeypatch.setenv("GUARD_RUNNER_CALL_CONTEXT_REDIS_URL", "redis://127.0.0.1:6379/0")
    monkeypatch.setenv("GUARD_RUNNER_TENANT_ADMISSION_ENABLED", "true")
    monkeypatch.setenv("GUARD_RUNNER_TENANT_ADMISSION_JSON", json.dumps({"capacity": 2, "tenant_limits": {"tenantA": 1},
        "max_queued": 1, "max_queued_per_tenant": 1, "queue_timeout_seconds": 0.1}))
    assert RunnerSettings.from_env().group_rate_admission.group_id == configured.group_id
    monkeypatch.setenv("GUARD_RUNNER_GROUP_RATE_JSON", policy().canonical_json)
    with pytest.raises(ValueError, match="include the trusted Runner pool"):
        RunnerSettings.from_env()
    monkeypatch.setenv("GUARD_RUNNER_GROUP_RATE_JSON", configured.canonical_json)
    monkeypatch.setenv("GUARD_RUNNER_DISTRIBUTED_RATE_ENABLED", "true")
    monkeypatch.setenv("GUARD_RUNNER_DISTRIBUTED_RATE_JSON", json.dumps({"pool_id": "default", "revision": "v1", "window_ms": 1000,
        "pool_limit": 3, "tenant_limits": {"tenantA": 2}}))
    with pytest.raises(ValueError, match="v1 distributed rate disabled"):
        RunnerSettings.from_env()


class Owner:
    def __init__(self, group="group", epoch=0):
        self.allocation = AuthenticatedEndpointAllocation("tenantA", group, epoch, 1)
        self.authenticated = True

    def authenticated_endpoint_tenant(self, _endpoint, credential):
        return self.allocation.tenant_id if self.authenticated and credential == "key" else None

    def authenticated_endpoint_allocation(self, endpoint, credential):
        return self.allocation if self.authenticated_endpoint_tenant(endpoint, credential) else None


def gate_for(rate, *, queued=0):
    local = TenantAdmission(capacity=1, tenant_limits={"tenantA": 1}, max_queued=queued, max_queued_per_tenant=queued)
    authority = {"current": True}
    gate = EndpointAdmission(local, timeout_seconds=1, serving_authority=lambda: authority["current"], group_rate=rate)
    return gate, local, authority


@pytest.mark.asyncio
@pytest.mark.parametrize("change", [{"group": "foreign"}, {"epoch": 1}])
async def test_controller_group_epoch_mismatch_never_reaches_redis(change):
    redis = UnavailableRedis(response=[1, 0])
    rate = RedisGroupRateAdmission(redis, policy(group_id="group"), "pool-a")
    gate, local, _ = gate_for(rate)
    with pytest.raises(AdmissionUnavailable):
        await gate.acquire(Owner(**change), "endpoint", "key")
    assert redis.calls == 0 and local._active_total == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["group", "epoch", "generation", "owner", "credential", "authority"])
async def test_post_redis_wait_rechecks_exact_authenticated_controller_allocation(change):
    entered, finish = asyncio.Event(), asyncio.Event()

    class Rate:
        def validate_allocation(self, tenant, group_id, epoch):
            assert (tenant, group_id, epoch) == ("tenantA", "group", 0)

        async def admit(self, tenant, *, group_id, epoch):
            self.validate_allocation(tenant, group_id, epoch)
            entered.set()
            await finish.wait()

    gate, local, authority = gate_for(Rate())
    owner = Owner()
    task = asyncio.create_task(gate.acquire(owner, "endpoint", "key"))
    await entered.wait()
    if change == "authority": authority["current"] = False
    elif change == "credential": owner.authenticated = False
    else: owner.allocation = replace(owner.allocation, **{"group_id" if change == "group" else "tenant_id" if change == "owner" else change:
        "foreign" if change in {"group", "owner"} else 1 if change == "epoch" else 2})
    finish.set()
    with pytest.raises(AdmissionUnavailable):
        await task
    assert local._active_total == 0


@pytest.mark.asyncio
async def test_missing_allocation_and_redis_outage_fail_closed():
    rate = RedisGroupRateAdmission(UnavailableRedis(error=ConnectionError("outage")), policy(group_id="group"), "pool-a")
    gate, local, _ = gate_for(rate)
    owner = Owner()
    with pytest.raises(AdmissionUnavailable):
        await gate.acquire(owner, "endpoint", "key")
    owner.authenticated_endpoint_allocation = lambda *_args: None
    with pytest.raises(AdmissionUnavailable):
        await gate.acquire(owner, "endpoint", "key")
    assert local._active_total == 0


def test_store_persists_controller_group_epoch_atomically_and_failed_snapshot_retains_old(tmp_path):
    store = ArtifactStore(FIXTURE / "public-key.pem", tmp_path)
    store.attach_registry(Registry())
    from runner.protocol_codec import endpoint_verification_to_proto
    import hashlib
    verification = endpoint_verification_to_proto({"credentials": [{"id": "key", "sha256": hashlib.sha256(b"key").hexdigest(), "createdAt": "2026-01-01T00:00:00Z"}]})
    state = protocol.DesiredState(generation=1, allocation_group_id="group", allocation_epoch=7,
        endpoints=[protocol.EndpointRuntime(endpoint_id="endpoint", tenant_id="tenantA", verification=verification)])
    store.apply(state)
    expected = AuthenticatedEndpointAllocation("tenantA", "group", 7, 1)
    assert store.authenticated_endpoint_allocation("endpoint", "key") == expected
    assert store.authenticated_endpoint_allocation("endpoint", "wrong") is None
    restarted = ArtifactStore(FIXTURE / "public-key.pem", tmp_path)
    restarted.attach_registry(Registry())
    assert restarted.authenticated_endpoint_allocation("endpoint", "key") == expected
    state.generation = 2
    state.allocation_group_id = " padded"
    with pytest.raises(ValueError): store.apply(state)
    assert store.authenticated_endpoint_allocation("endpoint", "key") == expected
    state.ClearField("allocation_group_id")
    store.apply(state)
    assert store.authenticated_endpoint_allocation("endpoint", "key") is None


@pytest.mark.asyncio
async def test_group_mode_rejects_allocation_change_and_missing_fields_without_reopening_old_state():
    configured = policy(group_id="group", pool_limits={"default": 2}, pool_epochs={"default": 7})
    settings = SimpleNamespace(**vars(_settings()), group_rate_admission=configured)
    client = RunnerControlClient(settings, Store(), Metrics())
    valid = protocol.DesiredState(generation=1, snapshot_nonce="snapshot", allocation_group_id="group", allocation_epoch=7)
    await client._apply_desired_state(valid)
    assert client.synchronized
    period = client.synchronization_lost
    invalid = protocol.DesiredState(generation=2, snapshot_nonce="changed", allocation_group_id="foreign", allocation_epoch=7)
    await client._apply_desired_state(invalid)
    assert not client.synchronized and period.is_set() and client._store.generation == 1
    valid.generation = 3
    valid.ClearField("allocation_group_id")
    await client._apply_desired_state(valid)
    assert not client.synchronized


@pytest.mark.asyncio
@pytest.mark.parametrize("lease", [False, True])
async def test_snapshot_refresh_preserves_session_telemetry_authorization(lease, monkeypatch):
    configured = policy(group_id="group", pool_limits={"default": 2}, pool_epochs={"default": 7})
    from unittest.mock import Mock
    from runner.serving_lease import ServingLease
    monkeypatch.setattr("runner.control_client.ServingLease", lambda duration: ServingLease(duration, clock=lambda: 100.0))
    exporter = SimpleNamespace(clear_progress_authorization=Mock(), progress_wal_id=None)
    settings = SimpleNamespace(**vars(_settings()), group_rate_admission=configured,
        experimental_lease_enforcement=lease, control_token="pool-token")
    client = RunnerControlClient(settings, Store(), Metrics(), telemetry=exporter)
    await client._apply_desired_state(protocol.DesiredState(generation=1, snapshot_nonce="snapshot",
        allocation_group_id="group", allocation_epoch=7))
    exporter.clear_progress_authorization.assert_not_called()
    client._revoke_synchronization()
    exporter.clear_progress_authorization.assert_called_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("response", [None, [0, 0], [1, "bad"], [True, 0], [-1, 0]])
async def test_group_redis_malformed_or_unavailable_state_cannot_authorize(response):
    rate = RedisGroupRateAdmission(UnavailableRedis(response=response), policy(group_id="group"), "pool-a")
    with pytest.raises(AdmissionUnavailable):
        await rate.admit("tenantA", group_id="group", epoch=0)


@pytest_asyncio.fixture
async def real_groups():
    url = os.environ.get("GUARD_TEST_REDIS_URL")
    if not url: pytest.skip("Set GUARD_TEST_REDIS_URL to isolated loopback Redis")
    groups = []

    async def create(**changes):
        configuration = policy(**changes)
        clients = [RedisGroupRateAdmission.connect(url, configuration, pool) for pool in configuration.pool_limits]
        groups.append(clients)
        await clients[0].provision()
        return clients

    try:
        yield create
    finally:
        for clients in groups:
            await clients[0]._redis.delete(*clients[0].state_keys)
            for client in clients: await client.aclose()


async def admit(client, tenant="tenantA"):
    await client.admit(tenant, group_id=client.configuration.group_id, epoch=client.configuration.pool_epochs[client.pool_id])


@pytest.mark.asyncio
async def test_real_two_pools_share_atomic_group_tenant_and_pool_caps(real_groups):
    clients = await real_groups()

    async def attempt(index):
        client, tenant = clients[index % 2], ("tenantA" if index % 4 < 2 else "tenantB")
        try:
            await admit(client, tenant)
            return (client.pool_id, tenant)
        except AdmissionRejected: return None

    accepted = [value for value in await asyncio.gather(*(attempt(index) for index in range(80))) if value]
    assert len(accepted) == 17
    assert sum(tenant == "tenantA" for _, tenant in accepted) <= 11
    assert sum(tenant == "tenantB" for _, tenant in accepted) <= 13
    assert sum(pool == "pool-a" for pool, _ in accepted) <= 10
    assert sum(pool == "pool-b" for pool, _ in accepted) <= 12


@pytest.mark.asyncio
async def test_real_tenant_limit_spans_pools_and_an_independent_group_is_unaffected(real_groups):
    first, second = await real_groups(group_limit=3, tenant_limits={"tenantA": 1, "tenantB": 3})
    independent = (await real_groups(group_limit=1))[0]
    await admit(first)
    with pytest.raises(AdmissionRejected): await admit(second)
    await admit(second, "tenantB")
    await admit(first, "tenantB")
    with pytest.raises(AdmissionRejected): await admit(second, "tenantB")
    await admit(independent)


@pytest.mark.asyncio
async def test_real_pool_denial_does_not_spend_group_or_other_tenant_budget(real_groups):
    first, second = await real_groups(group_limit=4, tenant_limits={"tenantA": 4, "tenantB": 4}, pool_limits={"pool-a": 1, "pool-b": 3})
    await admit(first)
    with pytest.raises(AdmissionRejected): await admit(first, "tenantB")
    for _ in range(3): await admit(second, "tenantB")
    with pytest.raises(AdmissionRejected): await admit(second)


@pytest.mark.asyncio
@pytest.mark.parametrize("key", ["policy", "group", "tenant", "pool"])
async def test_real_missing_provisioned_state_is_never_refilled(real_groups, key):
    first, second = await real_groups()
    target = {"policy": first._policy_key, "group": first._group_key, "tenant": first._tenant_key("tenantA"), "pool": second._pool_key("pool-b")}[key]
    await first._redis.delete(target)
    with pytest.raises(AdmissionUnavailable): await admit(second)
    with pytest.raises(AdmissionUnavailable): await second.provision()


@pytest.mark.asyncio
async def test_real_mismatched_policy_fails_and_headers_cannot_choose_another_group(real_groups):
    first, second = await real_groups(group_limit=1)
    changed = policy(group_id=first.configuration.group_id, revision="changed")
    mismatch = RedisGroupRateAdmission(first._redis, changed, "pool-a")
    with pytest.raises(AdmissionUnavailable): await admit(mismatch)
    app, runtime, snapshot, local, _ = app_for(group_rate=first)
    snapshot._allocation_group_id, snapshot._allocation_epoch, snapshot._generation = first.configuration.group_id, 0, 1
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
        assert (await request(client)).status_code == 200
        denied = await request(client, **{"x-group-id": "other-group", "x-tenant-group": "other-group", "x-tenant-id": "tenantB"})
        assert denied.status_code == 429
    assert runtime.calls == ["a"] and local._active_total == 0
    with pytest.raises(AdmissionRejected): await admit(second)


@pytest.mark.asyncio
async def test_real_cancellation_after_group_charge_releases_only_local_permit(real_groups):
    first, second = await real_groups(group_limit=1)
    charged = asyncio.Event()

    class Delayed:
        def validate_allocation(self, *args): first.validate_allocation(*args)
        async def admit(self, tenant, *, group_id, epoch):
            await first.admit(tenant, group_id=group_id, epoch=epoch)
            charged.set()
            await asyncio.Event().wait()

    gate, local, _ = gate_for(Delayed())
    task = asyncio.create_task(gate.acquire(Owner(first.configuration.group_id), "endpoint", "key"))
    await charged.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError): await task
    assert local._active_total == 0
    with pytest.raises(AdmissionRejected): await admit(second)


@pytest.mark.asyncio
async def test_real_lost_response_conservatively_consumes_group_start_without_retry(real_groups):
    first, second = await real_groups(group_limit=1)

    class LostReply:
        calls = 0
        async def eval(self, *args):
            self.calls += 1
            await first._redis.eval(*args)
            raise TimeoutError("reply lost after commit")

    transport = LostReply()
    wrapped = RedisGroupRateAdmission(transport, first.configuration, "pool-a")
    gate, local, _ = gate_for(wrapped)
    with pytest.raises(AdmissionUnavailable):
        await gate.acquire(Owner(first.configuration.group_id), "endpoint", "key")
    assert transport.calls == 1 and local._active_total == 0
    with pytest.raises(AdmissionRejected): await admit(second)


@pytest.mark.asyncio
async def test_real_group_rate_window_is_not_a_simultaneous_work_limit(real_groups):
    first, second = await real_groups(window_ms=100, group_limit=1)
    gate, local, _ = gate_for(first)
    permit = await gate.acquire(Owner(first.configuration.group_id), "endpoint", "key")
    try:
        with pytest.raises(AdmissionRejected): await admit(second)
        await asyncio.sleep(0.15)
        await admit(second)
        assert local._active_total == 1  # first execution has not released its local slot
    finally:
        await permit.release()
