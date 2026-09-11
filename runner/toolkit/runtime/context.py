from __future__ import annotations

import time
import threading
from dataclasses import dataclass
from typing import Any

from .contracts import GuardContentBlock, PlanResolution


@dataclass(slots=True)
class CallContext:
    messages: tuple[dict[str, Any], ...]
    content_blocks: tuple[GuardContentBlock, ...]
    resolution: PlanResolution
    expires_at: float
    outcome: str = "allow"
    completion: dict[str, Any] | None = None


class CallContextStore:
    """Pin one immutable Policy Revision across an input/output call cycle."""

    def __init__(self, ttl_seconds: float = 300.0, max_entries: int = 10_000):
        self._ttl_seconds = ttl_seconds
        self._max_entries = max_entries
        self._items: dict[str, CallContext] = {}
        self._lock = threading.RLock()

    def put(
        self,
        call_id: str | None,
        messages: tuple[dict[str, Any], ...],
        resolution: PlanResolution,
        content_blocks: tuple[GuardContentBlock, ...] = (),
    ) -> None:
        if not call_id:
            return
        self.claim(call_id, messages, resolution, content_blocks)

    def claim(self, call_id, messages, resolution, content_blocks=()) -> CallContext:
        with self._lock:
            existing = self.get(call_id)
            if existing is not None:
                return existing
            self._prune()
            if len(self._items) >= self._max_entries:
                raise RuntimeError("Call context capacity exhausted; refusing to evict active assignments.")
            item = CallContext(messages=messages[-20:], content_blocks=content_blocks,
                               resolution=resolution, expires_at=time.monotonic() + self._ttl_seconds)
            if call_id:
                self._items[call_id] = item
            return item

    def get(self, call_id: str | None) -> CallContext | None:
        if not call_id:
            return None
        item = self._items.get(call_id)
        if not item:
            return None
        if item.expires_at <= time.monotonic():
            self._items.pop(call_id, None)
            return None
        return item

    def record_outcome(self, call_id, outcome):
        rank = {"allow": 0, "transform": 1, "intervene": 2, "block": 3, "error": 4, "timeout": 4}
        with self._lock:
            item = self.get(call_id)
            if item is None: return outcome
            if rank[outcome] > rank[item.outcome]: item.outcome = outcome
            return item.outcome

    def finish(self, call_id, event):
        with self._lock:
            item = self.get(call_id)
            if item is None: return event
            if item.completion is None: item.completion = event
            return item.completion

    def _prune(self) -> None:
        now = time.monotonic()
        for call_id, item in list(self._items.items()):
            if item.expires_at <= now:
                self._items.pop(call_id, None)
