"""Coalesce only the calls in one compiler-proven, read-only execution group."""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
import time
from typing import TYPE_CHECKING, Callable

if TYPE_CHECKING:
    from .builtin_laya import BuiltinLaya
    from .model_validation_diagnostics import LocalModelCapture


MAX_BATCH_QUESTIONS = 16
MAX_BATCH_CALLS = 8


@dataclass(frozen=True)
class LayaInput:
    state: str | dict[str, object]
    questions: dict[str, dict[str, object]]
    max_len: int
    head_max_len: int


@dataclass
class LayaBatchCall:
    runtime: BuiltinLaya
    input: LayaInput
    deadline: float
    capture: LocalModelCapture | None
    on_queue: Callable[[int, bool], None]
    future: asyncio.Future
    submitted_at: float = field(default_factory=time.monotonic)
    recorded: bool = False

    def queued(self, milliseconds: int, sent: bool) -> None:
        if not self.recorded:
            self.recorded = True
            self.on_queue(max(milliseconds, round((time.monotonic() - self.submitted_at) * 1000)), sent)


class _LayaBatch:
    def __init__(self):
        self.pending: list[LayaBatchCall] = []
        self.flush_handle: asyncio.Handle | None = None
        self.jobs: set[asyncio.Task] = set()
        self.closed = False

    async def submit(self, call: LayaBatchCall) -> dict:
        self.pending.append(call)
        if self.flush_handle is None:
            # Sibling Actions enter inference in the same event-loop turn.
            # No timer or cross-request batching window is introduced.
            self.flush_handle = asyncio.get_running_loop().call_soon(self.flush)
        try:
            async with asyncio.timeout(max(0, call.deadline - time.monotonic())):
                return await asyncio.shield(call.future)
        finally:
            if not call.future.done():
                call.future.cancel()
            elif not call.future.cancelled():
                call.future.exception()  # Also consume a rejection raced by caller cancellation.
            if not call.recorded:
                call.queued(0, False)

    def flush(self):
        self.flush_handle = None
        pending, self.pending = self.pending, []
        batches: dict[tuple, list[list[LayaBatchCall]]] = {}
        for call in pending:
            if call.future.done():
                continue
            key = (call.runtime, call.input.max_len, call.input.head_max_len)
            groups = batches.setdefault(key, [[]])
            group = groups[-1]
            if group and (len(group) >= MAX_BATCH_CALLS or
                          sum(len(c.input.questions) for c in group) + len(call.input.questions) > MAX_BATCH_QUESTIONS):
                group = []
                groups.append(group)
            group.append(call)
        for groups in batches.values():
            for group in groups:
                task = asyncio.create_task(self.run(group), name="laya-primary-batch")
                self.jobs.add(task)
                task.add_done_callback(self.jobs.discard)

    async def run(self, calls: list[LayaBatchCall]):
        try:
            results = await calls[0].runtime.predict_batch(calls)
        except asyncio.CancelledError:
            for call in calls:
                call.future.cancel()
            raise
        except Exception as error:
            for call in calls:
                if not call.future.done():
                    call.future.set_exception(error)
        else:
            for call, result in zip(calls, results, strict=True):
                if not call.future.done():
                    if isinstance(result, Exception):
                        call.future.set_exception(result)
                    else:
                        call.future.set_result(result)

    def close(self):
        self.closed = True
        if self.flush_handle is not None:
            self.flush_handle.cancel()
        for call in self.pending:
            call.future.cancel()
        self.pending.clear()
        for job in self.jobs:
            job.cancel()


_CURRENT: ContextVar[_LayaBatch | None] = ContextVar("laya_primary_batch", default=None)


def current_laya_batch() -> _LayaBatch | None:
    batch = _CURRENT.get()
    return batch if batch is not None and not batch.closed else None


@contextmanager
def laya_batch_scope():
    batch = _LayaBatch()
    token = _CURRENT.set(batch)
    try:
        yield
    finally:
        batch.close()
        _CURRENT.reset(token)
