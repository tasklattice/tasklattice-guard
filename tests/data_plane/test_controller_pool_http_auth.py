"""Controller-to-Runner credentials are separate pool authorities."""
from __future__ import annotations

import importlib
from functools import partial
from pathlib import Path

import httpx
import pytest
from prometheus_client import Gauge

from runner.config import RunnerSettings

LEGACY = "legacy-controller-token-with-at-least-32-characters"
CONTROL_A = "pool-a-control-token-with-at-least-32-characters"
CONTROL_B = "pool-b-control-token-with-at-least-32-characters"
HTTP_A = "pool-a-inbound-http-token-with-at-least-32-characters"
HTTP_B = "pool-b-inbound-http-token-with-at-least-32-characters"


@pytest.mark.asyncio
@pytest.mark.parametrize("legacy_present", [True, False])
async def test_real_runner_apps_accept_only_their_own_inbound_controller_token(monkeypatch, tmp_path, legacy_present):
    if legacy_present:
        monkeypatch.setenv("GUARD_CONTROLLER_TOKEN", LEGACY)
    else:
        monkeypatch.delenv("GUARD_CONTROLLER_TOKEN", raising=False)
    monkeypatch.setenv("GUARD_RUNNER_SCOPED_TELEMETRY", "false" if legacy_present else "true")
    monkeypatch.setenv("GUARD_ARTIFACT_PUBLIC_KEY_PATH", str(Path(__file__).parents[1] / "fixtures/artifacts/local-secrets-v1/public-key.pem"))
    monkeypatch.setenv("GUARD_RUNNER_COMPILER_CAPABLE", "false")
    monkeypatch.setenv("GUARD_RUNNER_EXPERIMENTAL_LEASE_ENFORCEMENT", "false")
    monkeypatch.setenv("GUARD_RUNNER_TENANT_ADMISSION_ENABLED", "false")
    monkeypatch.delenv("GUARD_RUNNER_TENANT_ADMISSION_JSON", raising=False)
    apps = []
    for pool, control, inbound in [("pool-a", CONTROL_A, HTTP_A), ("pool-b", CONTROL_B, HTTP_B)]:
        monkeypatch.setenv("GUARD_RUNNER_POOL_ID", pool)
        monkeypatch.setenv("GUARD_RUNNER_ID", pool)
        monkeypatch.setenv("GUARD_RUNNER_CONTROL_TOKEN", control)
        monkeypatch.setenv("GUARD_CONTROLLER_HTTP_TOKEN", inbound)
        monkeypatch.setenv("GUARD_RUNNER_STATE_PATH", str(tmp_path / pool))
        module = importlib.import_module("runner.main")
        app = module.create_app(RunnerSettings.from_env())
        app.state.runner_control._allow_synchronized_serving()
        apps.append((app, inbound, HTTP_B if pool == "pool-a" else HTTP_A))
    try:
        for app, own, foreign in apps:
            # The dependency's in-progress gauge otherwise uses the process-global registry.
            monkeypatch.setattr("prometheus_fastapi_instrumentator.middleware.Gauge", partial(Gauge, registry=app.state.runner_metrics.registry))
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
                for token, expected in [(own, 404), (foreign, 401), (LEGACY, 401), (CONTROL_A, 401), (CONTROL_B, 401)]:
                    response = await client.post("/internal/v1/guardrails/missing/evaluate",
                        headers={"authorization": f"Bearer {token}"},
                        json={"phase": "input", "texts": ["hello"], "guardrail_version": "20261012-030000.000Z"})
                    assert response.status_code == expected, response.text
                    assert all(secret not in response.text for secret in (HTTP_A, HTTP_B, CONTROL_A, CONTROL_B, LEGACY))
                for token, expected in [(own, 409), (foreign, 401), (LEGACY, 401), (CONTROL_A, 401)]:
                    response = await client.post("/internal/v1/playground/routers/missing/test",
                        headers={"authorization": f"Bearer {token}"},
                        json={"revision": 1, "endpoint_id": "missing", "action": "simulate", "call_id": "call", "business_request": {}, "text": "hello"})
                    assert response.status_code == expected, response.text
    finally:
        for app, _, _ in apps:
            await app.state.artifact_store._registry.shutdown()
