"""Bounded per-tenant admission for a single Runner process/event loop.

The opt-in Endpoint gate derives its identity from an authenticated Controller
snapshot. Concurrency caps remain local; an optional separate rate authority can
bound admission starts across replicas. Neither mechanism reserves capacity.
"""
from __future__ import annotations

import asyncio
import math
import json
import time
import logging
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import AsyncIterator, Callable, Mapping, Protocol


class AdmissionUnavailable(Exception):
    """A trustworthy current tenant/serving allocation is unavailable."""


class _EndpointOwner(Protocol):
    def authenticated_endpoint_tenant(self, endpoint_id: str, credential: str | None) -> str | None: ...


class RateAdmission(Protocol):
    async def admit(self, tenant: str) -> None: ...


class GroupRateAdmission(Protocol):
    def validate_allocation(self, tenant: str, group_id: str, epoch: int) -> None: ...
    async def admit(self, tenant: str, *, group_id: str, epoch: int) -> None: ...


class AdmissionObserver(Protocol):
    def state(self, tenant: str, active: int, queued: int) -> None: ...
    def outcome(self, tenant: str, outcome: str, seconds: float) -> None: ...
    def released(self, tenant: str, seconds: float) -> None: ...


def _notify(observer: AdmissionObserver | None, method: str, *args) -> None:
    # Instrumentation must never interrupt a grant, dispatch or release after
    # admission state has changed. Failure leaves metrics unavailable, not a
    # stranded permit or an unresolvable popped waiter.
    if observer is not None:
        try:
            getattr(observer, method)(*args)
        except Exception:
            logging.getLogger(__name__).warning("Tenant admission instrumentation unavailable.")


@dataclass(frozen=True)
class TenantAdmissionConfiguration:
    capacity: int
    tenant_limits: Mapping[str, int]
    max_queued: int
    max_queued_per_tenant: int
    queue_timeout_seconds: float

    @classmethod
    def from_json(cls, raw: str) -> TenantAdmissionConfiguration:
        def unique_object(items):
            result = {}
            for key, value in items:
                if key in result:
                    raise ValueError("Tenant admission configuration contains duplicate keys.")
                result[key] = value
            return result

        try:
            values = json.loads(raw, object_pairs_hook=unique_object)
        except (TypeError, json.JSONDecodeError) as error:
            raise ValueError("Tenant admission configuration must be a JSON object.") from error
        fields = {"capacity", "tenant_limits", "max_queued", "max_queued_per_tenant", "queue_timeout_seconds"}
        if not isinstance(values, dict) or set(values) != fields:
            raise ValueError("Tenant admission configuration must contain exactly capacity, tenant_limits, max_queued, max_queued_per_tenant and queue_timeout_seconds.")
        limits = values["tenant_limits"]
        if not isinstance(limits, dict) or not 1 <= len(limits) <= 1000 or any(not key or key.strip() != key or len(key) > 256 for key in limits):
            raise ValueError("Tenant admission tenant_limits requires 1 to 1000 nonempty, unpadded tenant IDs of at most 256 characters.")
        try:
            for key in limits:
                key.encode("utf-8")
        except UnicodeEncodeError as error:
            raise ValueError("Tenant admission tenant IDs must be valid UTF-8.") from error
        # Reuse the actual limiter's configuration validation.
        TenantAdmission(capacity=values["capacity"], tenant_limits=limits,
                        max_queued=values["max_queued"], max_queued_per_tenant=values["max_queued_per_tenant"])
        timeout = values["queue_timeout_seconds"]
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 0 <= timeout <= 30 or not math.isfinite(timeout):
            raise ValueError("Tenant admission queue_timeout_seconds must be finite and between 0 and 30 seconds.")
        return cls(**{**values, "tenant_limits": dict(limits), "queue_timeout_seconds": float(timeout)})

    def build(self, serving_authority: Callable[[], bool], *, rate: RateAdmission | None = None, group_rate: GroupRateAdmission | None = None, observer: AdmissionObserver | None = None) -> EndpointAdmission:
        return EndpointAdmission(TenantAdmission(capacity=self.capacity, tenant_limits=self.tenant_limits,
            max_queued=self.max_queued, max_queued_per_tenant=self.max_queued_per_tenant, observer=observer),
            timeout_seconds=self.queue_timeout_seconds, serving_authority=serving_authority, rate=rate, group_rate=group_rate, observer=observer)


class AdmissionRejected(Exception):
    def __init__(self, reason: str, *, retry_after: int = 1):
        super().__init__(reason)
        self.reason = reason
        self.retry_after = retry_after


@dataclass
class _Waiter:
    tenant: str
    future: asyncio.Future[None]
    granted: bool = False
    granted_at: float | None = None


class AdmissionPermit:
    """A single releaseable permit; duplicate releases do not free extra slots."""

    def __init__(self, admission: TenantAdmission, tenant: str, *, started: float | None = None):
        self._admission = admission
        self._tenant = tenant
        self._released = False
        self._started = started if started is not None else time.monotonic()

    async def release(self) -> None:
        async with self._admission._lock:
            if self._released:
                return
            self._released = True
            self._admission._release_locked(self._tenant)
            _notify(self._admission._observer, "released", self._tenant, time.monotonic() - self._started)


