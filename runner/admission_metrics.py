"""Operational admission metrics, labeled only with configured trusted projects."""
from __future__ import annotations

from typing import Mapping
import copy
import time
from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram


class ProjectAdmissionMetrics:
    def __init__(self, registry: CollectorRegistry, capacity: int, limits: Mapping[str, int]):
        if len(limits) > 1000:
            raise ValueError("Admission monitoring supports at most 1000 configured projects per Runner.")
        self._projects = frozenset(limits)
        self._capacity = capacity
        self._snapshot = ({project: {"projectId": project, "active": 0, "queued": 0, "limit": limit,
            "outcomes": {outcome: 0 for outcome in ("admitted", "queue_full", "queue_timeout", "rate_limited", "cancelled", "unavailable")},
            "wait": {"buckets": [0] * 15, "count": 0, "totalSeconds": 0.0},
            "held": {"buckets": [0] * 15, "count": 0, "totalSeconds": 0.0}}
            for project, limit in limits.items()} if len(limits) <= 64 else None)
        self.active = Gauge("guard_runner_project_admission_active", "Locally held Endpoint permits, including Redis admission waits.", ["project_id"], registry=registry)
        self.queued = Gauge("guard_runner_project_admission_queued", "Endpoint requests waiting in this Runner's local admission queue.", ["project_id"], registry=registry)
        self.limit = Gauge("guard_runner_project_admission_limit", "Configured per-project local permit cap; not reserved capacity.", ["project_id"], registry=registry)
        self.capacity = Gauge("guard_runner_project_admission_capacity", "Total local Endpoint permit capacity.", registry=registry)
        self.attempts = Counter("guard_runner_project_admission_attempts_total", "Authenticated Endpoint admission outcomes.", ["project_id", "outcome"], registry=registry)
        buckets = (0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60)
        self.wait = Histogram("guard_runner_project_admission_wait_seconds", "Time from trusted owner resolution to admission outcome, including local queue and Redis waits.", ["project_id", "outcome"], buckets=buckets, registry=registry)
        self.held = Histogram("guard_runner_project_admission_held_seconds", "Time a local permit was held, including Redis waits and route cleanup; excludes local queue wait.", ["project_id"], buckets=buckets, registry=registry)
        self.capacity.set(capacity)
        for project, limit in limits.items():
            self.limit.labels(project).set(limit)
            self.active.labels(project).set(0)
            self.queued.labels(project).set(0)

    def state(self, project: str, active: int, queued: int) -> None:
        if project in self._projects:
            if self._snapshot is not None:
                self._snapshot[project].update(active=active, queued=queued)
            self.active.labels(project).set(active)
            self.queued.labels(project).set(queued)

    def outcome(self, project: str, outcome: str, seconds: float) -> None:
        if project in self._projects:
            bounded = outcome if outcome in {"admitted", "queue_full", "queue_timeout", "rate_limited", "cancelled", "unavailable"} else "unavailable"
            if self._snapshot is not None:
                self._snapshot[project]["outcomes"][bounded] += 1
                if bounded == "admitted":
                    self._observe(self._snapshot[project]["wait"], max(0, seconds))
            self.attempts.labels(project, bounded).inc()
            self.wait.labels(project, bounded).observe(max(0, seconds))

    def released(self, project: str, seconds: float) -> None:
        if project in self._projects:
            if self._snapshot is not None:
                self._observe(self._snapshot[project]["held"], max(0, seconds))
            self.held.labels(project).observe(max(0, seconds))

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
                "monotonicSeconds": time.monotonic(), "projects": copy.deepcopy(list(self._snapshot.values()))}
