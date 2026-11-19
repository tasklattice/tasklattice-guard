from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

import httpx

from .outage import TransportOutage
from .telemetry_wal import TelemetryWal, WalRecord
from .telemetry_budget import (
    MAX_BODY_BYTES,
    UnsendableTelemetryEvent,
    bounded_batch_size,
    split_metered_event,
)

if TYPE_CHECKING:
    from .metrics import RunnerMetrics


logger = logging.getLogger("tasklattice.guard.runner.telemetry")

REJECTED_WAL_NAME = "runtime-events.rejected.wal"
MAX_REJECTED_WAL_BYTES = 64 * 1024 * 1024


class TelemetryReceiptError(RuntimeError):
    """The Controller returned a success status without accepting the batch."""


class RuntimeTelemetryExporter:
    """Disk-backed delivery of Runtime evidence and idempotent body enrichment."""

    def __init__(
        self,
        endpoint: str,
        token: str,
        state_path: Path,
        batch_size: int,
        metrics: RunnerMetrics | None = None,
    ) -> None:
        self._endpoint = endpoint
        self._token = token
        self._batch_size = batch_size
        self._metrics = metrics
        self.drained_at_unix_ms: int | None = None
        self._wal_path = state_path / "runtime-events.wal"
        self._wal = TelemetryWal(self._wal_path)
        # A gateway may enforce a smaller body budget than the Controller.
        # Halve this on every 413 instead of replaying the same batch forever.
        self._body_limit = MAX_BODY_BYTES
        self._wake = asyncio.Event()
        self._stop = asyncio.Event()
        # Delivery is retried from the WAL; an unreachable Controller is normal.
        self._delivery_outage = TransportOutage("controller telemetry endpoint")
        self._lock = asyncio.Lock()
        self._wal_event_count = 0
        self._wal_size_bytes = 0
        self._wal_oldest_timestamp = 0.0
        self._refresh_wal_state()

    async def emit(self, event: dict[str, Any]) -> None:
        # A validation or multi-rail request can exceed the Controller's
        # per-event work budget. Keep the logical event intact and account for
        # the overflow as deterministic cost-only companions.
        parts = split_metered_event(_event_for_transport(event))
        encoded_parts = [
            (part, json.dumps(part, sort_keys=True, separators=(",", ":")) + "\n") for part in parts
        ]
        try:
            async with self._lock:
                for part, encoded in encoded_parts:
                    await asyncio.to_thread(self._append, encoded)
                    self._wal_event_count += 1
                    self._wal_size_bytes += len(encoded.encode("utf-8"))
                    if self._wal_oldest_timestamp <= 0:
                        self._wal_oldest_timestamp = _event_timestamp(part)
                self._publish_wal_metrics()
        except Exception:
            if self._metrics is not None:
                self._metrics.observe_telemetry_write_failure("append")
            raise
        self._wake.set()

    async def run(self) -> None:
        timeout = httpx.Timeout(10)
        async with httpx.AsyncClient(timeout=timeout) as client:
            while not self._stop.is_set():
                try:
                    await asyncio.wait_for(self._wake.wait(), timeout=5)
                except TimeoutError:
                    pass
                self._wake.clear()
                try:
                    self._publish_wal_metrics()
                    while await self._flush_once(client):
                        pass
                    await self._probe_drained_wal(client)
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    self._delivery_outage.failed(error, wal_events=self._wal_event_count)
                else:
                    self._delivery_outage.recovered()

    async def stop(self) -> None:
        self._stop.set()
        self._wake.set()

    async def _flush_once(self, client: httpx.AsyncClient) -> bool:
        started = time.perf_counter()
        async with self._lock:
            records = await asyncio.to_thread(self._wal.peek, min(self._batch_size, 1000))
            batch = [record.line for record in records]
        if not batch:
            return False
        try:
            # Optional Controller fields must be omitted, not sent as null.
            events = [_event_for_transport(json.loads(line)) for line in batch]
        except Exception:
            self._observe_export("events", "error", len(batch), started)
            raise
        try:
            # Prefix selection serializes up to a multi-megabyte body; keep it
            # off the Runner event loop.
            count = await asyncio.to_thread(
                bounded_batch_size,
                events,
                lambda size: {"events": events[:size]},
                self._selection_body_limit(),
            )
        except UnsendableTelemetryEvent:
            return await self._quarantine_head()
        batch, events, records = batch[:count], events[:count], records[:count]
        try:
            response = await client.post(
                self._endpoint,
                headers={"authorization": f"Bearer {self._token}"},
                json={"events": events},
            )
            if response.status_code == 413:
                # A 413 is a pre-transaction rejection: nothing was persisted.
                # A single event cannot shrink further, so quarantine it rather
                # than replaying the same request forever.
                self._observe_export("events", "too_large", len(batch), started)
                if len(batch) == 1:
                    return await self._quarantine_head()
                self._shrink_body_limit()
                return True
            response.raise_for_status()
            _validated_receipt(response, len(events))
        except TelemetryReceiptError:
            self._observe_export("events", "invalid_receipt", len(batch), started)
            raise
        except Exception:
            self._observe_export("events", "error", len(batch), started)
            raise
        try:
            async with self._lock:
                try:
                    await asyncio.to_thread(self._acknowledge, records)
                except Exception:
                    if self._metrics is not None:
                        self._metrics.observe_telemetry_write_failure("replace")
                    raise
                self._publish_wal_metrics()
        except Exception:
            self._observe_export("events", "error", len(batch), started)
            raise
        self._observe_export("events", "success", len(batch), started)
        return self._wal_event_count > 0

    async def _probe_drained_wal(self, client: httpx.AsyncClient) -> None:
        """Verify delivery at a point when no WAL events were waiting."""
        async with self._lock:
            if self._wal_event_count:
                return
            drained_at = time.time_ns() // 1_000_000
        started = time.perf_counter()
        try:
            response = await client.post(
                self._endpoint,
                headers={"authorization": f"Bearer {self._token}"},
                json={"events": []},
            )
            response.raise_for_status()
            _validated_receipt(response, 0)
        except TelemetryReceiptError:
            self._observe_export("watermark", "invalid_receipt", 0, started)
            raise
        except Exception:
            self._observe_export("watermark", "error", 0, started)
            raise
        if drained_at > (self.drained_at_unix_ms or 0):
            self.drained_at_unix_ms = drained_at
        self._observe_export("watermark", "success", 0, started)

    async def _quarantine_head(self) -> bool:
        """Move an unsendable first line aside so later evidence can drain."""
        async with self._lock:
            records = await asyncio.to_thread(self._wal.peek, 1)
            if not records:
                return False
            first = records[0].line
            try:
                event_id = json.loads(first).get("id", "<unknown>")
            except (json.JSONDecodeError, AttributeError):
                event_id = "<unparseable>"
            try:
                await asyncio.to_thread(self._append_rejected, f"{first}\n".encode("utf-8"))
            except Exception:
                logger.exception("Rejected telemetry WAL cannot accept another record; preserving the main WAL.")
                raise
            await asyncio.to_thread(self._acknowledge, records)
            self._publish_wal_metrics()
        if self._metrics is not None:
            self._metrics.observe_telemetry_quarantine("unsendable")
        logger.error(
            "Quarantined an unsendable runtime telemetry event (id=%s) into %s; the remaining WAL will continue draining.",
            event_id, self._rejected_wal_path(),
        )
        return self._wal_event_count > 0

    def _append_rejected(self, payload: bytes) -> None:
        path = self._rejected_wal_path()
        current = path.stat().st_size if path.exists() else 0
        if current + len(payload) > MAX_REJECTED_WAL_BYTES:
            raise RuntimeError(
                "Rejected telemetry WAL exceeds its 64 MiB bound; preserve runtime-events.wal for reconciliation.",
            )
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("ab") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())

    def _rejected_wal_path(self) -> Path:
        return self._wal_path.with_name(REJECTED_WAL_NAME)

    def _append(self, encoded: str) -> None:
        self._wal.append(encoded)

    def _acknowledge(self, records: list[WalRecord]) -> None:
        self._wal.acknowledge(records)
        self._refresh_wal_state(publish=False)

    def _refresh_wal_state(self, *, publish: bool = True) -> None:
        self._wal_event_count = self._wal.count
        self._wal_size_bytes = self._wal.pending_bytes
        self._wal_oldest_timestamp = 0.0
        records = self._wal.peek(1)
        if records:
            try:
                self._wal_oldest_timestamp = _event_timestamp(json.loads(records[0].line))
            except (json.JSONDecodeError, TypeError, ValueError):
                self._wal_oldest_timestamp = time.time()
        if publish:
            self._publish_wal_metrics()

    def _publish_wal_metrics(self) -> None:
        if self._metrics is None:
            return
        oldest_age = (
            max(0.0, time.time() - self._wal_oldest_timestamp)
            if self._wal_event_count and self._wal_oldest_timestamp > 0
            else 0.0
        )
        self._metrics.set_telemetry_wal(
            events=self._wal_event_count,
            size_bytes=self._wal_size_bytes,
            oldest_age_seconds=oldest_age,
        )

    def _selection_body_limit(self) -> int | None:
        if self._body_limit >= MAX_BODY_BYTES:
            return None
        return max(1, self._body_limit)

    def _shrink_body_limit(self) -> None:
        self._body_limit = max(1, self._body_limit // 2)
        logger.warning("Telemetry upload body budget reduced to %d bytes after a 413 response.", self._body_limit)

    def _observe_export(self, operation: str, result: str, events: int, started: float) -> None:
        if self._metrics is not None:
            self._metrics.observe_telemetry_export(
                operation=operation, result=result, events=events,
                duration_seconds=time.perf_counter() - started,
            )


def _validated_receipt(response: httpx.Response, expected: int) -> dict[str, Any]:
    """Require the Controller's exact receipt before any WAL mutation."""
    try:
        payload = response.json()
    except ValueError as error:
        raise TelemetryReceiptError(
            "Controller telemetry receipt is not valid JSON; preserving the WAL for replay.",
        ) from error
    if not isinstance(payload, dict) or type(payload.get("accepted")) is not int or payload["accepted"] != expected:
        raise TelemetryReceiptError(
            "Controller did not acknowledge the exact telemetry batch; preserving the WAL for replay.",
        )
    return payload


def _event_timestamp(event: dict[str, Any]) -> float:
    value = event.get("occurredAt")
    if not isinstance(value, str):
        return time.time()
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return time.time()


def _event_for_transport(event: dict[str, Any]) -> dict[str, Any]:
    # Optional Controller fields are omitted, never sent as JSON null.
    return {key: value for key, value in event.items() if value is not None}
