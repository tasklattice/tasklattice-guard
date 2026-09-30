"""Opt-in real Redis tests; isolated loopback Redis only, no FLUSHDB.

GUARD_TEST_REDIS_URL=redis://127.0.0.1:<port>/0 pytest -q <this file>
Only this test's random stream state and lock keys are removed.
"""
import asyncio
import json
import os
from urllib.parse import urlparse
from uuid import uuid4

import pytest
import pytest_asyncio

from runner.output_streaming import RedisOutputStreamSessionStore
from runner.toolkit.runtime.contracts import ProtectionDecision
from tests.data_plane.test_output_streaming import request


@pytest_asyncio.fixture
async def replicas():
    url = os.environ.get("GUARD_TEST_REDIS_URL")
    if not url:
        pytest.skip("Set GUARD_TEST_REDIS_URL to an isolated loopback Redis for real lease tests.")
    assert urlparse(url).hostname in {"127.0.0.1", "localhost", "::1"}
    stores = [RedisOutputStreamSessionStore(url, window_characters=8) for _ in range(2)]
    stream_key = f"redis-regression-{uuid4()}"
    key = stores[0]._key(stream_key)
    try:
        await stores[0]._redis.ping()
        yield stores, stream_key, key
    finally:
        await stores[0]._redis.delete(key, f"{key}:lock")
        await asyncio.gather(*(store._redis.aclose() for store in stores))


@pytest.mark.asyncio
async def test_expired_owner_cannot_overwrite_a_new_replica_commit(replicas):
    stores, stream_key, key = replicas
    entered, resume = asyncio.Event(), asyncio.Event()

    async def slow(_candidate):
        entered.set()
        await resume.wait()
        return ProtectionDecision(decision="allow", action="allow")

    async def allow(_candidate):
        return ProtectionDecision(decision="allow", action="allow")

    args = dict(stream_key=stream_key, sequence=0, final=True, mode="full_buffered", request=request())
    stale = asyncio.create_task(stores[0].process(**args, text="old owner", evaluate=slow))
    try:
        await asyncio.wait_for(entered.wait(), 2)
        # Force a genuine Redis lease expiry while the evaluator is suspended;
        # no need to sleep for the production 120-second lock timeout.
        assert await stores[0]._redis.pexpire(f"{key}:lock", 1)
        async with asyncio.timeout(2):
            while await stores[0]._redis.exists(f"{key}:lock"):
                await asyncio.sleep(0.005)
        result = await stores[1].process(**args, text="new owner", evaluate=allow)
        assert result.released_text == "new owner"
        committed = await stores[1]._redis.get(key)
        resume.set()
        with pytest.raises(RuntimeError, match="lease expired before commit"):
            await asyncio.wait_for(stale, 2)
        # A release-time LockError alone is insufficient: the stale worker must
        # not already have overwritten the new owner's state before that error.
        assert await stores[1]._redis.get(key) == committed
        assert json.loads(committed)["released_text"] == "new owner"
    finally:
        resume.set()
        await asyncio.gather(stale, return_exceptions=True)


@pytest.mark.asyncio
async def test_cancelled_replica_releases_lock_and_other_replica_retries(replicas):
    stores, stream_key, key = replicas
    entered = asyncio.Event()

    async def slow(_candidate):
        entered.set()
        await asyncio.Event().wait()

    async def allow(candidate):
        assert candidate.texts == ("once",)
        return ProtectionDecision(decision="allow", action="allow")

    args = dict(stream_key=stream_key, sequence=0, text="once", final=True,
                mode="full_buffered", request=request())
    task = asyncio.create_task(stores[0].process(**args, evaluate=slow))
    try:
        await asyncio.wait_for(entered.wait(), 2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert not await stores[1]._redis.exists(f"{key}:lock")
        assert await stores[1]._redis.get(key) is None
        result = await stores[1].process(**args, evaluate=allow)
        assert result.released_text == "once" and result.next_sequence == 1
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_stale_owner_does_not_release_replacement_owners_lock(replicas):
    stores, stream_key, key = replicas
    entered = [asyncio.Event(), asyncio.Event()]
    resume = [asyncio.Event(), asyncio.Event()]

    async def evaluate(index, _candidate):
        entered[index].set()
        await resume[index].wait()
        return ProtectionDecision(decision="allow", action="allow")

    args = dict(stream_key=stream_key, sequence=0, final=True, mode="full_buffered", request=request())
    first = asyncio.create_task(stores[0].process(**args, text="old", evaluate=lambda req: evaluate(0, req)))
    second = None
    try:
        await asyncio.wait_for(entered[0].wait(), 2)
        assert await stores[0]._redis.pexpire(f"{key}:lock", 1)
        async with asyncio.timeout(2):
            while await stores[0]._redis.exists(f"{key}:lock"):
                await asyncio.sleep(0.005)
        second = asyncio.create_task(stores[1].process(**args, text="new", evaluate=lambda req: evaluate(1, req)))
        await asyncio.wait_for(entered[1].wait(), 2)
        replacement_token = await stores[1]._redis.get(f"{key}:lock")
        assert replacement_token
        resume[0].set()
        with pytest.raises(RuntimeError, match="lease expired before commit"):
            await asyncio.wait_for(first, 2)
        assert await stores[1]._redis.get(f"{key}:lock") == replacement_token
        assert await stores[1]._redis.get(key) is None
        resume[1].set()
        result = await asyncio.wait_for(second, 2)
        assert result.released_text == "new"
    finally:
        for event in resume:
            event.set()
        await asyncio.gather(first, *([second] if second else []), return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["full_buffered", "window_buffered", "interruptible"])
async def test_real_redis_replica_handoff_preserves_exact_checked_output_and_ttl(replicas, mode):
    stores, stream_key, key = replicas
    seen = []

    async def evaluate(candidate):
        seen.append(candidate.texts[0])
        return ProtectionDecision(decision="transform", action="transform",
                                  texts=(candidate.texts[0].replace("secret", "[REDACTED]"),))

    args = dict(stream_key=stream_key, mode=mode, request=request(), evaluate=evaluate)
    first = await stores[0].process(**args, sequence=0, text="hello ", final=False)
    last = await stores[1].process(**args, sequence=1, text="secret", final=True)
    assert first.released_text + last.released_text == "hello [REDACTED]"
    assert last.next_sequence == 2 and last.status == "completed"
    assert seen[-1] == "hello secret"
    state = json.loads(await stores[0]._redis.get(key))
    assert state["released_text"] == "hello [REDACTED]" and state["complete"]
    assert 0 < await stores[0]._redis.ttl(key) <= 300
    with pytest.raises(ValueError, match="already complete"):
        await stores[0].process(**args, sequence=2, text="again", final=True)
