from __future__ import annotations

import hashlib
import base64
import json
import time
import zlib
from dataclasses import asdict
from typing import Any

from redis import Redis
from redis.exceptions import OutOfMemoryError

from runner.toolkit.runtime.context import CallContext
from runner.toolkit.runtime.contracts import GuardContentBlock, PlanResolution

from .serialization import plan_from_dict
from .context_capacity import ContextCapacity


_PLAN_CODEC = "zlib-base64-v1"
_MAX_COMPRESSED_PLAN_BYTES = 64 * 1024 * 1024


def _encode_plan(plan: dict[str, Any], compress: bool) -> dict[str, Any]:
    """Compress only the immutable plan; Lua still updates the JSON envelope."""
    if not compress:
        return {"plan": plan}
    raw = json.dumps(plan, separators=(",", ":")).encode()
    # Keep small/non-compressible plans and plans above the compression limit readable as-is.
    if len(raw) < 4096 or len(raw) > _MAX_COMPRESSED_PLAN_BYTES:
        return {"plan": plan}
    encoded = base64.b64encode(zlib.compress(raw, level=1)).decode("ascii")
    if len(encoded) >= len(raw):
        return {"plan": plan}
    return {"plan_encoding": _PLAN_CODEC, "plan_encoded": encoded}


def _decode_plan(resolution: dict[str, Any]) -> dict[str, Any]:
    if "plan_encoding" not in resolution:
        return resolution["plan"]  # Calls created before the rollout remain pinned.
    if resolution["plan_encoding"] != _PLAN_CODEC or "plan" in resolution:
        raise ValueError("Unsupported or ambiguous call-context plan encoding")
    encoded = resolution["plan_encoded"]
    if not isinstance(encoded, str) or len(encoded) > _MAX_COMPRESSED_PLAN_BYTES * 2:
        raise ValueError("Invalid encoded call-context plan size")
    data = base64.b64decode(encoded, validate=True)
    decoder = zlib.decompressobj()
    raw = decoder.decompress(data, _MAX_COMPRESSED_PLAN_BYTES + 1)
    if len(raw) > _MAX_COMPRESSED_PLAN_BYTES or not decoder.eof or decoder.unused_data:
        raise ValueError("Invalid or oversized compressed call-context plan")
    plan = json.loads(raw)
    if not isinstance(plan, dict):
        raise ValueError("Call-context plan must be an object")
    return plan


