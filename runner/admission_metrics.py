"""Operational admission metrics, labeled only with configured trusted tenants."""
from __future__ import annotations

from typing import Mapping
import copy
import time
from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram


class TenantAdmissionMetrics:
    def __init__(self, registry: CollectorRegistry, capacity: int, limits: Mapping[str, int]):
        if len(limits) > 1000:
            raise ValueError("Admission monitoring supports at most 1000 configured tenants per Runner.")
        self._tenants = frozenset(limits)
        self._capacity = capacity
        self._snapshot = ({tenant: {"tenantId": tenant, "active": 0, "queued": 0, "limit": limit,
            "outcomes": {outcome: 0 for outcome in ("admitted", "queue_full", "queue_timeout", "rate_limited", "cancelled", "unavailable")},
            "wait": {"buckets": [0] * 15, "count": 0, "totalSeconds": 0.0},
            "held": {"buckets": [0] * 15, "count": 0, "totalSeconds": 0.0}}
            for tenant, limit in limits.items()} if len(limits) <= 64 else None)
        self.active = Gauge("guard_runner_tenant_admission_active", "Locally held Endpoint permits, including Redis admission waits.", ["tenant_id"], registry=registry)
        self.queued = Gauge("guard_runner_tenant_admission_queued", "Endpoint requests waiting in this Runner's local admission queue.", ["tenant_id"], registry=registry)
        self.limit = Gauge("guard_runner_tenant_admission_limit", "Configured per-tenant local permit cap; not reserved capacity.", ["tenant_id"], registry=registry)
        self.capacity = Gauge("guard_runner_tenant_admission_capacity", "Total local Endpoint permit capacity.", registry=registry)
        self.attempts = Counter("guard_runner_tenant_admission_attempts_total", "Authenticated Endpoint admission outcomes.", ["tenant_id", "outcome"], registry=registry)
        buckets = (0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60)
        self.wait = Histogram("guard_runner_tenant_admission_wait_seconds", "Time from trusted owner resolution to admission outcome, including local queue and Redis waits.", ["tenant_id", "outcome"], buckets=buckets, registry=registry)
        self.held = Histogram("guard_runner_tenant_admission_held_seconds", "Time a local permit was held, including Redis waits and route cleanup; excludes local queue wait.", ["tenant_id"], buckets=buckets, registry=registry)
        self.capacity.set(capacity)
        for tenant, limit in limits.items():
            self.limit.labels(tenant).set(limit)
            self.active.labels(tenant).set(0)
            self.queued.labels(tenant).set(0)

    def state(self, tenant: str, active: int, queued: int) -> None:
        if tenant in self._tenants:
            if self._snapshot is not None:
                self._snapshot[tenant].update(active=active, queued=queued)
            self.active.labels(tenant).set(active)
            self.queued.labels(tenant).set(queued)

    def outcome(self, tenant: str, outcome: str, seconds: float) -> None:
        if tenant in self._tenants:
            bounded = outcome if outcome in {"admitted", "queue_full", "queue_timeout", "rate_limited", "cancelled", "unavailable"} else "unavailable"
            if self._snapshot is not None:
                self._snapshot[tenant]["outcomes"][bounded] += 1
                if bounded == "admitted":
                    self._observe(self._snapshot[tenant]["wait"], max(0, seconds))
            self.attempts.labels(tenant, bounded).inc()
            self.wait.labels(tenant, bounded).observe(max(0, seconds))

    def released(self, tenant: str, seconds: float) -> None:
        if tenant in self._tenants:
            if self._snapshot is not None:
                self._observe(self._snapshot[tenant]["held"], max(0, seconds))
            self.held.labels(tenant).observe(max(0, seconds))

    @staticmethod
    def _observe(histogram, seconds: float) -> None:
        bounds = (0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, float("inf"))
        histogram["count"] += 1
        histogram["totalSeconds"] += seconds
        for index, bound in enumerate(bounds):
            if seconds <= bound:
                histogram["buckets"][index] += 1

    def snapshot(self) -> dict:
        """Bounded process-local measurements, called on the admission event loop.

        Larger configurations remain enforced; monitoring explicitly refuses a
        partial map. This authority-free diagnostic never changes permit state.
        """
        if self._snapshot is None:
            return {"version": 1, "available": False, "reason": "cardinality_limit"}
        return {"version": 1, "available": True, "capacity": self._capacity,
                "monotonicSeconds": time.monotonic(), "tenants": copy.deepcopy(list(self._snapshot.values()))}
