from __future__ import annotations

import hashlib
import json
import time
from dataclasses import asdict
from typing import Any

from redis import Redis

from runner.toolkit.runtime.context import CallContext
from runner.toolkit.runtime.contracts import GuardContentBlock, PlanResolution

from .serialization import plan_from_dict


class RedisCallContextStore:
    """Share input/output version pinning across horizontally scaled Runners."""

    def __init__(self, url: str, ttl_seconds: int = 300) -> None:
        self._redis: Redis = Redis.from_url(url, decode_responses=True)
        self._ttl_seconds = ttl_seconds

    def put(
        self,
        call_id: str | None,
        messages: tuple[dict[str, Any], ...],
        resolution: PlanResolution,
        content_blocks: tuple[GuardContentBlock, ...] = (),
    ) -> None:
        if not call_id:
            return
        payload = {
            "messages": messages[-20:],
            "content_blocks": [asdict(item) for item in content_blocks],
            "resolution": {
                "plan": asdict(resolution.plan),
                "router_id": resolution.router_id,
                "endpoint_id": resolution.endpoint_id,
                "effective_release_id": resolution.effective_release_id,
                "model_revision_id": resolution.model_revision_id,
                "route_assignment": resolution.route_assignment,
                "trace": [asdict(item) for item in resolution.trace],
            },
        }
        self._redis.set(self._key(call_id), json.dumps(payload, separators=(",", ":")), ex=self._ttl_seconds, nx=True)

    def get(self, call_id: str | None) -> CallContext | None:
        if not call_id:
            return None
        raw = self._redis.get(self._key(call_id))
        if not isinstance(raw, str):
            return None
        payload = json.loads(raw)
        resolution = payload["resolution"]
        return CallContext(
            messages=tuple(payload.get("messages", ())),
            content_blocks=tuple(GuardContentBlock(**item) for item in payload.get("content_blocks", ())),
            resolution=PlanResolution(
                plan=plan_from_dict(resolution["plan"]),
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

    def claim(self, call_id, messages, resolution, content_blocks=()) -> CallContext:
        if not call_id:
            return CallContext(messages=messages, content_blocks=content_blocks,
                               resolution=resolution, expires_at=time.monotonic() + self._ttl_seconds)
        self.put(call_id, messages, resolution, content_blocks)
        item = self.get(call_id)
        if item is None:
            raise RuntimeError("Atomic call context claim expired; retry with a new call.")
        return item

    def record_outcome(self, call_id, outcome):
        if not call_id: return outcome
        return self._redis.eval("""
            local raw = redis.call('GET', KEYS[1])
            if not raw then return ARGV[1] end
            local p = cjson.decode(raw)
            local ranks = {allow=0, transform=1, intervene=2, block=3, error=4, timeout=4}
            if ranks[ARGV[1]] > ranks[p.outcome or 'allow'] then p.outcome = ARGV[1] end
            redis.call('SET', KEYS[1], cjson.encode(p), 'KEEPTTL')
            return p.outcome or 'allow'
        """, 1, self._key(call_id), outcome)

    def finish(self, call_id, event):
        if not call_id: return event
        raw = self._redis.eval("""
            local raw = redis.call('GET', KEYS[1])
            if not raw then return ARGV[1] end
            local p = cjson.decode(raw)
            if not p.completion then p.completion = cjson.decode(ARGV[1]) end
            redis.call('SET', KEYS[1], cjson.encode(p), 'KEEPTTL')
            return cjson.encode(p.completion)
        """, 1, self._key(call_id), json.dumps(event))
        return json.loads(raw)

    @staticmethod
    def _key(call_id: str) -> str:
        digest = hashlib.sha256(call_id.encode()).hexdigest()
        return f"tasklattice:guard:call-context:{digest}"