class RedisCallContextStore:
    """Share input/output version pinning across horizontally scaled Runners."""

    def __init__(self, url: str, ttl_seconds: int = 300, *, compress_plans: bool = False,
                 capacity_fallback: bool = False, metrics_registry=None) -> None:
        self._redis: Redis = Redis.from_url(url, decode_responses=True,
                                          socket_connect_timeout=1, socket_timeout=1)
        self._ttl_seconds = ttl_seconds
        self._compress_plans = compress_plans
        self.capacity = ContextCapacity(self._redis, enabled=capacity_fallback, registry=metrics_registry)

    def begin_request(self):
        self.capacity.begin()

    def degraded_reason(self):
        return self.capacity.reason.get()

    def context_history_available(self):
        return self.capacity.history_available.get()

    def _oom(self, operation, error):
        if not self.capacity.enabled:
            raise error
        self.capacity.degrade(operation)

    def put(
        self,
        call_id: str | None,
        messages: tuple[dict[str, Any], ...],
        resolution: PlanResolution,
        content_blocks: tuple[GuardContentBlock, ...] = (),
    ) -> None:
        if not call_id or self.degraded_reason():
            return
        payload = {
            "messages": messages[-20:],
            "content_blocks": [asdict(item) for item in content_blocks],
            "resolution": {
                **_encode_plan(asdict(resolution.plan), self._compress_plans),
                "router_id": resolution.router_id,
                "endpoint_id": resolution.endpoint_id,
                "effective_release_id": resolution.effective_release_id,
                "model_revision_id": resolution.model_revision_id,
                "route_assignment": resolution.route_assignment,
                "trace": [asdict(item) for item in resolution.trace],
            },
        }
        try:
            self._redis.set(self._key(call_id), json.dumps(payload, separators=(",", ":")), ex=self._ttl_seconds, nx=True)
        except OutOfMemoryError as error:
            self._oom("write", error)

    def get(self, call_id: str | None) -> CallContext | None:
        if not call_id:
            return None
        raw = self._redis.get(self._key(call_id))
        if not isinstance(raw, str):
            if self.capacity.exhausted():
                self.capacity.degrade("lookup")
            return None
        payload = json.loads(raw)
        resolution = payload["resolution"]
        context = CallContext(
            messages=tuple(payload.get("messages", ())),
            content_blocks=tuple(GuardContentBlock(**item) for item in payload.get("content_blocks", ())),
            resolution=PlanResolution(
                plan=plan_from_dict(_decode_plan(resolution)),
                router_id=resolution["router_id"],
                endpoint_id=resolution.get("endpoint_id"),
                effective_release_id=resolution.get("effective_release_id"),
                model_revision_id=resolution.get("model_revision_id"),
                route_assignment=resolution.get("route_assignment"),
                # Resolution trace is informational. The immutable router
                # and plan pin are the consistency contract across replicas.
                trace=(),
            ),
            outcome=payload.get("outcome", "allow"),
            completion=payload.get("completion"),
            expires_at=time.monotonic() + self._ttl_seconds,
        )
        self.capacity.history_available.set(True)
        return context

    def claim(self, call_id, messages, resolution, content_blocks=()) -> CallContext:
        if not call_id or self.degraded_reason():
            return CallContext(messages=messages, content_blocks=content_blocks,
                               resolution=resolution, expires_at=time.monotonic() + self._ttl_seconds)
        self.put(call_id, messages, resolution, content_blocks)
        item = self.get(call_id)
        if item is None:
            if self.degraded_reason():
                return CallContext(messages=messages, content_blocks=content_blocks,
                                   resolution=resolution, expires_at=time.monotonic() + self._ttl_seconds)
            raise RuntimeError("Atomic call context claim expired; retry with a new call.")
        return item

    def record_outcome(self, call_id, outcome):
        if not call_id or self.degraded_reason(): return outcome
        try:
            return self._redis.eval("""
            local raw = redis.call('GET', KEYS[1])
            if not raw then return ARGV[1] end
            local p = cjson.decode(raw)
            local ranks = {allow=0, transform=1, intervene=2, block=3, error=4, timeout=4}
            if ranks[ARGV[1]] > ranks[p.outcome or 'allow'] then p.outcome = ARGV[1] end
            redis.call('SET', KEYS[1], cjson.encode(p), 'KEEPTTL')
            return p.outcome or 'allow'
        """, 1, self._key(call_id), outcome)
        except OutOfMemoryError as error:
            self._oom("outcome", error)
            old = self.get(call_id)
            ranks = {"allow": 0, "transform": 1, "intervene": 2, "block": 3, "error": 4, "timeout": 4}
            return max((old.outcome if old else "allow", outcome), key=ranks.__getitem__)

    def finish(self, call_id, event):
        if not call_id or self.degraded_reason(): return event
        try:
            raw = self._redis.eval("""
            local raw = redis.call('GET', KEYS[1])
            if not raw then return ARGV[1] end
            local p = cjson.decode(raw)
            if not p.completion then p.completion = cjson.decode(ARGV[1]) end
            redis.call('SET', KEYS[1], cjson.encode(p), 'KEEPTTL')
            return cjson.encode(p.completion)
        """, 1, self._key(call_id), json.dumps(event))
            return json.loads(raw)
        except OutOfMemoryError as error:
            self._oom("completion", error)
            old = self.get(call_id)
            return old.completion if old and old.completion else event

    @staticmethod
    def _key(call_id: str) -> str:
        digest = hashlib.sha256(call_id.encode()).hexdigest()
        return f"tasklattice:guard:call-context:{digest}"
