import json
from types import SimpleNamespace

import pytest
from prometheus_client import CollectorRegistry

from runner.admission_metrics import ProjectAdmissionMetrics
from runner.admission_snapshot_codec import admission_snapshot_to_proto
from runner.control_client import RunnerControlClient
from runner import generated as protocol
from runner.metrics import RunnerMetrics
from runner.project_admission import ProjectAdmissionConfiguration


class Owner:
    def authenticated_endpoint_project(self, endpoint, credential):
        return "projectA" if credential == "valid" else None


@pytest.mark.asyncio
async def test_snapshot_tracks_actual_permits_and_histograms_without_exposing_credentials():
    observer = ProjectAdmissionMetrics(CollectorRegistry(), 2, {"projectA": 1, "projectB": 1})
    gate = ProjectAdmissionConfiguration(2, {"projectA": 1, "projectB": 1}, 1, 1, 1).build(lambda: True, observer=observer)
    permit = await gate.acquire(Owner(), "endpoint", "valid")
    held = observer.snapshot()
    row = next(row for row in held["projects"] if row["projectId"] == "projectA")
    assert row["active"] == 1 and row["queued"] == 0 and row["outcomes"]["admitted"] == 1
    assert row["wait"]["count"] == row["wait"]["buckets"][-1] == 1
    assert row["held"]["count"] == 0
    row["active"] = 999
    assert observer.snapshot()["projects"][0]["active"] == 1
    await permit.release()
    released = observer.snapshot()["projects"][0]
    assert released["active"] == 0 and released["held"]["count"] == released["held"]["buckets"][-1] == 1
    assert released["held"]["buckets"] == sorted(released["held"]["buckets"])
    assert "valid" not in json.dumps(observer.snapshot())


def test_snapshot_cardinality_refusal_does_not_disable_the_existing_metrics():
    observer = ProjectAdmissionMetrics(CollectorRegistry(), 65, {f"project-{index}": 1 for index in range(65)})
    assert observer.snapshot() == {"version": 1, "available": False, "reason": "cardinality_limit"}
    observer.state("project-0", 1, 0)
    assert observer.active.labels("project-0")._value.get() == 1


def test_heartbeat_snapshot_bytes_are_bounded_and_failures_do_not_leak_private_details():
    metrics = RunnerMetrics(1)
    assert json.loads(metrics.project_admission_snapshot_json())["reason"] == "disabled"
    metrics.set_project_admission_snapshot_provider(lambda: {"private": "x" * 70_000})
    assert json.loads(metrics.project_admission_snapshot_json())["reason"] == "payload_limit"

    def unavailable():
        raise ValueError("private endpoint credential must stay private")
    metrics.set_project_admission_snapshot_provider(unavailable)
    snapshot = metrics.project_admission_snapshot_json()
    assert json.loads(snapshot)["reason"] == "instrumentation_unavailable"
    assert b"private endpoint" not in snapshot


@pytest.mark.asyncio
async def test_typed_heartbeat_round_trip_preserves_actual_measurements_and_zero_presence():
    metrics = RunnerMetrics(1)
    observer = ProjectAdmissionMetrics(CollectorRegistry(), 1, {"projectA": 1})
    metrics.set_project_admission_snapshot_provider(observer.snapshot)
    observer.outcome("projectA", "admitted", 0.025)
    observer.state("projectA", 1, 0)
    client = RunnerControlClient(SimpleNamespace(runner_id="runner-test", compiler_capable=False),
                                 SimpleNamespace(generation=4, protection_generation=0), metrics)
    await client._send_heartbeat()
    sent = await client._outgoing.get()
    heartbeat = protocol.RunnerMessage.FromString(sent.SerializeToString()).heartbeat
    assert heartbeat.HasField("project_admission_snapshot")
    snapshot = heartbeat.project_admission_snapshot
    assert snapshot.available is True and snapshot.HasField("available")
    assert snapshot.capacity == 1 and snapshot.monotonic_seconds > 0
    project = snapshot.projects[0]
    assert project.project_id == "projectA" and project.active == 1
    assert project.queued == 0 and project.HasField("queued")
    assert project.outcomes.admitted == project.wait.count == project.wait.buckets[-1] == 1
    assert project.outcomes.queue_full == 0 and project.outcomes.HasField("queue_full")
    assert project.held.HasField("count") and project.held.count == 0
    assert heartbeat.DESCRIPTOR.fields_by_name["project_admission_snapshot"].number == 8
    assert 7 not in heartbeat.DESCRIPTOR.fields_by_number


def test_typed_snapshot_refuses_oversized_or_invalid_instrumentation_without_private_details():
    oversized = admission_snapshot_to_proto(b"x" * 65_537)
    assert oversized.available is False and oversized.reason == "payload_limit"
    invalid = admission_snapshot_to_proto(b'{"private":"credential sentinel"}')
    assert invalid.available is False and invalid.reason == "instrumentation_unavailable"
    assert b"credential sentinel" not in invalid.SerializeToString()
