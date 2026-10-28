from __future__ import annotations

import asyncio
import json
import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from runner import generated as protocol
from runner.control_client import RunnerControlClient
from tests.test_runner_control_client import Store, Metrics, _settings


def client_with_validator(run):
    client = RunnerControlClient(_settings(), Store(), Metrics())
    client._metrics.job = Mock()
    client._validator = SimpleNamespace(run=run)
    return client


@pytest.mark.asyncio
async def test_cancel_by_id_joins_cleanup_and_replays_without_executing_again(caplog):
    caplog.set_level(logging.INFO, logger="uvicorn.error.tasklattice.validation")
    started, cleaned = asyncio.Event(), asyncio.Event()

    async def run(*_args, **_kwargs):
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            await asyncio.sleep(0)
            cleaned.set()

    validator = AsyncMock(side_effect=run)
    client = client_with_validator(validator)
    request = protocol.ControllerMessage(validation_request=protocol.ValidationRequest(run_id="test-stop", guardrail_id="guard"))
    await client._handle(request)
    await asyncio.wait_for(started.wait(), 1)
    await client._handle(protocol.ControllerMessage(validation_cancel_request=protocol.ValidationCancelRequest(run_id="test-stop")))
    assert cleaned.is_set()
    assert not client._validation_tasks
    result = (await client._outgoing.get()).validation_result
    assert result.status == protocol.VALIDATION_STATUS_CANCELLED
    await client._handle(request)
    await asyncio.sleep(0)
    replay = (await client._outgoing.get()).validation_result
    assert replay.status == protocol.VALIDATION_STATUS_CANCELLED
    assert validator.await_count == 1
    events = [json.loads(record.message) for record in caplog.records]
    assert {item["event"] for item in events} >= {"validation.received", "validation.started", "validation.cancel_requested", "validation.cancelled", "validation.replayed"}
    assert all(item["run_id"] == "test-stop" for item in events)


@pytest.mark.asyncio
async def test_cancel_before_execution_is_an_idempotent_tombstone():
    validator = AsyncMock()
    client = client_with_validator(validator)
    await client._cancel_validation("not-started")
    await client._cancel_validation("not-started")
    await client._validate(protocol.ValidationRequest(run_id="not-started"))
    assert validator.await_count == 0
    assert client._outgoing.qsize() == 3
    assert client._validation_result_bytes == sum(len(value) for value in client._validation_results.values())


@pytest.mark.asyncio
async def test_run_deadline_reports_failure_and_does_not_log_sensitive_exception_text(monkeypatch, caplog):
    import runner.control_client as module
    caplog.set_level(logging.INFO, logger="uvicorn.error.tasklattice.validation")
    monkeypatch.setattr(module, "VALIDATION_TIMEOUT_SECONDS", 0.01)
    cleaned = asyncio.Event()

    async def run(*_args, **_kwargs):
        try:
            await asyncio.Event().wait()
        finally:
            cleaned.set()

    client = client_with_validator(AsyncMock(side_effect=run))
    await client._validate(protocol.ValidationRequest(run_id="deadline"))
    result = (await client._outgoing.get()).validation_result
    assert cleaned.is_set()
    assert result.status == protocol.VALIDATION_STATUS_FAILED
    assert "deadline" in result.reason
    client._validator = SimpleNamespace(run=AsyncMock(side_effect=RuntimeError("secret-provider-token-and-user-content")))
    await client._validate(protocol.ValidationRequest(run_id="failure"))
    assert "secret-provider-token-and-user-content" not in caplog.text
    assert '"error_type": "RuntimeError"' in caplog.text


@pytest.mark.asyncio
async def test_cancel_overtakes_an_ordinary_command_in_the_receive_queue():
    client = client_with_validator(AsyncMock())
    command_started, command_released = asyncio.Event(), asyncio.Event()
    observed = []

    async def handle(message):
        kind = message.WhichOneof("body")
        if kind == "desired_state":
            command_started.set()
            await command_released.wait()
        else:
            observed.append(kind)
            command_released.set()

    client._handle = handle

    async def stream():
        yield protocol.ControllerMessage(desired_state=protocol.DesiredState())
        await command_started.wait()
        yield protocol.ControllerMessage(validation_cancel_request=protocol.ValidationCancelRequest(run_id="stop"))

    await asyncio.wait_for(client._receive_messages(stream()), 1)
    assert observed == ["validation_cancel_request"]


@pytest.mark.asyncio
async def test_validator_joins_sibling_cases_before_runtime_shutdown(monkeypatch):
    import runner.validator as module
    from runner.compiler import DefaultRunnerCompiler

    sibling_started, sibling_cleaned = asyncio.Event(), asyncio.Event()
    shutdown = []

    class Runtime:
        def __init__(self, _registry):
            pass

        async def shutdown(self):
            assert sibling_cleaned.is_set()
            shutdown.append(True)

    async def prepared(*_args, **_kwargs):
        return None, None, protocol.Artifact(checksum="digest")

    monkeypatch.setattr(module, "NeMoRuntime", Runtime)
    monkeypatch.setattr(module, "prepare", prepared)
    validator = module.DefaultRunnerValidator(DefaultRunnerCompiler())

    async def evaluate(_runtime, _plan, case):
        if case["id"] == "error":
            await sibling_started.wait()
            raise RuntimeError("case failed")
        sibling_started.set()
        try:
            await asyncio.Event().wait()
        finally:
            sibling_cleaned.set()

    monkeypatch.setattr(validator, "_evaluate", evaluate)
    with pytest.raises(RuntimeError, match="case failed"):
        await validator.run(protocol.ValidationRequest(run_id="siblings", test_cases=[
            protocol.ValidationTestCase(id="error"), protocol.ValidationTestCase(id="sibling"),
        ]))
    assert shutdown == [True]
