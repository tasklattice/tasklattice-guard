"""Probe-timeout diagnostics that can report while the asyncio loop is blocked."""
from __future__ import annotations

import asyncio
import json
import logging
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import psutil
from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram


# Uvicorn configures this logger at INFO even when the root logger is WARNING.
logger = logging.getLogger("uvicorn.error.tasklattice.diagnostics")
_phases: dict[object, dict[str, object]] = {}
_phase_lock = threading.Lock()


def _log(event: str, *, level: int = logging.INFO, **fields: object) -> None:
    logger.log(level, "%s", json.dumps({"event": event, **fields}, sort_keys=True))


@contextmanager
def diagnostic_phase(phase: str, **metadata: str | int | bool) -> Iterator[None]:
    """Track infrequent lifecycle work; callers supply IDs/counts, never payloads."""
    key = object()
    started = time.monotonic()
    detail = {"phase": phase, "thread_id": threading.get_ident(), **metadata}
    with _phase_lock:
        _phases[key] = {**detail, "started": started}
    _log("runner_phase_started", **detail)
    result = "success"
    try:
        yield
    except BaseException as error:
        result = "cancelled" if isinstance(error, asyncio.CancelledError) else "error"
        detail["error_type"] = type(error).__name__
        raise
    finally:
        with _phase_lock:
            _phases.pop(key, None)
        _log("runner_phase_finished", **detail, result=result,
             duration_ms=round((time.monotonic() - started) * 1_000))


def _active_phases(now: float) -> list[dict[str, object]]:
    with _phase_lock:
        return [{**{key: value for key, value in phase.items() if key != "started"},
                 "elapsed_ms": round((now - phase["started"]) * 1_000)}
                for phase in _phases.values()]


def _thread_stacks(thread_ids: set[int]) -> dict[str, list[dict[str, object]]]:
    stacks = {}
    frames = sys._current_frames()
    for thread_id in thread_ids:
        frame = frames.get(thread_id)
        stack = []
        while frame is not None and len(stack) < 32:
            # No source lines, locals, request content, or credentials.
            stack.append({"file": frame.f_code.co_filename,
                          "line": frame.f_lineno, "function": frame.f_code.co_name})
            frame = frame.f_back
        stacks[str(thread_id)] = list(reversed(stack))
    return stacks


def _resources() -> dict[str, object]:
    """Best effort; cgroup v2 fields are absent outside Linux containers."""
    result: dict[str, object] = {}
    try:
        process = psutil.Process()
        cpu = process.cpu_times()
        result.update(rss_bytes=process.memory_info().rss,
                      process_cpu_seconds=round(cpu.user + cpu.system, 3),
                      threads=process.num_threads())
    except psutil.Error:
        pass
    for name in ("cpu.max", "cpu.stat", "memory.current", "memory.max", "memory.events"):
        try:
            result[name] = (Path("/sys/fs/cgroup") / name).read_text().strip()
        except OSError:
            pass
    return result


class EventLoopWatchdog:
    """Sample loop progress from a separate thread, without any runtime locks."""

    def __init__(self, registry: CollectorRegistry, *, runner_id: str,
                 interval: float = 0.5, stall_threshold: float = 2.0,
                 warning_interval: float = 30.0) -> None:
        self._runner_id = runner_id
        self._interval = interval
        self._stall_threshold = stall_threshold
        self._warning_interval = warning_interval
        self._stop = threading.Event()
        self._last_tick = 0.0
        self._loop_thread_id = 0
        self._task: asyncio.Task[None] | None = None
        self._thread: threading.Thread | None = None
        self._lag = Gauge("guard_runner_event_loop_lag_seconds",
                          "Current delay beyond the expected event-loop tick.", registry=registry)
        self._stalls = Counter("guard_runner_event_loop_stalls_total",
                               "Event-loop stalls detected by the watchdog thread.", registry=registry)
        self._delay = Histogram("guard_runner_event_loop_delay_seconds",
                                "Event-loop scheduling delay, recorded on each completed tick.",
                                buckets=(.01, .05, .1, .25, .5, 1, 2, 5, 10, 20, 60), registry=registry)

    def start(self) -> None:
        self._last_tick = time.monotonic()
        self._loop_thread_id = threading.get_ident()
        self._stop.clear()
        self._task = asyncio.create_task(self._tick(), name="runner-loop-tick")
        self._thread = threading.Thread(target=self._watch, name="runner-loop-watchdog", daemon=True)
        self._thread.start()
        _log("runner_watchdog_started", runner_id=self._runner_id,
             stall_threshold_seconds=self._stall_threshold, warning_interval_seconds=self._warning_interval)

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
        if self._thread is not None:
            await asyncio.to_thread(self._thread.join, 2)

    async def _tick(self) -> None:
        while True:
            await asyncio.sleep(self._interval)
            now = time.monotonic()
            delay = max(0.0, now - self._last_tick - self._interval)
            self._delay.observe(delay)
            self._last_tick = now
            # A C extension holding the GIL can also prevent the watchdog from
            # running. Always retain completed long delays after loop recovery.
            if delay >= self._stall_threshold:
                _log("runner_event_loop_delayed", level=logging.WARNING,
                     runner_id=self._runner_id, delay_ms=round(delay * 1_000))

    def _watch(self) -> None:
        stalled_tick: float | None = None
        warned_at = 0.0
        while not self._stop.wait(self._interval):
            now = time.monotonic()
            tick = self._last_tick
            lag = max(0.0, now - tick - self._interval)
            self._lag.set(lag)
            if stalled_tick is not None and tick != stalled_tick:
                _log("runner_event_loop_recovered", runner_id=self._runner_id,
                     delay_ms=round((tick - stalled_tick - self._interval) * 1_000))
                stalled_tick = None
            if lag < self._stall_threshold:
                continue
            first_warning = stalled_tick is None
            if first_warning:
                stalled_tick = tick
                self._stalls.inc()
            if first_warning or now - warned_at >= self._warning_interval:
                warned_at = now
                phases = _active_phases(now)
                thread_ids = {self._loop_thread_id, *(int(phase["thread_id"]) for phase in phases)}
                _log("runner_event_loop_stalled", level=logging.WARNING,
                     runner_id=self._runner_id, delay_ms=round(lag * 1_000),
                     loop_thread_id=self._loop_thread_id, active_phases=phases,
                     stacks=_thread_stacks(thread_ids), resources=_resources())
