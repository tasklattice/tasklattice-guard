"""Runner-side primitive for a Controller-acknowledged serving lease.

This module does not itself authorize serving: callers must activate only a
fully applied allocation, send each challenge to an authenticated Controller,
validate the echoed response, and connect ``expired`` to the serving fence.
Controller must durably track grants and coordinate reallocation separately.
The Runner control client uses this only behind its explicit experimental
lease-enforcement option. Group moves do not have an integrated drain/epoch
protocol, so this does not by itself establish partition-safe allocation.

The default clock uses Linux CLOCK_BOOTTIME so ordinary host suspend counts
toward expiry. Other platforms must supply an explicitly verified clock. A VM
pause or clock source that fails to advance during suspension can still violate
that assumption. An event-loop watchdog cannot cancel running work while the
loop or VM is suspended; output and admission paths must recheck the deadline,
and stronger guarantees need Controller-side coordination and, for an
uncooperative/frozen Runner, enforceable external workload/network fencing.
"""
from __future__ import annotations

import asyncio
import secrets
import time
from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True, slots=True)
class LeaseChallenge:
    """A unique renewal attempt, measured from before its request is sent."""

    nonce: str
    epoch: int
    generation: int
    started_at: float


class ServingLease:
    """Bound a Runner's authorization to a fresh Controller acknowledgement.

    Deadlines use a local monotonic clock and are measured from request start,
    not acknowledgement receipt, so network delay cannot extend a grant. This
    is deliberately independent of transport and durable Controller state.
    An injected clock is a testing/integration seam, not a guarantee that the
    supplied clock is suspend-aware.
    """

    def __init__(self, max_duration_seconds: float, *, clock: Callable[[], float] | None = None) -> None:
        if not 0 < max_duration_seconds < float("inf"):
            raise ValueError("Maximum lease duration must be finite and positive.")
        self._max_duration = max_duration_seconds
        if clock is None:
            if not hasattr(time, "CLOCK_BOOTTIME"):
                raise RuntimeError("A suspend-aware lease clock is required on this platform.")
            clock = lambda: time.clock_gettime(time.CLOCK_BOOTTIME)
        self._clock = clock
        self._epoch: int | None = None
        self._generation: int | None = None
        self._pending: LeaseChallenge | None = None
        self._deadline: float | None = None
        self._expired = True
        self._loss = asyncio.Event()
        self._loss.set()
        self._timer: asyncio.TimerHandle | None = None

    @property
    def synchronized(self) -> bool:
        self._expire_if_needed()
        return not self._expired

    @property
    def synchronization_lost(self) -> asyncio.Event:
        """Per-serving-period event; never cleared when authorization resumes."""
        self._expire_if_needed()
        return self._loss

    @property
    def deadline(self) -> float | None:
        self._expire_if_needed()
        return self._deadline

    def activate_allocation(self, epoch: int, generation: int) -> None:
        """Fence old work after the caller atomically applies a verified snapshot."""
        self.revoke()
        if type(epoch) is not int or type(generation) is not int or epoch < 0 or generation < 0:
            raise ValueError("Allocation epoch and generation must be nonnegative.")
        self._epoch = epoch
        self._generation = generation

    def challenge(self) -> LeaseChallenge:
        """Start a renewal; later challenges invalidate earlier pending replies."""
        self._expire_if_needed()
        if self._epoch is None or self._generation is None:
            raise RuntimeError("Apply an allocation before requesting a lease.")
        challenge = LeaseChallenge(secrets.token_urlsafe(24), self._epoch, self._generation, self._clock())
        self._pending = challenge
        return challenge

    def accept(self, challenge: LeaseChallenge, *, epoch: int, generation: int, nonce: str,
               duration_seconds: float) -> bool:
        """Accept only a timely echo of the latest request for the active allocation.

        A missed renewal cannot silently revive an expired serving period: the
        caller must re-apply the allocation before requesting a new first lease.
        """
        self._expire_if_needed()
        if challenge != self._pending or (epoch, generation, nonce) != (challenge.epoch, challenge.generation, challenge.nonce):
            return False
        if (epoch, generation) != (self._epoch, self._generation):
            return False
        self._pending = None
        if not 0 < duration_seconds <= self._max_duration:
            return False
        deadline = challenge.started_at + duration_seconds
        if not self._clock() < deadline:
            return False
        # A prior grant that expired invalidates the allocation. A fresh
        # activate_allocation() call is required after any such expiry.
        if self._epoch is None:
            return False
        if self._expired:
            self._loss = asyncio.Event()
        self._expired = False
        self._deadline = deadline
        try:
            self._schedule_expiry(deadline)
        except Exception:
            self.revoke()
            raise
        return True

    def revoke(self) -> None:
        """Permanently fence the current period and invalidate pending replies."""
        self._loss.set()
        self._expired = True
        self._deadline = None
        self._pending = None
        self._epoch = None
        self._generation = None
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None

    def _expire_if_needed(self) -> None:
        if self._deadline is not None and self._clock() >= self._deadline:
            self.revoke()

    def _schedule_expiry(self, deadline: float) -> None:
        if self._timer is not None:
            self._timer.cancel()
        # A watchdog notifies in-flight work while the event loop is active.
        # It cannot run while the loop or VM is suspended. Callers must also
        # read synchronized immediately before serving/sending, and the
        # deployment needs an enforceable external fence for stronger claims.
        loop = asyncio.get_running_loop()
        self._timer = loop.call_later(max(0.0, deadline - self._clock()), self._on_timer, deadline)

    def _on_timer(self, deadline: float) -> None:
        if self._deadline == deadline:
            self._timer = None
            self._expire_if_needed()