class EndpointAdmission:
    """Authenticate owner before and after queueing; client headers do not select it."""

    def __init__(self, admission: TenantAdmission, *, timeout_seconds: float, serving_authority: Callable[[], bool], rate: RateAdmission | None = None, group_rate: GroupRateAdmission | None = None, observer: AdmissionObserver | None = None):
        if not callable(serving_authority):
            raise ValueError("Endpoint admission requires an explicit serving authority check.")
        if isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, (int, float)) or not 0 <= timeout_seconds <= 30 or not math.isfinite(timeout_seconds):
            raise ValueError("Endpoint admission requires a finite queue timeout between 0 and 30 seconds.")
        self._admission = admission
        self._timeout = timeout_seconds
        self._serving_authority = serving_authority
        self._rate = rate
        if rate is not None and group_rate is not None:
            raise ValueError("Pool v1 and group v2 rate policies cannot be combined.")
        self._group_rate = group_rate
        self._observer = observer

    async def acquire(self, store: _EndpointOwner, endpoint_id: str, credential: str | None) -> AdmissionPermit:
        if not self._serving_authority():
            raise AdmissionUnavailable("Runner serving authority is unavailable.")
        resolve_owner = getattr(store, "authenticated_endpoint_tenant", None)
        owner = resolve_owner(endpoint_id, credential) if callable(resolve_owner) else None
        if not isinstance(owner, str) or not owner or owner != owner.strip():
            raise AdmissionUnavailable("Endpoint tenant ownership is unavailable.")
        started = time.monotonic()
        permit = None
        try:
            allocation = None
            if self._group_rate is not None:
                allocation = self._allocation(store, endpoint_id, credential, owner)
                self._group_rate.validate_allocation(owner, allocation.group_id, allocation.epoch)
            try:
                permit = await self._admission.acquire(owner, timeout=self._timeout)
            except AdmissionRejected as error:
                if error.reason == "unknown_tenant":
                    raise AdmissionUnavailable("Endpoint tenant has no configured admission budget.") from error
                raise
            # Credentials or the accepted allocation can change while queued.
            # Do not charge one tenant and then execute under another snapshot.
            if not self._serving_authority() or store.authenticated_endpoint_tenant(endpoint_id, credential) != owner:
                raise AdmissionUnavailable("Endpoint allocation changed while waiting for admission.")
            if self._group_rate is not None:
                if self._allocation(store, endpoint_id, credential, owner) != allocation:
                    raise AdmissionUnavailable("Controller allocation changed while queued for group admission.")
                await self._group_rate.admit(owner, group_id=allocation.group_id, epoch=allocation.epoch)
                if not self._serving_authority() or self._allocation(store, endpoint_id, credential, owner) != allocation:
                    raise AdmissionUnavailable("Controller allocation changed while waiting for group rate admission.")
            if self._rate is not None:
                await self._rate.admit(owner)
                # Redis/network waits can outlive ownership or credential
                # changes too. A consumed start is never refunded on failure.
                if not self._serving_authority() or store.authenticated_endpoint_tenant(endpoint_id, credential) != owner:
                    raise AdmissionUnavailable("Endpoint allocation changed while waiting for distributed admission.")
            _notify(self._observer, "outcome", owner, "admitted", time.monotonic() - started)
            return permit
        except BaseException as error:
            if permit is not None:
                await asyncio.shield(permit.release())
            if self._observer:
                outcome = ("cancelled" if isinstance(error, asyncio.CancelledError) else
                           "queue_timeout" if isinstance(error, AdmissionRejected) and error.reason == "timeout" else
                           error.reason if isinstance(error, AdmissionRejected) else "unavailable")
                _notify(self._observer, "outcome", owner, outcome, time.monotonic() - started)
            raise

    @staticmethod
    def _allocation(store, endpoint_id, credential, owner):
        resolve = getattr(store, "authenticated_endpoint_allocation", None)
        allocation = resolve(endpoint_id, credential) if callable(resolve) else None
        if (allocation is None or getattr(allocation, "tenant_id", None) != owner or
            not isinstance(getattr(allocation, "group_id", None), str) or not allocation.group_id or
            allocation.group_id != allocation.group_id.strip() or type(getattr(allocation, "epoch", None)) is not int or
            not 0 <= allocation.epoch <= 9_007_199_254_740_991):
            raise AdmissionUnavailable("Controller-authenticated Endpoint group allocation is unavailable.")
        return allocation


