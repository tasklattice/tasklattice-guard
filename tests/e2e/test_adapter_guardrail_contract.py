"""Controller compilation -> real Runner TCP -> Guardrails -> wire responses.

No external F5/LiteLLM installation is required; these are their public HTTP
contracts, exercising both endpoints against the same compiled plan.
"""
import httpx
import pytest

from tests.control_plane.test_scan_evidence_scope import online_app, send, Recorder
from tests.control_plane.plan_fixtures import _controller_plans
from tests.tcp import tcp_server


@pytest.mark.parametrize("direction", ["request", "response"])
@pytest.mark.parametrize("plan_key,fail_rule,status", [
    ("blockfirst", "r-mask", 200),   # Block before the failing check: 200.
    ("mix", "r-block", 503),         # Failing check is reached first: 503.
])
async def test_network_adapters_preserve_core_disposition_and_execution_status(plan_key, direction, fail_rule, status):
    plan = _controller_plans()[plan_key]
    async with online_app(plan, capture="trace", recorder=Recorder(fail_rule)) as (app, _, recorder, telemetry):
        async with tcp_server(app) as url:
            async with httpx.AsyncClient(base_url=url) as client:
                scan = await send(client, "scan", direction, flagOnly=False, verbose=True)
                lite = await send(client, "lite", direction)
        assert scan.status_code == lite.status_code == status
        if status == 200:
            assert scan.json()["result"]["outcome"] == "blocked"
            assert lite.json()["action"] == "BLOCKED"
            assert recorder.calls == ["r-block", "r-block"]
        assert len(telemetry.events) == 2
        assert all(e["metadata"]["executionStatus"] == ("complete" if status == 200 else "error") for e in telemetry.events)
