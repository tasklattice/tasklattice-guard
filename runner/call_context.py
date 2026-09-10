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
                "trace": [asdict(item) for item in resolution.trace],
            },
        }
        self._redis.setex(self._key(call_id), self._ttl_seconds, json.dumps(payload, separators=(",", ":")))

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
                # Resolution trace is informational. The immutable router
                # and plan pin are the consistency contract across replicas.
                trace=(),
            ),
            expires_at=time.monotonic() + self._ttl_seconds,
        )

    @staticmethod
    def _key(call_id: str) -> str:
        digest = hashlib.sha256(call_id.encode()).hexdigest()
        return f"tasklattice:guard:call-context:{digest}"
