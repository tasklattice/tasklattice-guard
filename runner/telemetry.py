from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

import httpx
from .telemetry_progress import ProgressWAL

if TYPE_CHECKING:
    from .metrics import RunnerMetrics


logger = logging.getLogger("tasklattice.guard.runner.telemetry")


class RuntimeTelemetryExporter:
    """Disk-backed delivery of Runtime evidence and idempotent body enrichment."""

    def __init__(
        self,
        endpoint: str,
        token: str,
        state_path: Path,
        batch_size: int,
        runner_id: str,
        metrics: RunnerMetrics | None = None,
        *, progress_enabled: bool = False, progress_state_path: Path | None = None,
    ) -> None:
        self._endpoint = endpoint
        self._token = token
        self._batch_size = batch_size
        self._runner_id = runner_id
        self._metrics = metrics
        if not progress_enabled:
            ProgressWAL.require_drained_for_legacy(progress_state_path or state_path)
        if progress_enabled and (state_path / "runtime-events.wal").exists() and (state_path / "runtime-events.wal").stat().st_size:
            raise ValueError("Drain the legacy telemetry WAL before enabling authenticated progress.")
        self._progress_wal = ProgressWAL(progress_state_path or state_path) if progress_enabled else None
        self._progress_capability: str | None = None
        self._wal_path = state_path / "runtime-events.wal"
        self._wake = asyncio.Event()
        self._stop = asyncio.Event()
        self._lock = asyncio.Lock()
        self._wal_event_count = 0
        self._wal_size_bytes = 0
        self._wal_oldest_timestamp = 0.0
        self._refresh_wal_state()

    async def emit(self, event: dict[str, Any]) -> None:
        if self._progress_wal is not None:
            await self._progress_wal.append(_normalize_event_for_transport(event))
            self._set_progress_wal_state()
            self._wake.set()
            return
        encoded = json.dumps(event, sort_keys=True, separators=(",", ":")) + "\n"
        try:
            async with self._lock:
                await asyncio.to_thread(self._append, encoded)
                self._wal_event_count += 1
                self._wal_size_bytes += len(encoded.encode("utf-8"))
                if self._wal_oldest_timestamp <= 0:
                    self._wal_oldest_timestamp = _event_timestamp(event)
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
                    await self._report_watermark(client)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.exception("Runtime telemetry delivery failed; events remain in the WAL.")

    async def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._progress_wal is not None:
            await self._progress_wal.close()

    @property
    def progress_wal_id(self) -> str | None:
        return self._progress_wal.wal_id if self._progress_wal is not None else None

    def clear_progress_authorization(self) -> None:
        self._progress_capability = None

    async def authorize_progress(self, authorization) -> None:
        if self._progress_wal is None:
            return
        self._progress_capability = None
        if (not authorization.wal_id or len(authorization.capability) != 64 or
            any(character not in "0123456789abcdef" for character in authorization.capability)):
            raise RuntimeError("Authenticated telemetry progress authorization is unavailable.")
        await self._progress_wal.bind(authorization.wal_id, authorization.acknowledged_cursor, authorization.produced_cursor,
            getattr(authorization, "last_batch_id", ""), getattr(authorization, "last_batch_digest", ""))
        self._progress_capability = authorization.capability
        self._set_progress_wal_state()
        self._wake.set()

    async def _flush_once(self, client: httpx.AsyncClient) -> bool:
        if self._progress_wal is not None:
            if self._progress_capability is None:
                return False
            batch = await self._progress_wal.batch(self._batch_size)
            if not batch["events"]:
                return False
            await self._send_progress_batch(client, batch)
            return bool(self._progress_wal.events)
        async with self._lock:
            lines = await asyncio.to_thread(self._read_lines)
            batch = lines[: self._batch_size]
        if not batch:
            return False
        started = time.perf_counter()
        try:
            # Older Runner versions wrote absent optional fields as JSON null.
            # The Controller contract models those fields as optional, so omit
            # nulls during delivery and let an upgraded Runner drain its WAL
            # without requiring an operator to edit or discard evidence.
            events = [_normalize_event_for_transport(json.loads(line)) for line in batch]
            response = await client.post(
                self._endpoint,
                headers={"authorization": f"Bearer {self._token}"},
                json={"events": events},
            )
            response.raise_for_status()
            async with self._lock:
                latest = await asyncio.to_thread(self._read_lines)
                if latest[: len(batch)] != batch:
                    raise RuntimeError("Runtime telemetry WAL changed unexpectedly during delivery.")
                remaining = latest[len(batch) :]
                try:
                    await asyncio.to_thread(self._replace_lines, remaining)
                except Exception:
                    if self._metrics is not None:
                        self._metrics.observe_telemetry_write_failure("replace")
                    raise
                self._set_wal_state(remaining)
            if self._metrics is not None:
                self._metrics.observe_telemetry_export(
                    operation="events", result="success", events=len(batch),
                    duration_seconds=time.perf_counter() - started,
                )
            return bool(remaining)
        except Exception:
            if self._metrics is not None:
                self._metrics.observe_telemetry_export(
                    operation="events", result="error", events=len(batch),
                    duration_seconds=time.perf_counter() - started,
                )
            raise

    async def _report_watermark(self, client: httpx.AsyncClient) -> None:
        """Confirm that the telemetry channel is healthy even during zero traffic."""
        if self._progress_wal is not None:
            if self._progress_capability is None:
                return
            batch = await self._progress_wal.batch(self._batch_size)
            if batch["events"]:
                self._wake.set()
                return
            await self._send_progress_batch(client, batch)
            return
        started = time.perf_counter()
        try:
            response = await client.post(
                self._endpoint,
                headers={"authorization": f"Bearer {self._token}"},
                json={
                    "events": [],
                    "runnerId": self._runner_id,
                    "observedAt": datetime.now(UTC).isoformat(),
                },
            )
            response.raise_for_status()
            if self._metrics is not None:
                self._metrics.observe_telemetry_export(
                    operation="watermark", result="success", events=0,
                    duration_seconds=time.perf_counter() - started,
                )
        except Exception:
            if self._metrics is not None:
                self._metrics.observe_telemetry_export(
                    operation="watermark", result="error", events=0,
                    duration_seconds=time.perf_counter() - started,
                )
            raise

    def _append(self, encoded: str) -> None:
        self._wal_path.parent.mkdir(parents=True, exist_ok=True)
        with self._wal_path.open("a", encoding="utf-8") as stream:
            stream.write(encoded)
            stream.flush()

    async def _send_progress_batch(self, client: httpx.AsyncClient, batch: dict) -> None:
        capability = self._progress_capability
        if capability is None:
            return
        encoded = json.dumps(batch, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
        response = await client.post(self._endpoint,
            headers={"authorization": f"Bearer {self._token}", "content-type": "application/json",
                "x-tasklattice-telemetry-capability": capability}, content=encoded)
        response.raise_for_status()
        payload = response.json()
        if (not isinstance(payload, dict) or type(payload.get("accepted")) is not int or
            payload["accepted"] != len(batch["events"])):
            raise RuntimeError("Controller did not acknowledge telemetry event dispositions.")
        await self._progress_wal.acknowledge(batch, payload.get("progress"))
        self._set_progress_wal_state()

    def _set_progress_wal_state(self):
        events = self._progress_wal.events
        self._wal_event_count = len(events)
        self._wal_size_bytes = self._progress_wal.path.stat().st_size
        self._wal_oldest_timestamp = _event_timestamp(events[0]) if events else 0.0
        self._publish_wal_metrics()

    def _read_lines(self) -> list[str]:
        if not self._wal_path.exists():
            return []
        return [line for line in self._wal_path.read_text(encoding="utf-8").splitlines() if line]

    def _replace_lines(self, lines: list[str]) -> None:
        temporary = self._wal_path.with_suffix(".wal.tmp")
        temporary.write_text("".join(f"{line}\n" for line in lines), encoding="utf-8")
        temporary.replace(self._wal_path)

    def _refresh_wal_state(self) -> None:
        if self._progress_wal is not None:
            self._set_progress_wal_state()
            return
        self._set_wal_state(self._read_lines())

    def _set_wal_state(self, lines: list[str]) -> None:
        self._wal_event_count = len(lines)
        self._wal_size_bytes = sum(len(f"{line}\n".encode("utf-8")) for line in lines)
        self._wal_oldest_timestamp = 0.0
        if lines:
            try:
                self._wal_oldest_timestamp = _event_timestamp(json.loads(lines[0]))
            except (json.JSONDecodeError, TypeError, ValueError):
                self._wal_oldest_timestamp = time.time()
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


def _event_timestamp(event: dict[str, Any]) -> float:
    value = event.get("occurredAt")
    if not isinstance(value, str):
        return time.time()
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return time.time()


def _normalize_event_for_transport(event: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in event.items() if value is not None}