class TenantAdmission:
    """FIFO within tenants, round-robin across eligible tenants.

    Per-tenant limits are hard caps, not guaranteed reservations. When all
    group slots are occupied, another tenant waits until a slot is released.
    This object is local to one process and event loop, not a distributed limit.
    """

    def __init__(self, *, capacity: int, tenant_limits: Mapping[str, int],
                 max_queued: int, max_queued_per_tenant: int, observer: AdmissionObserver | None = None):
        if isinstance(capacity, bool) or not isinstance(capacity, int) or capacity < 1:
            raise ValueError("capacity must be a positive integer")
        for value in (max_queued, max_queued_per_tenant):
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError("queue limits must be nonnegative integers")
        if not tenant_limits or any(not isinstance(tenant, str) or not tenant.strip()
                                    or isinstance(limit, bool) or not isinstance(limit, int) or limit < 1
                                    for tenant, limit in tenant_limits.items()):
            raise ValueError("tenant limits must contain named tenants with positive integer limits")
        self._capacity = capacity
        self._limits = dict(tenant_limits)
        self._max_queued = max_queued
        self._max_queued_per_tenant = max_queued_per_tenant
        self._active: dict[str, int] = {}
        self._active_total = 0
        self._waiting: dict[str, deque[_Waiter]] = {}
        self._round_robin: deque[str] = deque()
        self._queued = 0
        self._lock = asyncio.Lock()
        self._observer = observer

    async def acquire(self, tenant: str, *, timeout: float | None = None) -> AdmissionPermit:
        if not isinstance(tenant, str) or tenant not in self._limits:
            raise AdmissionRejected("unknown_tenant")
        if timeout is not None and (not isinstance(timeout, (int, float)) or isinstance(timeout, bool)
                                    or not math.isfinite(timeout) or timeout < 0):
            raise ValueError("timeout must be a finite nonnegative number")
        async with self._lock:
            # Dispatch always drains eligible queued tenants before releasing
            # the lock. Any remaining waiters are capped by their own limit.
            if self._can_grant(tenant):
                activated = self._activate(tenant)
                return AdmissionPermit(self, tenant, started=activated)
            waiting = self._waiting.get(tenant)
            if self._queued >= self._max_queued or len(waiting or ()) >= self._max_queued_per_tenant:
                raise AdmissionRejected("queue_full")
            future = asyncio.get_running_loop().create_future()
            waiter = _Waiter(tenant, future)
            if waiting is None:
                waiting = self._waiting[tenant] = deque()
                self._round_robin.append(tenant)
            waiting.append(waiter)
            self._queued += 1
            self._publish(tenant)
            self._dispatch_locked()
        try:
            # Shield the shared future so cancellation cannot erase evidence of
            # a grant made before the waiting task resumes.
            if timeout is None:
                await asyncio.shield(future)
            else:
                await asyncio.wait_for(asyncio.shield(future), timeout)
        except BaseException as error:
            await asyncio.shield(self._cancel_waiter(waiter))
            if isinstance(error, TimeoutError):
                raise AdmissionRejected("timeout") from error
            raise
        return AdmissionPermit(self, tenant, started=waiter.granted_at)

    @asynccontextmanager
    async def slot(self, tenant: str, *, timeout: float | None = None) -> AsyncIterator[None]:
        permit = await self.acquire(tenant, timeout=timeout)
        try:
            yield
        finally:
            # Even a second cancellation must not abandon permit release.
            await asyncio.shield(permit.release())

    def _can_grant(self, tenant: str) -> bool:
        return self._active_total < self._capacity and self._active.get(tenant, 0) < self._limits[tenant]

    async def _cancel_waiter(self, waiter: _Waiter) -> None:
        async with self._lock:
            if waiter.granted:
                self._release_locked(waiter.tenant)
                if self._observer and waiter.granted_at is not None:
                    _notify(self._observer, "released", waiter.tenant, time.monotonic() - waiter.granted_at)
            else:
                self._remove_locked(waiter)
                self._dispatch_locked()

    def _activate(self, tenant: str) -> float:
        activated = time.monotonic()
        self._active_total += 1
        self._active[tenant] = self._active.get(tenant, 0) + 1
        self._publish(tenant)
        return activated

    def _release_locked(self, tenant: str) -> None:
        self._active_total -= 1
        remaining = self._active[tenant] - 1
        if remaining:
            self._active[tenant] = remaining
        else:
            del self._active[tenant]
        self._publish(tenant)
        self._dispatch_locked()

    def _remove_locked(self, waiter: _Waiter) -> None:
        queue = self._waiting[waiter.tenant]
        queue.remove(waiter)
        self._queued -= 1
        if not queue:
            del self._waiting[waiter.tenant]
            self._round_robin.remove(waiter.tenant)
        self._publish(waiter.tenant)

    def _publish(self, tenant: str) -> None:
        if self._observer:
            _notify(self._observer, "state", tenant, self._active.get(tenant, 0), len(self._waiting.get(tenant, ())))

    def _dispatch_locked(self) -> None:
        skipped = 0
        while self._active_total < self._capacity and self._round_robin and skipped < len(self._round_robin):
            tenant = self._round_robin.popleft()
            queue = self._waiting[tenant]
            if not self._can_grant(tenant):
                self._round_robin.append(tenant)
                skipped += 1
                continue
            waiter = queue.popleft()
            self._queued -= 1
            if queue:
                self._round_robin.append(tenant)
            else:
                del self._waiting[tenant]
            waiter.granted_at = self._activate(tenant)
            waiter.granted = True
            waiter.future.set_result(None)
            skipped = 0
