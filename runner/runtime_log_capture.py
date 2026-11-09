"""Short-lived, encrypted body candidates for whole-call capture decisions.

Audit events are delivered immediately. Candidates only enter the telemetry WAL
when the call qualifies; Redis shares that decision across Runner replicas.
"""
from __future__ import annotations

import copy
import hashlib
import json
import time
from collections.abc import Callable
from typing import Any

from redis.asyncio import Redis
from redis.exceptions import WatchError, OutOfMemoryError


class RuntimeLogCapture:
    def __init__(self, redis_url: str | None = None, *, ttl_seconds: int = 300,
                 max_entries: int = 10_000, max_call_bytes: int = 8 * 1024 * 1024,
                 max_memory_bytes: int = 64 * 1024 * 1024, on_capacity: Callable[[], None] | None = None):
        self._redis = Redis.from_url(redis_url, decode_responses=True,
                                     socket_connect_timeout=1, socket_timeout=1) if redis_url else None
        self._ttl = ttl_seconds
        self._max_entries = max_entries
        self._max_call_bytes = max_call_bytes
        self._max_memory_bytes = max_memory_bytes
        self._items: dict[str, dict[str, Any]] = {}
        self._sizes: dict[str, int] = {}
        self._memory_bytes = 0
        self._next_prune = 0.0
        self._on_capacity = on_capacity

    @staticmethod
    def key(endpoint_id, guardrail_id, protocol, call_id) -> str:
        scope = [endpoint_id, guardrail_id, protocol.removesuffix("-stream"), call_id]
        return "tasklattice:guard:log-capture:" + hashlib.sha256(json.dumps(scope).encode()).hexdigest()

    async def level(self, key: str, configured: str) -> str:
        return await self._mutate(key, configured, lambda state: state["level"])

    async def record(self, key: str, level: str, event: dict, selected: bool) -> tuple[bool, list[dict], bool]:
        def update(state):
            state["selected"] |= selected
            if level == "debug":
                encoded = json.dumps(event, separators=(",", ":"))
                old = state["pending"].get(event["id"], "")
                size = sum(len(value.encode()) for value in state["pending"].values())
                if size - len(old.encode()) + len(encoded.encode()) <= self._max_call_bytes:
                    state["pending"][event["id"]] = encoded
                else:
                    state["incomplete"] = True
            return state["selected"], [json.loads(value) for value in state["pending"].values()] if state["selected"] else [], state["incomplete"]
        return await self._mutate(key, level, update)

    async def acknowledge(self, key: str, level: str, event_ids: list[str]) -> None:
        # Only remove candidates after their enriched events reach the durable WAL.
        def update(state):
            for event_id in event_ids:
                state["pending"].pop(event_id, None)
        await self._mutate(key, level, update)

    def _new(self, level):
        return {"level": level, "selected": False, "pending": {}, "incomplete": False,
                "expires": time.time() + self._ttl}

    async def _mutate(self, key: str, level: str, update: Callable):
        if self._redis is not None:
            for _ in range(20):
                async with self._redis.pipeline() as pipe:
                    try:
                        await pipe.watch(key)
                        raw = await pipe.get(key)
                        state = json.loads(raw) if raw else self._new(level)
                        result = update(state)
                        pipe.multi()
                        pipe.set(key, json.dumps(state, separators=(",", ":")),
                                 px=max(1, int((state["expires"] - time.time()) * 1000)))
                        await pipe.execute()
                        return result
                    except WatchError:
                        continue
                    except OutOfMemoryError:
                        if self._on_capacity is not None:
                            self._on_capacity()
                        # The API preserves the current audit event and marks
                        # callCaptureIncomplete; never move buffering into RAM.
                        raise
            raise RuntimeError("Runtime log capture contention exceeded its retry limit.")

        now = time.time()
        if now >= self._next_prune:
            self.prune()
        existing = self._items.get(key)
        if existing is None and len(self._items) >= self._max_entries:
            raise RuntimeError("Runtime log capture capacity exhausted.")
        state = copy.deepcopy(existing) if existing and existing["expires"] > now else self._new(level)
        result = update(state)
        size = len(json.dumps(state).encode())
        if self._memory_bytes - self._sizes.get(key, 0) + size > self._max_memory_bytes:
            raise RuntimeError("Runtime log capture memory budget exhausted.")
        self._memory_bytes += size - self._sizes.get(key, 0)
        self._items[key], self._sizes[key] = state, size
        return result

    def prune(self):
        now = time.time()
        for identity, state in list(self._items.items()):
            if state["expires"] <= now:
                self._items.pop(identity)
                self._memory_bytes -= self._sizes.pop(identity, 0)
        self._next_prune = now + min(30, self._ttl)

    async def close(self):
        if self._redis is not None:
            await self._redis.aclose()
