from __future__ import annotations

import asyncio
from contextvars import ContextVar
import threading

import pytest

from runner.preparation import prepare


async def test_preparation_serializes_jobs_and_drains_repeated_cancellation():
    entered, release = threading.Event(), threading.Event()
    second_started = threading.Event()
    value = ContextVar("preparation-test", default="missing")
    value.set("request-context")
    cleaned = []

    def first():
        entered.set()
        assert release.wait(3)
        return value.get()

    async def cleanup(result):
        cleaned.append(result)

    first_task = asyncio.create_task(prepare(first, on_cancel=cleanup))
    try:
        assert await asyncio.to_thread(entered.wait, 3)
        second_task = asyncio.create_task(prepare(lambda: second_started.set()))
        first_task.cancel()
        await asyncio.sleep(.01)
        first_task.cancel()
        await asyncio.sleep(.01)
        assert not first_task.done() and not second_started.is_set()
    finally:
        release.set()
    with pytest.raises(asyncio.CancelledError):
        await first_task
    await second_task
    assert cleaned == ["request-context"]
    assert second_started.is_set()
