"""Bounded Redis capacity observations; no payloads or keys in metrics."""
from contextvars import ContextVar
import time

from prometheus_client import Counter
from prometheus_client.core import GaugeMetricFamily
from redis.exceptions import RedisError


class ContextCapacity:
    def __init__(self, redis, *, enabled=False, registry=None):
        self.redis = redis
        self.enabled = enabled
        self.reason = ContextVar("guard_context_capacity", default=None)
        self.history_available = ContextVar("guard_context_history", default=False)
        self._checked_at = 0.0
        self._memory = {}
        self.events = (Counter("guard_runner_context_degraded_total",
            "Context operations skipped because Redis cannot allocate memory.",
            ["operation", "reason"], registry=registry) if registry is not None else None)
        if self.events is not None:
            for operation in ("lookup", "write", "outcome", "completion", "log_capture"):
                self.events.labels(operation=operation, reason="redis_capacity")
        if registry is not None:
            registry.register(self)

    def begin(self):
        self.reason.set(None)
        self.history_available.set(False)

    def observe(self, operation):
        if self.events is not None:
            self.events.labels(operation=operation, reason="redis_capacity").inc()

    def degrade(self, operation):
        self.reason.set("redis_capacity")
        self.observe(operation)
        self._checked_at = 0.0

    def memory(self, *, fresh=False):
        now = time.monotonic()
        if fresh or now - self._checked_at >= 1:
            self._memory = self.redis.info("memory")
            self._checked_at = now
        return self._memory

    def exhausted(self):
        if not self.enabled:
            return False
        info = self.memory()
        limit = int(info.get("maxmemory", 0))
        used = int(info.get("used_memory", 0)) - int(info.get("mem_not_counted_for_evict", 0))
        return limit > 0 and used >= limit

    def describe(self):
        # Avoid a Redis round trip while registering the collector.
        for name in ("up", "used_memory_bytes", "maxmemory_bytes"):
            yield GaugeMetricFamily("guard_runner_context_redis_" + name, "Shared context Redis capacity.")

    def collect(self):
        try:
            info = self.memory(fresh=True)
        except RedisError:
            yield GaugeMetricFamily("guard_runner_context_redis_up", "Redis INFO is available.", value=0)
            return
        yield GaugeMetricFamily("guard_runner_context_redis_up", "Redis INFO is available.", value=1)
        for name, field in (("used_memory_bytes", "used_memory"), ("maxmemory_bytes", "maxmemory")):
            yield GaugeMetricFamily("guard_runner_context_redis_" + name, "Shared context Redis capacity.",
                                    value=int(info.get(field, 0)))
