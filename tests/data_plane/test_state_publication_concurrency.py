"""Health, publication, and lease invariants while construction or disk I/O stalls."""
from __future__ import annotations

import asyncio
import importlib
import threading
import time
from functools import partial
from pathlib import Path
from unittest.mock import Mock

import httpx
import pytest
from prometheus_client import Gauge

from runner.config import RunnerSettings
from runner.preparation import prepare
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.actions import local_action_providers
from runner.toolkit.runtime.contracts import RequestContext
from tests.data_plane.test_artifact_execution import _desired_state


@pytest.fixture
async def serving(monkeypatch, tmp_path):
    monkeypatch.setenv("GUARD_CONTROLLER_TOKEN", "test-token-000000000000000000000000")
    monkeypatch.setenv("GUARD_ARTIFACT_PUBLIC_KEY_PATH", str(Path(__file__).parents[1] / "fixtures/artifacts/local-secrets-v1/public-key.pem"))
    monkeypatch.setenv("GUARD_RUNNER_STATE_PATH", str(tmp_path))
    monkeypatch.setenv("GUARD_RUNNER_COMPILER_CAPABLE", "false")
    module = importlib.import_module("runner.main")
    app = module.create_app(RunnerSettings.from_env())
    # The dependency's in-progress gauge otherwise uses its process-global registry.
    monkeypatch.setattr("prometheus_fastapi_instrumentator.middleware.Gauge",
                        partial(Gauge, registry=app.state.runner_metrics.registry))
    store = app.state.artifact_store
    registry = store._registry
    await prepare(store.apply, _desired_state())
    app.state.runner_control._synchronized.set()
    try:
        yield app, store, registry
    finally:
        await registry.shutdown()


@pytest.mark.parametrize("stage", ["prewarm", "persist"])
async def test_slow_publication_keeps_health_heartbeat_and_old_requests_responsive(serving, monkeypatch, stage):
    app, store, registry = serving
    old = store.resolve(RequestContext(protocol="litellm", endpoint_id="fixture-endpoint"))
    instance = registry.acquire(old.plan, release_id=old.effective_release_id)[0]
    entered, release = threading.Event(), threading.Event()
    owner, method = (registry, "_build_with_logging") if stage == "prewarm" else (store, "_persist_snapshot")
    original = getattr(owner, method)

    def blocked(*args):
        entered.set()
        assert release.wait(5), "Serving work waited on the preparation lock"
        return original(*args)

    monkeypatch.setattr(owner, method, blocked)
    state = _desired_state()
    state.generation += 1
    update = asyncio.create_task(prepare(store.apply, state, providers=action_providers(*local_action_providers())))
    try:
        assert await asyncio.to_thread(entered.wait, 3)
        started = time.perf_counter()
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
            assert (await client.get("/health/live")).status_code == 200
            assert (await client.get("/health/ready")).status_code == 200
            app.state.runner_metrics.heartbeat()
            assert registry.acquire(old.plan, release_id=old.effective_release_id)[0] is instance
            assert store.generation == 1
            response = await client.post(
                "/runtime/v1/endpoints/fixture-endpoint/beta/litellm_basic_guardrail_api",
                headers={"x-api-key": "fixture-runtime-secret"},
                json={"input_type": "request", "texts": ["hello"], "request_data": {}},
            )
            assert response.status_code == 200, response.text
            assert response.json()["action"] == "NONE"
        assert time.perf_counter() - started < .5
    finally:
        release.set()
        await update
    current = store.resolve(RequestContext(protocol="litellm", endpoint_id="fixture-endpoint"))
    assert current.effective_release_id != old.effective_release_id
    assert registry.acquire(current.plan, release_id=current.effective_release_id)[0] is not instance
    await registry.collect_retired()
    assert registry.acquire(old.plan, release_id=old.effective_release_id)[0] is instance


async def test_route_only_update_reuses_instances_and_signature_verification(serving, monkeypatch):
    _, store, registry = serving
    old = registry.get(store.plan(*store.active_plan_keys()[0]))
    build = Mock(wraps=registry._build_with_logging)
    verify = Mock(wraps=store._artifact_from_message)
    monkeypatch.setattr(registry, "_build_with_logging", build)
    monkeypatch.setattr(store, "_artifact_from_message", verify)
    state = _desired_state()
    state.generation += 1
    await prepare(store.apply, state)
    assert registry.get(old.plan) is old
    assert store.generation == 2
    build.assert_not_called()
    verify.assert_not_called()


@pytest.mark.parametrize("stage", ["prewarm", "persist"])
async def test_failed_update_keeps_runtime_routes_and_snapshot(serving, monkeypatch, stage):
    _, store, registry = serving
    old = store.resolve(RequestContext(protocol="litellm", endpoint_id="fixture-endpoint"))
    old_instance = registry.get(old.plan)
    snapshot = (store._state_path / "last-known-good.json").read_bytes()
    owner, method = (registry, "_build_with_logging") if stage == "prewarm" else (store, "_persist_snapshot")
    monkeypatch.setattr(owner, method, Mock(side_effect=RuntimeError("injected failure")))
    state = _desired_state()
    state.generation += 1
    with pytest.raises(RuntimeError, match="injected failure"):
        await prepare(store.apply, state, providers=action_providers(*local_action_providers()))
    current = store.resolve(RequestContext(protocol="litellm", endpoint_id="fixture-endpoint"))
    assert current.plan == old.plan and current.effective_release_id == old.effective_release_id
    assert current.router_id == old.router_id and current.model_revision_id == old.model_revision_id
    assert registry.get(old.plan) is old_instance
    assert store.generation == 1 and registry.readiness()["ready"]
    assert (store._state_path / "last-known-good.json").read_bytes() == snapshot
    await registry.collect_retired()
    assert registry.get(old.plan) is old_instance


