from __future__ import annotations

import asyncio
import json
import threading
import hashlib
from types import SimpleNamespace

import httpx
import pytest
import pytest_asyncio

from runner.telemetry import RuntimeTelemetryExporter
from runner.telemetry_progress import ProgressWAL, WALCapacityError


@pytest_asyncio.fixture
async def wal(tmp_path):
    value = ProgressWAL(tmp_path)
    try:
        yield value
    finally:
        await value.close()


def acknowledgement(batch):
    progress = batch["progress"]
    return dict(walId=progress["walId"], acknowledgedCursor=progress["lastCursor"], producedCursor=progress["producedCursor"],
        lastBatchId=progress["batchId"] if batch["events"] else "",
        lastBatchDigest=hashlib.sha256(json.dumps(batch, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest() if batch["events"] else "")


@pytest.mark.asyncio
async def test_one_exact_pending_batch_survives_append_and_restart(wal, tmp_path):
    await wal.append({"id": "one", "allocationContextId": "private-context"})
    batch = await wal.batch(100)
    await wal.append({"id": "two"})
    assert await wal.batch(100) == batch
    await wal.close()
    restarted = ProgressWAL(tmp_path)
    try:
        assert await restarted.batch(100) == batch
        await restarted.acknowledge(batch, acknowledgement(batch))
        remaining = await restarted.batch(100)
        assert remaining["events"] == [{"id": "two"}]
        assert remaining["progress"]["firstCursor"] == 2
        await restarted.acknowledge(remaining, acknowledgement(remaining))
        empty = await restarted.batch(100)
        assert empty["events"] == [] and empty["progress"]["firstCursor"] == empty["progress"]["lastCursor"] == 2
    finally:
        await restarted.close()


@pytest.mark.asyncio
async def test_registration_ack_reconciles_committed_batch_but_rejects_reset_or_lost_tail(wal):
    await wal.append({"id": "one"})
    batch = await wal.batch(1)
    await wal.append({"id": "two"})
    proof = acknowledgement(batch)
    await wal.bind(wal.wal_id, 1, 1, proof["lastBatchId"], proof["lastBatchDigest"])
    assert wal.events == [{"id": "two"}]
    for acknowledged, produced in [(0, 0), (1, 3), (2, 2)]:
        with pytest.raises(RuntimeError):
            await wal.bind(wal.wal_id, acknowledged, produced)
    assert batch["progress"]["lastCursor"] == 1


@pytest.mark.asyncio
async def test_reconnect_never_compacts_different_payload_at_same_pending_cursor(wal, tmp_path):
    await wal.append({"id": "original"})
    batch = await wal.batch(1)
    proof = acknowledgement(batch)
    await wal.close()
    state = json.loads(wal.path.read_text())
    state["records"][0]["event"]["id"] = "different-restored-payload"
    wal.path.write_text(json.dumps(state))
    restarted = ProgressWAL(tmp_path)
    try:
        with pytest.raises(RuntimeError, match="differs"):
            await restarted.bind(restarted.wal_id, 1, 1, proof["lastBatchId"], proof["lastBatchDigest"])
        assert restarted.events == [{"id": "different-restored-payload"}]
    finally:
        await restarted.close()


@pytest.mark.asyncio
async def test_separate_progress_volume_still_refuses_original_legacy_wal(tmp_path):
    legacy, persistent = tmp_path / "artifacts", tmp_path / "persistent"
    legacy.mkdir()
    (legacy / "runtime-events.wal").write_text('{"id":"legacy"}\n')
    with pytest.raises(ValueError, match="legacy"):
        RuntimeTelemetryExporter("http://controller/events", "pool-token", legacy, 100, "runner-a",
            progress_enabled=True, progress_state_path=persistent)
    assert not persistent.exists()


@pytest.mark.asyncio
async def test_disabling_progress_refuses_visible_pending_unknown_or_active_state(tmp_path):
    persistent, artifacts = tmp_path / "persistent", tmp_path / "artifacts"
    wal = ProgressWAL(persistent)
    with pytest.raises(RuntimeError, match="one process"):
        RuntimeTelemetryExporter("http://controller/events", "token", artifacts, 100, "runner", progress_state_path=persistent)
    await wal.append({"id": "pending"})
    await wal.close()
    with pytest.raises(ValueError, match="disabling"):
        RuntimeTelemetryExporter("http://controller/events", "token", artifacts, 100, "runner", progress_state_path=persistent)
    wal = ProgressWAL(persistent)
    batch = await wal.batch(100)
    await wal.acknowledge(batch, acknowledgement(batch))
    await wal.close()
    legacy = RuntimeTelemetryExporter("http://controller/events", "token", artifacts, 100, "runner", progress_state_path=persistent)
    assert legacy.progress_wal_id is None
    await legacy.stop()
    wal.path.write_text('{"version":999}')
    with pytest.raises(ValueError, match="malformed"):
        RuntimeTelemetryExporter("http://controller/events", "token", artifacts, 100, "runner", progress_state_path=persistent)


@pytest.mark.asyncio
@pytest.mark.parametrize("field,value", [("walId", "foreign"), ("acknowledgedCursor", 2), ("acknowledgedCursor", True), ("producedCursor", 4)])
async def test_invalid_ack_never_compacts_wal(wal, field, value):
    await wal.append({"id": "one"})
    batch = await wal.batch(1)
    with pytest.raises(RuntimeError):
        await wal.acknowledge(batch, {**acknowledgement(batch), field: value})
    assert wal.events == [{"id": "one"}]


@pytest.mark.asyncio
async def test_capacity_refusal_preserves_existing_data_and_allows_drain(wal, monkeypatch):
    monkeypatch.setattr("runner.telemetry_progress.MAX_RECORDS", 1)
    await wal.append({"id": "one"})
    with pytest.raises(WALCapacityError):
        await wal.append({"id": "two"})
    batch = await wal.batch(1)
    await wal.acknowledge(batch, acknowledgement(batch))
    await wal.append({"id": "two"})
    assert (await wal.batch(1))["progress"]["lastCursor"] == 2


@pytest.mark.asyncio
async def test_near_byte_capacity_reserves_space_for_pending_and_ack(wal, monkeypatch):
    monkeypatch.setattr("runner.telemetry_progress.MAX_BYTES", 4096)
    await wal.append({"id": "one", "body": "x" * 2300})
    with pytest.raises(WALCapacityError):
        await wal.append({"id": "tail", "body": "x" * 1000})
    batch = await wal.batch(100)
    assert batch["events"][0]["id"] == "one"
    await wal.acknowledge(batch, acknowledgement(batch))
    assert wal.events == []


@pytest.mark.asyncio
async def test_adaptive_prefixes_deliver_heavy_trace_tail_without_413_poison(wal):
    for index in range(6):
        await wal.append({"id": str(index), "metadata": {"usage": {"model_calls": [{}] * 48}}})
    first = await wal.batch(100)
    assert len(first["events"]) == 5
    await wal.acknowledge(first, acknowledgement(first))
    tail = await wal.batch(100)
    assert len(tail["events"]) == 1
    await wal.acknowledge(tail, acknowledgement(tail))
    assert wal.events == []


@pytest.mark.asyncio
@pytest.mark.parametrize("limit", ["calls", "depth", "tokens", "bytes"])
async def test_individually_unsendable_record_preserves_wal_without_skipping(wal, monkeypatch, limit):
    event = {"id": "unsupported", "metadata": {"usage": {"model_calls": [{}] * 65}}}
    if limit == "depth":
        event = {"id": "unsupported", "nested": [[[[0]]]]}
        monkeypatch.setattr("runner.telemetry_progress.MAX_BODY_DEPTH", 3)
    elif limit == "tokens":
        event = {"id": "unsupported", "values": list(range(50))}
        monkeypatch.setattr("runner.telemetry_progress.MAX_STRUCTURAL_TOKENS", 30)
    elif limit == "bytes":
        event = {"id": "unsupported", "body": "x" * 1000}
        monkeypatch.setattr("runner.telemetry_progress.MAX_BODY_BYTES", 500)
    await wal.append(event)
    with pytest.raises(RuntimeError, match="reconciliation"):
        await wal.batch(100)
    assert wal.events == [event]
    assert json.loads(wal.path.read_text())["pending"] is None


@pytest.mark.asyncio
async def test_io_uncertainty_fences_future_mutations_until_restart(wal, tmp_path, monkeypatch):
    write = wal._write

    def uncertain(state):
        write(state)
        raise OSError("directory fsync acknowledgement lost")

    monkeypatch.setattr(wal, "_write", uncertain)
    with pytest.raises(OSError):
        await wal.append({"id": "committed"})
    with pytest.raises(RuntimeError, match="uncertain"):
        await wal.append({"id": "must-not-overwrite"})
    await wal.close()
    restarted = ProgressWAL(tmp_path)
    try:
        assert restarted.events == [{"id": "committed"}]
    finally:
        await restarted.close()


@pytest.mark.asyncio
async def test_canceled_append_keeps_writer_lock_until_background_disk_commit(wal, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    write = wal._write

    def blocked(state):
        entered.set()
        assert release.wait(2)
        write(state)

    monkeypatch.setattr(wal, "_write", blocked)
    first = asyncio.create_task(wal.append({"id": "one"}))
    assert await asyncio.to_thread(entered.wait, 2)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    second = asyncio.create_task(wal.append({"id": "two"}))
    await asyncio.sleep(0)
    assert not second.done()
    release.set()
    await second
    assert wal.events == [{"id": "one"}, {"id": "two"}]


@pytest.mark.asyncio
async def test_single_writer_and_corrupt_or_mixed_state_fail_closed(wal, tmp_path):
    with pytest.raises(RuntimeError, match="one process"):
        ProgressWAL(tmp_path)
    await wal.close()
    (tmp_path / "runtime-events.wal").write_text('{"id":"legacy"}\n')
    with pytest.raises(ValueError, match="legacy"):
        ProgressWAL(tmp_path)
    (tmp_path / "runtime-events.wal").write_text("")
    (tmp_path / "runtime-progress.wal.json").write_text('{"version":1}')
    with pytest.raises(ValueError, match="malformed"):
        ProgressWAL(tmp_path)


@pytest.mark.asyncio
async def test_exporter_requires_grpc_capability_and_exact_cursor_ack_preserving_replay(tmp_path):
    exporter = RuntimeTelemetryExporter("http://controller/events", "pool-token", tmp_path, 100, "runner-a", progress_enabled=True)
    requests = []

    def receive(request):
        requests.append(request)
        if len(requests) == 1:
            raise httpx.ReadTimeout("committed but reply lost")
        batch = json.loads(request.content)
        return httpx.Response(202, json={"accepted": len(batch["events"]), "progress": acknowledgement(batch)})

    try:
        await exporter.emit({"id": "one", "runnerId": "runner-a", "allocationContextId": "private-context"})
        async with httpx.AsyncClient(transport=httpx.MockTransport(receive)) as client:
            assert await exporter._flush_once(client) is False and requests == []
            await exporter.authorize_progress(SimpleNamespace(wal_id=exporter.progress_wal_id, capability="a" * 64,
                acknowledged_cursor=0, produced_cursor=0))
            with pytest.raises(httpx.ReadTimeout):
                await exporter._flush_once(client)
            await exporter.emit({"id": "two", "runnerId": "runner-a"})
            assert await exporter._flush_once(client) is True
            assert requests[0].content == requests[1].content
            assert requests[1].headers["x-tasklattice-telemetry-capability"] == "a" * 64
            assert json.loads(requests[1].content)["events"][0]["allocationContextId"] == "private-context"
            assert await exporter._flush_once(client) is False
            await exporter._report_watermark(client)
            assert json.loads(requests[-1].content)["events"] == []
            assert "runnerId" not in json.loads(requests[-1].content)
            exporter.clear_progress_authorization()
            count = len(requests)
            await exporter._report_watermark(client)
            assert len(requests) == count
    finally:
        await exporter.stop()


@pytest.mark.asyncio
async def test_typed_control_registration_installs_then_revokes_current_upload_capability(tmp_path):
    from runner import generated as protocol
    from runner.control_client import RunnerControlClient
    from tests.test_runner_control_client import Store, Metrics, _settings

    exporter = RuntimeTelemetryExporter("http://controller/events", "pool-token", tmp_path, 100, "runner-0", progress_enabled=True)
    try:
        settings = _settings()
        settings.max_concurrency = 2
        client = RunnerControlClient(settings, Store(), Metrics(), telemetry=exporter)
        registration = client._registration().registration
        assert registration.telemetry_wal_id == exporter.progress_wal_id
        await client._handle(protocol.ControllerMessage(registration_accepted=protocol.RegistrationAccepted(
            heartbeat_interval_seconds=10, desired_generation=1,
            telemetry_upload_authorization=protocol.TelemetryUploadAuthorization(wal_id=exporter.progress_wal_id,
                capability="a" * 64, acknowledged_cursor=0, produced_cursor=0))))
        assert exporter._progress_capability == "a" * 64
        assert "a" * 64 not in exporter._progress_wal.path.read_text()
        client._revoke_synchronization()
        assert exporter._progress_capability is None
        with pytest.raises(RuntimeError, match="unavailable"):
            await client._handle(protocol.ControllerMessage(registration_accepted=protocol.RegistrationAccepted()))
    finally:
        await exporter.stop()


def test_progress_settings_are_explicit_and_keep_persistent_path_separate(monkeypatch, tmp_path):
    from runner.config import RunnerSettings
    from tests.test_runner_model_config import _required_runner_env
    _required_runner_env(monkeypatch)
    monkeypatch.setenv("GUARD_RUNNER_TELEMETRY_PROGRESS_ENABLED", "false")
    monkeypatch.setenv("GUARD_RUNNER_SCOPED_TELEMETRY", "false")
    assert RunnerSettings.from_env().telemetry_progress_enabled is False
    monkeypatch.setenv("GUARD_RUNNER_TELEMETRY_PROGRESS_ENABLED", "true")
    with pytest.raises(ValueError, match="requires scoped"):
        RunnerSettings.from_env()
    monkeypatch.setenv("GUARD_RUNNER_SCOPED_TELEMETRY", "true")
    monkeypatch.setenv("GUARD_RUNNER_CONTROL_TOKEN", "pool-control-token-with-at-least-32-characters")
    monkeypatch.setenv("GUARD_RUNNER_STATE_PATH", str(tmp_path / "artifacts"))
    monkeypatch.setenv("GUARD_RUNNER_TELEMETRY_PROGRESS_PATH", str(tmp_path / "persistent"))
    settings = RunnerSettings.from_env()
    assert settings.artifact_state_path == tmp_path / "artifacts"
    assert settings.telemetry_progress_state_path == tmp_path / "persistent"
    monkeypatch.setenv("GUARD_RUNNER_TELEMETRY_BATCH_SIZE", "1001")
    with pytest.raises(ValueError, match="must not exceed 1000"):
        RunnerSettings.from_env()
