from __future__ import annotations

import asyncio
import gzip
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from runner import generated as protocol
from runner.control_client import RunnerControlClient
from runner.validator import ValidationOutcome
from runner.toolkit.nemo.evaluators.contracts import ModelCallUsage
from tests.test_runner_control_client import Store, Metrics, _settings


def fixture_client(cleanup_task=None):
    client = RunnerControlClient(_settings(), Store(), Metrics())
    client._metrics.job = Mock()
    client._validator = SimpleNamespace(compiler_model_types=(), run=AsyncMock(return_value=ValidationOutcome(
        "passed", {"total": 1, "passed": 1}, [], protocol.Artifact(), cleanup_task=cleanup_task)))
    return client


@pytest.mark.asyncio
async def test_report_is_delivered_before_runtime_cleanup_finishes():
    release = asyncio.Event()
    cleanup = asyncio.create_task(release.wait())
    client = fixture_client(cleanup)
    execution = asyncio.create_task(client._execute_validation(protocol.ValidationRequest(run_id="before-cleanup")))
    try:
        message = await asyncio.wait_for(client._outgoing.get(), 1)
        assert message.validation_result.accepted
        assert message.validation_result.status == protocol.VALIDATION_STATUS_PASSED
        assert not execution.done()
        assert not cleanup.done()
    finally:
        release.set()
        await asyncio.wait_for(execution, 1)


@pytest.mark.asyncio
async def test_cost_wal_failure_cannot_lose_the_completed_report(monkeypatch):
    import runner.control_client as module
    calls = [ModelCallUsage(provider="test", model="test", operation="evaluate", result="success", duration_ms=1)]
    monkeypatch.setattr(module, "begin_cost_collection", lambda: (calls, None))
    monkeypatch.setattr(module, "end_cost_collection", lambda _token: None)
    client = fixture_client()
    client._telemetry = SimpleNamespace(emit=AsyncMock(side_effect=OSError("WAL unavailable")))
    await client._execute_validation(protocol.ValidationRequest(run_id="wal-failure"))
    result = (await client._outgoing.get()).validation_result
    assert result.accepted and result.status == protocol.VALIDATION_STATUS_PASSED
    assert "wal-failure" in client._validation_results


@pytest.mark.asyncio
async def test_large_report_uses_compressed_typed_payload_and_replays_without_rerunning():
    client = fixture_client()
    client._compressed_validation_reports = True
    result = protocol.ValidationResult(runner_id="runner-0", run_id="large", accepted=True,
        status=protocol.VALIDATION_STATUS_PASSED, reason="evidence" * (5 * 1024 * 1024))
    assert result.ByteSize() > 32 * 1024 * 1024
    await client._publish_validation_result(result)
    first = await client._outgoing.get()
    assert first.HasField("validation_report")
    assert first.ByteSize() < 1024 * 1024
    assert gzip.decompress(first.validation_report.gzip_result) == result.SerializeToString()
    await client._validate(protocol.ValidationRequest(run_id="large"))
    replay = await client._outgoing.get()
    assert replay.validation_report == first.validation_report
    assert client._validator.run.await_count == 0


@pytest.mark.asyncio
async def test_next_test_waits_for_previous_cleanup_instead_of_being_rejected():
    release = asyncio.Event()
    client = fixture_client(asyncio.create_task(release.wait()))
    first = protocol.ControllerMessage(validation_request=protocol.ValidationRequest(run_id="first"))
    second = protocol.ControllerMessage(validation_request=protocol.ValidationRequest(run_id="second"))
    await client._handle(first)
    assert (await asyncio.wait_for(client._outgoing.get(), 1)).validation_result.accepted
    await client._handle(second)
    await asyncio.sleep(0)
    assert client._outgoing.empty()
    release.set()
    assert (await asyncio.wait_for(client._outgoing.get(), 1)).validation_result.accepted
    await asyncio.gather(*list(client._validation_tasks.values()))
