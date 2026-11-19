"""Operational routes remain truthful without Controller, storage, or auth."""
import importlib
from functools import partial
from pathlib import Path
from unittest.mock import Mock

import httpx
import pytest
from prometheus_client import Gauge, generate_latest

from runner.config import RunnerSettings
from runner.serving_lease import ServingLease


@pytest.fixture
async def operational(monkeypatch, tmp_path):
    monkeypatch.setenv("GUARD_RUNNER_CONTROL_TOKEN", "test-control-token-000000000000000000000000")
    monkeypatch.setenv("GUARD_CONTROLLER_HTTP_TOKEN", "test-inbound-http-token-000000000000000000000000")
    monkeypatch.setenv("GUARD_ARTIFACT_PUBLIC_KEY_PATH", str(Path(__file__).parents[1] / "fixtures/artifacts/local-secrets-v1/public-key.pem"))
    monkeypatch.setenv("GUARD_RUNNER_STATE_PATH", str(tmp_path))
    monkeypatch.setenv("GUARD_RUNNER_COMPILER_CAPABLE", "false")
    module = importlib.import_module("runner.main")
    app = module.create_app(RunnerSettings.from_env())
    monkeypatch.setattr("prometheus_fastapi_instrumentator.middleware.Gauge", partial(Gauge, registry=app.state.runner_metrics.registry))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
        yield app, client
    await app.state.artifact_store._registry.shutdown()


async def assert_readiness(client, ready, reason):
    bodies = []
    for path in ("/healthz", "/health/ready"):
        response = await client.get(path)
        assert response.status_code == (200 if ready else 503)
        assert response.headers["cache-control"] == "no-store"
        body = response.json()
        assert "detail" not in body
        assert body["component"] == "guard-runner"
        assert body["status"] == ("ready" if ready else "not_ready")
        assert body["ready"] is ready
        assert body["reason"] == reason
        if ready:
            assert body["error"] is None
        else:
            assert body["error"]["code"] == reason
            assert body["error"]["message"]
        bodies.append(body)
    assert bodies[0] == bodies[1]
    return bodies[0]


async def test_initialization_synchronization_disconnect_and_recovery(operational):
    app, client = operational
    control = app.state.runner_control
    await assert_readiness(client, False, "controller_disconnected")
    control._connected.set()
    await assert_readiness(client, False, "controller_unsynchronized")
    control._allow_synchronized_serving()
    await assert_readiness(client, True, "ready")
    control._revoke_synchronization()
    control._connected.clear()
    await assert_readiness(client, False, "controller_disconnected")
    control._connected.set()
    control._allow_synchronized_serving()
    await assert_readiness(client, True, "ready")


@pytest.mark.parametrize("reason", ["registry_closed", "missing_prewarmed_guardrail_versions"])
async def test_runtime_readiness_failures_have_matching_status_and_reason(operational, monkeypatch, reason):
    app, client = operational
    app.state.runner_control._allow_synchronized_serving()
    monkeypatch.setattr(app.state.artifact_store._registry, "readiness", lambda: {
        "ready": False, "status": "not_ready", "reason": reason,
        "active_versions": 1, "prewarmed_active_versions": 0,
        "missing_versions": [{"guardrail_id": "fixture", "guardrail_version": "v1"}],
    })
    body = await assert_readiness(client, False, reason)
    assert body["missing_versions"] == [{"guardrail_id": "fixture", "guardrail_version": "v1"}]


async def test_expired_lease_never_reports_ready(operational):
    app, client = operational
    control = app.state.runner_control
    now = [10.0]
    lease = ServingLease(1, clock=lambda: now[0])
    control._serving_lease = lease
    control._connected.set()
    control._allow_synchronized_serving()
    lease.activate_allocation(1, 0)
    challenge = lease.challenge()
    assert lease.accept(challenge, epoch=1, generation=0, nonce=challenge.nonce, duration_seconds=1)
    await assert_readiness(client, True, "ready")
    now[0] += 2
    await assert_readiness(client, False, "controller_unsynchronized")


async def test_unexpected_check_errors_are_sanitized_and_recoverable(operational, monkeypatch):
    app, client = operational
    registry = app.state.artifact_store._registry
    original = registry.readiness
    monkeypatch.setattr(registry, "readiness", Mock(side_effect=RuntimeError("PRIVATE_CREDENTIAL")))
    body = await assert_readiness(client, False, "readiness_check_failed")
    assert "PRIVATE_CREDENTIAL" not in str(body)
    monkeypatch.setattr(registry, "readiness", original)
    app.state.runner_control._allow_synchronized_serving()
    await assert_readiness(client, True, "ready")


async def test_version_and_liveness_do_not_access_dependencies_even_while_stopping(operational, monkeypatch):
    app, client = operational
    from runner.software_version import SOFTWARE_VERSION
    check = Mock(side_effect=RuntimeError("Storage unavailable"))
    monkeypatch.setattr(app.state.artifact_store._registry, "readiness", check)
    monkeypatch.setattr("runner.software_version.read_software_version", check)
    monkeypatch.setenv("TALI_BUILD_INFO", "invalid")
    for stopping in (False, True):
        app.state.stopping = stopping
        version = await client.get("/version")
        assert version.status_code == 200
        assert version.headers["cache-control"] == "no-store"
        assert version.json() == {"component": "guard-runner", **SOFTWARE_VERSION}
        live = await client.get("/health/live")
        assert live.status_code == 200
        assert live.headers["cache-control"] == "no-store"
        assert live.json() == {"component": "guard-runner", "status": "ok"}
    await assert_readiness(client, False, "stopping")
    check.assert_not_called()


async def test_reserved_paths_methods_and_head_are_consistent(operational):
    app, client = operational
    app.state.runner_control._allow_synchronized_serving()
    for path in ("/health", "/health/typo", "/healthz/typo", "/version/typo"):
        response = await client.get(path)
        assert response.status_code == 404
        assert response.headers["cache-control"] == "no-store"
        assert response.json() == {"error": {"code": "not_found", "message": "Route not found."}}
    for path in ("/healthz", "/health/ready", "/health/live", "/version"):
        assert (await client.post(path)).status_code == 404
        response = await client.head(path)
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        assert response.content == b""
    control = app.state.runner_control
    control._revoke_synchronization()
    assert (await client.head("/healthz")).status_code == 503


async def test_operational_traffic_is_excluded_from_business_http_metrics(operational):
    app, client = operational
    for path in ("/healthz", "/health/ready", "/health/live", "/version"):
        await client.get(path)
    metrics = generate_latest(app.state.runner_metrics.registry).decode()
    for path in ("/healthz", "/health/ready", "/health/live", "/version"):
        assert f'handler="{path}"' not in metrics
