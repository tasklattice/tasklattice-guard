from __future__ import annotations

import asyncio
import json
import logging
import threading

import pytest
from prometheus_client import CollectorRegistry

from runner.diagnostics import EventLoopWatchdog, _active_phases, diagnostic_phase


class SignalOnStall(logging.Handler):
    def __init__(self, signal: threading.Event):
        super().__init__()
        self.signal = signal

    def emit(self, record):
        if json.loads(record.getMessage()).get("event") == "runner_event_loop_stalled":
            self.signal.set()


@pytest.mark.asyncio
async def test_watchdog_reports_blocked_loop_before_it_recovers(caplog):
    registry = CollectorRegistry()
    watchdog = EventLoopWatchdog(registry, runner_id="test-runner", interval=.01, stall_threshold=.03)
    detected = threading.Event()
    handler = SignalOnStall(detected)
    logger = logging.getLogger("uvicorn.error.tasklattice.diagnostics")
    logger.addHandler(handler)
    caplog.set_level(logging.INFO, logger=logger.name)
    watchdog.start()
    try:
        with diagnostic_phase("test.blocked", generation=42):
            # A thread must emit the warning while this event loop cannot run.
            assert detected.wait(3)
        for _ in range(100):
            if any('"runner_event_loop_recovered"' in record.message for record in caplog.records):
                break
            await asyncio.sleep(.01)
        records = [json.loads(record.message) for record in caplog.records if record.name == logger.name]
        warning = next(record for record in records if record["event"] == "runner_event_loop_stalled")
        assert warning["runner_id"] == "test-runner"
        assert warning["active_phases"][0]["generation"] == 42
        assert warning["resources"]["rss_bytes"] > 0
        assert any(frame["function"] == "test_watchdog_reports_blocked_loop_before_it_recovers"
                   for stack in warning["stacks"].values() for frame in stack)
        assert sum(record["event"] == "runner_event_loop_stalled" for record in records) == 1
        assert any(record["event"] == "runner_event_loop_recovered" for record in records)
        assert registry.get_sample_value("guard_runner_event_loop_stalls_total") == 1
        assert registry.get_sample_value("guard_runner_event_loop_delay_seconds_sum") >= .03
    finally:
        await watchdog.stop()
        logger.removeHandler(handler)
    assert not watchdog._thread.is_alive()
    assert watchdog._task.done()


@pytest.mark.asyncio
async def test_async_io_does_not_trigger_watchdog(caplog):
    registry = CollectorRegistry()
    watchdog = EventLoopWatchdog(registry, runner_id="test", interval=.01, stall_threshold=1)
    watchdog.start()
    try:
        await asyncio.sleep(.05)
        assert registry.get_sample_value("guard_runner_event_loop_stalls_total") == 0
        assert not any('"runner_event_loop_stalled"' in record.message for record in caplog.records)
    finally:
        await watchdog.stop()


@pytest.mark.asyncio
async def test_completed_delay_is_logged_when_watchdog_cannot_sample(monkeypatch, caplog):
    import time

    caplog.set_level(logging.WARNING, logger="uvicorn.error.tasklattice.diagnostics")
    registry = CollectorRegistry()
    watchdog = EventLoopWatchdog(registry, runner_id="test", interval=.01, stall_threshold=.03)
    monkeypatch.setattr(watchdog, "_watch", lambda: watchdog._stop.wait(3))
    watchdog.start()
    try:
        time.sleep(.08)
        for _ in range(100):
            if any('"runner_event_loop_delayed"' in record.message for record in caplog.records):
                break
            await asyncio.sleep(.01)
        assert any('"runner_event_loop_delayed"' in record.message for record in caplog.records)
        assert registry.get_sample_value("guard_runner_event_loop_stalls_total") == 0
        assert registry.get_sample_value("guard_runner_event_loop_delay_seconds_sum") >= .03
    finally:
        await watchdog.stop()


def test_failed_phase_is_removed_and_does_not_log_exception_payload(caplog):
    caplog.set_level(logging.INFO, logger="uvicorn.error.tasklattice.diagnostics")
    with pytest.raises(ValueError):
        with diagnostic_phase("test.failed", artifacts=5):
            raise ValueError("private-request-and-secret")
    assert not _active_phases(0)
    assert "private-request-and-secret" not in caplog.text
    finished = json.loads(caplog.records[-1].message)
    assert finished["result"] == "error"
    assert finished["error_type"] == "ValueError"
