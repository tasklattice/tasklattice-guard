"""Bounded crash-consistent contiguous telemetry WAL; no freshness attestation."""
from __future__ import annotations

import asyncio
import copy
import json
import os
import uuid
import fcntl
import hashlib
from pathlib import Path
from typing import Any, Callable

MAX_CURSOR = 9_007_199_254_740_991
MAX_BYTES = 8 * 1024 * 1024
MAX_RECORDS = 10_000
MAX_BODY_BYTES = 8 * 1024 * 1024
MAX_BODY_DEPTH = 64
MAX_STRUCTURAL_TOKENS = 100_000
MAX_EVENT_MODEL_CALLS = 64
MAX_BATCH_MODEL_CALLS = 256


class WALCapacityError(RuntimeError):
    pass


class ProgressWAL:
    def __init__(self, state_path: Path, *, require_existing: bool = False):
        self.path = state_path / "runtime-progress.wal.json"
        state_path.mkdir(parents=True, exist_ok=True)
        self._file_lock = self.path.with_suffix(".lock").open("a+")
        try:
            fcntl.flock(self._file_lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            self._file_lock.close()
            raise RuntimeError("Only one process may write this telemetry WAL.") from error
        self._lock = asyncio.Lock()
        self._operations: set[asyncio.Task] = set()
        self._closed = False
        self._faulted = False
        try:
            self._load(state_path, require_existing)
        except BaseException:
            self._file_lock.close()
            raise

    def _load(self, state_path, require_existing):
        legacy = state_path / "runtime-events.wal"
        if not require_existing and legacy.exists() and legacy.stat().st_size:
            raise ValueError("Drain the legacy telemetry WAL before enabling authenticated progress; mixed WALs require reconciliation.")
        if self.path.exists():
            if self.path.stat().st_size > MAX_BYTES:
                raise ValueError("Telemetry progress WAL exceeds its storage bound.")
            self._state = json.loads(self.path.read_text())
            self._validate(self._state)
        else:
            if require_existing:
                raise ValueError("Retained telemetry progress identity is missing; explicit recovery is required.")
            self._state = {"version": 1, "walId": str(uuid.uuid4()), "acknowledgedCursor": 0,
                "producedCursor": 0, "records": [], "pending": None}
            self._write(self._state)

    @classmethod
    def require_drained_for_legacy(cls, state_path: Path) -> None:
        path = state_path / "runtime-progress.wal.json"
        if not path.exists() and not path.with_suffix(".lock").exists():
            return  # Cannot attest an unmounted/lost volume; rollout must gate it.
        wal = cls(state_path, require_existing=True)
        try:
            if wal._state["records"] or wal._state["pending"] is not None:
                raise ValueError("Drain retained authenticated telemetry before disabling progress; preserve the WAL.")
        finally:
            wal._closed = True
            fcntl.flock(wal._file_lock.fileno(), fcntl.LOCK_UN)
            wal._file_lock.close()

    @property
    def wal_id(self) -> str:
        return self._state["walId"]

    @property
    def events(self) -> list[dict]:
        return [copy.deepcopy(record["event"]) for record in self._state["records"]]

    async def _operate(self, mutate: Callable[[dict], Any]):
        if self._closed:
            raise RuntimeError("Telemetry WAL is closed.")

        async def commit():
            async with self._lock:
                if self._faulted:
                    raise RuntimeError("Telemetry WAL persistence is uncertain; restart and reconcile retained state.")
                state = copy.deepcopy(self._state)
                result = mutate(state)
                if state != self._state:
                    self._validate(state)
                    try:
                        await asyncio.to_thread(self._write, state)
                    except WALCapacityError:
                        raise
                    except BaseException:
                        self._faulted = True
                        raise
                    self._state = state
                return copy.deepcopy(result)

        # A canceled caller cannot release the writer lock while a worker
        # thread still replaces the durable snapshot. The task owns that lock.
        task = asyncio.create_task(commit())
        self._operations.add(task)
        task.add_done_callback(self._operations.discard)
        task.add_done_callback(lambda done: None if done.cancelled() else done.exception())
        return await asyncio.shield(task)

    async def append(self, event: dict) -> None:
        detached = json.loads(json.dumps(event, allow_nan=False))

        def mutate(state):
            if len(state["records"]) >= MAX_RECORDS or state["producedCursor"] >= MAX_CURSOR:
                raise WALCapacityError("Telemetry progress WAL capacity is exhausted; preserve state and reconcile.")
            state["producedCursor"] += 1
            state["records"].append({"cursor": state["producedCursor"], "event": detached})
            # Reserve durable space for a pending batch and later ACK metadata;
            # a full append must not strand evidence that cannot be batched.
            if len(json.dumps(state, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()) > MAX_BYTES - 1024:
                raise WALCapacityError("Telemetry progress WAL byte capacity is exhausted; drain existing evidence.")

        await self._operate(mutate)

    async def batch(self, batch_size: int) -> dict:
        if not 1 <= batch_size <= 1000:
            raise ValueError("Telemetry progress batch size must be between 1 and 1000.")

        def mutate(state):
            pending = state["pending"]
            if not state["records"]:
                progress = {"walId": state["walId"], "batchId": str(uuid.uuid4()),
                    "firstCursor": state["acknowledgedCursor"], "lastCursor": state["acknowledgedCursor"],
                    "producedCursor": state["producedCursor"]}
                return {"events": [], "progress": progress}
            if pending is None:
                pending = {"walId": state["walId"], "batchId": str(uuid.uuid4()),
                    "firstCursor": state["records"][0]["cursor"], "lastCursor": 0,
                    "producedCursor": state["producedCursor"]}
                records = state["records"][:batch_size]
                cumulative_calls = [0]
                invalid_event = []
                for record in records:
                    metadata = record["event"].get("metadata")
                    usage = metadata.get("usage") if isinstance(metadata, dict) else None
                    calls = usage.get("model_calls") if isinstance(usage, dict) else None
                    count = len(calls) if isinstance(calls, list) else 0
                    cumulative_calls.append(cumulative_calls[-1] + count)
                    invalid_event.append(count > MAX_EVENT_MODEL_CALLS or (invalid_event[-1] if invalid_event else False))

                def fits(count):
                    if invalid_event[count - 1] or cumulative_calls[count] > MAX_BATCH_MODEL_CALLS:
                        return False
                    candidate = {**pending, "lastCursor": records[count - 1]["cursor"]}
                    body = {"events": [record["event"] for record in records[:count]], "progress": candidate}
                    return _within_body_budget(json.dumps(body, sort_keys=True, separators=(",", ":"), allow_nan=False))

                # Prefix budgets are monotonic. Binary search avoids repeatedly
                # serializing every growing prefix of a large backlog.
                low, high, selected = 1, len(records), 0
                while low <= high:
                    middle = (low + high) // 2
                    if fits(middle):
                        selected, low = middle, middle + 1
                    else:
                        high = middle - 1
                if not selected:
                    raise RuntimeError("First retained telemetry event exceeds server work/structure/byte limits; preserve WAL for reconciliation.")
                pending["lastCursor"] = records[selected - 1]["cursor"]
                state["pending"] = pending
            return {"events": [record["event"] for record in state["records"] if record["cursor"] <= pending["lastCursor"]],
                    "progress": copy.deepcopy(pending)}

        return await self._operate(mutate)

    async def bind(self, wal_id: str, acknowledged: int, produced: int, last_batch_id: str = "", last_batch_digest: str = "") -> None:
        def mutate(state):
            if (wal_id != state["walId"] or not _cursor(acknowledged) or not _cursor(produced) or
                produced < acknowledged or produced > state["producedCursor"] or acknowledged < state["acknowledgedCursor"]):
                raise RuntimeError("Controller and retained telemetry WAL disagree; do not reset either history.")
            if acknowledged != state["acknowledgedCursor"]:
                if state["pending"] is None or acknowledged != state["pending"]["lastCursor"]:
                    raise RuntimeError("Controller telemetry acknowledgement is not a retained complete batch.")
                pending = state["pending"]
                body = {"events": [record["event"] for record in state["records"] if record["cursor"] <= pending["lastCursor"]], "progress": pending}
                digest = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
                if pending["batchId"] != last_batch_id or digest != last_batch_digest:
                    raise RuntimeError("Controller telemetry batch identity differs from retained payload; preserve both histories.")
                state["acknowledgedCursor"] = acknowledged
                state["records"] = [record for record in state["records"] if record["cursor"] > acknowledged]
                state["pending"] = None

        await self._operate(mutate)

    async def acknowledge(self, batch: dict, response: dict) -> None:
        progress = batch["progress"]
        if (not isinstance(response, dict) or set(response) != {"walId", "acknowledgedCursor", "producedCursor", "lastBatchId", "lastBatchDigest"} or
            response["walId"] != self.wal_id or response["acknowledgedCursor"] != progress["lastCursor"] or
            not _cursor(response["producedCursor"]) or response["producedCursor"] < response["acknowledgedCursor"]):
            raise RuntimeError("Controller did not acknowledge the exact telemetry batch.")
        await self.bind(response["walId"], response["acknowledgedCursor"], response["producedCursor"], response["lastBatchId"], response["lastBatchDigest"])

    async def close(self):
        self._closed = True
        await asyncio.gather(*tuple(self._operations), return_exceptions=True)
        if not self._file_lock.closed:
            fcntl.flock(self._file_lock.fileno(), fcntl.LOCK_UN)
            self._file_lock.close()

    def _write(self, state):
        encoded = json.dumps(state, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
        if len(encoded) > MAX_BYTES:
            raise WALCapacityError("Telemetry progress WAL byte capacity is exhausted; preserve state and reconcile.")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        with temporary.open("wb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(self.path)
        descriptor = os.open(self.path.parent, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    @staticmethod
    def _validate(state):
        def require(condition):
            if not condition:
                raise ValueError("Invalid WAL state")

        try:
            require(isinstance(state, dict) and set(state) == {"version", "walId", "acknowledgedCursor", "producedCursor", "records", "pending"})
            require(type(state["version"]) is int and state["version"] == 1 and str(uuid.UUID(state["walId"])) == state["walId"])
            require(_cursor(state["acknowledgedCursor"]) and _cursor(state["producedCursor"]))
            records = state["records"]
            require(isinstance(records, list) and len(records) <= MAX_RECORDS)
            require(state["producedCursor"] - state["acknowledgedCursor"] == len(records))
            for offset, record in enumerate(records, start=1):
                require(set(record) == {"cursor", "event"} and _cursor(record["cursor"]) and record["cursor"] == state["acknowledgedCursor"] + offset and isinstance(record["event"], dict))
            pending = state["pending"]
            if pending is not None:
                require(set(pending) == {"walId", "batchId", "firstCursor", "lastCursor", "producedCursor"})
                require(pending["walId"] == state["walId"] and str(uuid.UUID(pending["batchId"])) == pending["batchId"])
                require(all(_cursor(pending[key]) for key in ("firstCursor", "lastCursor", "producedCursor")))
                require(pending["firstCursor"] == state["acknowledgedCursor"] + 1)
                require(1 <= pending["lastCursor"] - pending["firstCursor"] + 1 <= 1000)
                require(pending["lastCursor"] <= pending["producedCursor"] <= state["producedCursor"])
        except (AssertionError, KeyError, TypeError, ValueError, AttributeError) as error:
            raise ValueError("Telemetry progress WAL is malformed or discontinuous; preserve it for recovery.") from error


def _cursor(value):
    return type(value) is int and 0 <= value <= MAX_CURSOR


def _within_body_budget(encoded: str) -> bool:
    if len(encoded.encode()) > MAX_BODY_BYTES:
        return False
    quoted = escaped = False
    depth = tokens = 0
    for character in encoded:
        if quoted:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                quoted = False
        elif character == '"':
            quoted = True
        elif character in "{[":
            depth += 1
            tokens += 1
            if depth > MAX_BODY_DEPTH:
                return False
        elif character in "}]":
            depth -= 1
            tokens += 1
        elif character in ",:":
            tokens += 1
        if tokens > MAX_STRUCTURAL_TOKENS:
            return False
    return True