async def test_unrouted_artifact_is_loaded_once_on_demand_off_the_loop(serving, monkeypatch):
    _, store, registry = serving
    state = _desired_state()
    state.generation += 1
    state.ClearField("routers")
    state.ClearField("router_revisions")
    # A changed provider set forces a new runtime if this version is ever used.
    await prepare(store.apply, state, providers=action_providers(*local_action_providers()))
    assert registry.stats()["entries"] == 0
    assert registry.readiness()["active_versions"] == 0
    main_thread = threading.get_ident()
    original = registry._build_with_logging
    threads = []

    def build(*args):
        threads.append(threading.get_ident())
        return original(*args)

    monkeypatch.setattr(registry, "_build_with_logging", build)
    candidate = state.artifacts[0]
    resolution = store.resolve_guardrail(candidate.guardrail_id, candidate.guardrail_version)
    first, second = await asyncio.gather(*(
        registry.acquire_async(resolution.plan, release_id=resolution.effective_release_id) for _ in range(2)
    ))
    assert first[0] is second[0]
    assert len(threads) == 1 and threads[0] != main_thread
    assert registry.stats()["entries"] == 1


async def test_old_runtime_is_retired_only_after_leases_and_requests_drain(serving, monkeypatch):
    from unittest.mock import AsyncMock

    _, store, registry = serving
    old = store.resolve(RequestContext(protocol="litellm", endpoint_id="fixture-endpoint"))
    instance = registry.acquire(old.plan, release_id=old.effective_release_id)[0]
    close = AsyncMock(wraps=instance.rails.shutdown)
    monkeypatch.setattr(instance.rails, "shutdown", close)
    state = _desired_state()
    state.generation += 1
    await prepare(store.apply, state, providers=action_providers(*local_action_providers()))
    await registry.collect_retired()
    close.assert_not_called()
    entry = registry._releases[old.effective_release_id]
    entry.expires_at = 0
    entry.used_until.clear()
    instance.active_requests = 1
    await registry.collect_retired()
    close.assert_not_called()
    instance.active_requests = 0
    await registry.collect_retired()
    close.assert_awaited_once()
    assert registry.get(old.plan) is not instance


async def test_late_on_demand_load_in_old_release_is_closed_on_expiration(serving, monkeypatch):
    from unittest.mock import AsyncMock

    _, store, registry = serving
    state = _desired_state()
    state.generation = 2
    state.ClearField("routers")
    state.ClearField("router_revisions")
    await prepare(store.apply, state, providers=action_providers(*local_action_providers()))
    artifact = state.artifacts[0]
    old = store.resolve_guardrail(artifact.guardrail_id, artifact.guardrail_version)
    state.generation = 3
    await prepare(store.apply, state, providers=action_providers(*local_action_providers()))
    instance = (await registry.acquire_async(old.plan, release_id=old.effective_release_id))[0]
    close = AsyncMock(wraps=instance.rails.shutdown)
    monkeypatch.setattr(instance.rails, "shutdown", close)
    entry = registry._releases[old.effective_release_id]
    entry.expires_at = 0
    entry.used_until.clear()
    await registry.collect_retired()
    close.assert_awaited_once()


async def test_partial_prewarm_failure_closes_only_new_instances(serving, monkeypatch):
    from dataclasses import replace
    from unittest.mock import AsyncMock

    _, store, registry = serving
    plan = store.plan(*store.active_plan_keys()[0])
    config = store.nemo_config(plan.guardrail_id, plan.guardrail_version)
    current = registry.get(plan)
    candidates = tuple((replace(plan, guardrail_version=version), replace(config, guardrail_version=version))
                       for version in ("candidate-a", "candidate-b"))
    active = frozenset((plan.guardrail_id, plan.guardrail_version) for plan, _ in candidates)
    original = registry._build_with_logging
    built = []

    def build(*args):
        if built:
            raise ValueError("second candidate rejected")
        instance = original(*args)
        built.append(instance)
        return instance

    monkeypatch.setattr(registry, "_build_with_logging", build)
    with pytest.raises(ValueError, match="second candidate rejected"):
        await prepare(registry.prepare_release, candidates, active)
    close = AsyncMock(wraps=built[0].rails.shutdown)
    monkeypatch.setattr(built[0].rails, "shutdown", close)
    await registry.collect_retired()
    close.assert_awaited_once()
    assert registry.get(plan) is current
    assert not registry._staged_refs


async def test_cancelled_shutdown_still_closes_drained_instances(serving, monkeypatch):
    from unittest.mock import AsyncMock

    _, store, registry = serving
    instance = registry.get(store.plan(*store.active_plan_keys()[0]))
    close = AsyncMock(wraps=instance.rails.shutdown)
    monkeypatch.setattr(instance.rails, "shutdown", close)
    entered, release = threading.Event(), threading.Event()

    def block_worker():
        entered.set()
        assert release.wait(3)

    blocker = asyncio.create_task(prepare(block_worker))
    try:
        assert await asyncio.to_thread(entered.wait, 3)
        shutdown = asyncio.create_task(registry.shutdown())
        await asyncio.sleep(.01)
        assert registry._closed
        shutdown.cancel()
        await asyncio.sleep(.01)
        assert not shutdown.done()
    finally:
        release.set()
        await blocker
    with pytest.raises(asyncio.CancelledError):
        await shutdown
    close.assert_awaited_once()
    assert registry.stats()["entries"] == 0
