from __future__ import annotations

import asyncio
import gzip
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from tests.control_plane.report_helpers import receive_report
from runner import generated as protocol
from runner.control_client import RunnerControlClient
from runner.validator import ValidationOutcome
from runner.toolkit.nemo.evaluators.contracts import ModelCallUsage
from tests.test_runner_control_client import Store, Metrics, _settings


def fixture_client(cleanup_task=None):
    client = RunnerControlClient(_settings(), Store(), Metrics())
    client._metrics.job = Mock()
    client._validator = SimpleNamespace(compiler_model_types=(), run=AsyncMock(return_value=ValidationOutcome(
        "passed", {"total": 0, "passed": 0}, [], protocol.Artifact(), cleanup_task=cleanup_task)))
    return client


@pytest.mark.asyncio
async def test_report_is_delivered_before_runtime_cleanup_finishes():
    release = asyncio.Event()
    cleanup = asyncio.create_task(release.wait())
    client = fixture_client(cleanup)
    execution = asyncio.create_task(client._execute_validation(protocol.ValidationRequest(run_id="before-cleanup")))
    try:
        result = await receive_report(client)
        assert result.accepted
        assert result.status == protocol.VALIDATION_STATUS_PASSED
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
    task = asyncio.create_task(client._execute_validation(protocol.ValidationRequest(run_id="wal-failure")))
    result = await receive_report(client)
    await task
    assert result.accepted and result.status == protocol.VALIDATION_STATUS_PASSED
    assert "wal-failure" in client._report_spools


@pytest.mark.asyncio
async def test_terminal_notice_rejects_report_contents_and_bounds_reason():
    client = fixture_client()
    with pytest.raises(ValueError, match="chunk channel"):
        await client._publish_validation_notice(protocol.ValidationResult(run_id="large", accepted=True))
    await client._publish_validation_notice(protocol.ValidationResult(run_id="failure", status=protocol.VALIDATION_STATUS_FAILED, reason="x"*20000))
    notice=(await client._outgoing.get()).validation_status_notice
    assert len(notice.reason)==1024
    await client._validate(protocol.ValidationRequest(run_id="failure"))
    assert (await client._outgoing.get()).validation_status_notice==notice
    client._validator.run.assert_not_awaited()


@pytest.mark.asyncio
async def test_next_test_waits_for_previous_cleanup_instead_of_being_rejected():
    release = asyncio.Event()
    client = fixture_client(asyncio.create_task(release.wait()))
    first = protocol.ControllerMessage(validation_request=protocol.ValidationRequest(run_id="first"))
    second = protocol.ControllerMessage(validation_request=protocol.ValidationRequest(run_id="second"))
    await client._handle(first)
    assert (await receive_report(client)).accepted
    await client._handle(second)
    await asyncio.sleep(0)
    assert client._outgoing.empty()
    release.set()
    assert (await receive_report(client)).accepted
    await asyncio.gather(*list(client._validation_tasks.values()))
