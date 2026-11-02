import json

import pytest
from prometheus_client import CollectorRegistry

from runner.admission_metrics import TenantAdmissionMetrics
from runner.metrics import RunnerMetrics
from runner.tenant_admission import TenantAdmissionConfiguration


class Owner:
    def authenticated_endpoint_tenant(self, endpoint, credential):
        return "tenantA" if credential == "valid" else None


@pytest.mark.asyncio
async def test_snapshot_tracks_actual_permits_and_histograms_without_exposing_credentials():
    observer = TenantAdmissionMetrics(CollectorRegistry(), 2, {"tenantA": 1, "tenantB": 1})
    gate = TenantAdmissionConfiguration(2, {"tenantA": 1, "tenantB": 1}, 1, 1, 1).build(lambda: True, observer=observer)
    permit = await gate.acquire(Owner(), "endpoint", "valid")
    held = observer.snapshot()
    row = next(row for row in held["tenants"] if row["tenantId"] == "tenantA")
    assert row["active"] == 1 and row["queued"] == 0 and row["outcomes"]["admitted"] == 1
    assert row["wait"]["count"] == row["wait"]["buckets"][-1] == 1
    assert row["held"]["count"] == 0
    row["active"] = 999
    assert observer.snapshot()["tenants"][0]["active"] == 1
    await permit.release()
    released = observer.snapshot()["tenants"][0]
    assert released["active"] == 0 and released["held"]["count"] == released["held"]["buckets"][-1] == 1
    assert released["held"]["buckets"] == sorted(released["held"]["buckets"])
    assert "valid" not in json.dumps(observer.snapshot())


def test_snapshot_cardinality_refusal_does_not_disable_the_existing_metrics():
    observer = TenantAdmissionMetrics(CollectorRegistry(), 65, {f"tenant-{index}": 1 for index in range(65)})
    assert observer.snapshot() == {"version": 1, "available": False, "reason": "cardinality_limit"}
    observer.state("tenant-0", 1, 0)
    assert observer.active.labels("tenant-0")._value.get() == 1


def test_heartbeat_snapshot_bytes_are_bounded_and_failures_do_not_leak_private_details():
    metrics = RunnerMetrics(1)
    assert json.loads(metrics.tenant_admission_snapshot_json())["reason"] == "disabled"
    metrics.set_tenant_admission_snapshot_provider(lambda: {"private": "x" * 70_000})
    assert json.loads(metrics.tenant_admission_snapshot_json())["reason"] == "payload_limit"

    def unavailable():
        raise ValueError("private endpoint credential must stay private")
    metrics.set_tenant_admission_snapshot_provider(unavailable)
    snapshot = metrics.tenant_admission_snapshot_json()
    assert json.loads(snapshot)["reason"] == "instrumentation_unavailable"
    assert b"private endpoint" not in snapshot
