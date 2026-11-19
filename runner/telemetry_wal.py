"""Append-only telemetry spool with durable acknowledgements.

Only the next batch is read during delivery. Compaction copies the remaining
tail only after at least half of the file has been acknowledged, making total
copying amortized linear in bytes delivered, rather than backlog * batches.
The inode-bound cursor makes an interrupted atomic compaction replay-safe.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class WalRecord:
    line: str
    end: int


class TelemetryWal:
    def __init__(self, path: Path, compact_after_bytes: int = 8 * 1024 * 1024):
        self.path = path
        self.cursor_path = path.with_suffix(".cursor")
        self.compact_after_bytes = compact_after_bytes
        self.offset = 0
        if path.exists() and self.cursor_path.exists():
            saved = json.loads(self.cursor_path.read_text())
            stat = path.stat()
            if saved["device"] == stat.st_dev and saved["inode"] == stat.st_ino:
                offset = saved["offset"]
                if not isinstance(offset, int) or not 0 <= offset <= stat.st_size:
                    raise RuntimeError("Invalid telemetry WAL acknowledgement cursor")
                self.offset = offset
        # A single streaming scan on startup; never allocate the whole backlog.
        self.count = 0
        if path.exists():
            with path.open("rb") as stream:
                stream.seek(self.offset)
                self.count = sum(bool(line.strip()) for line in stream)

    @property
    def pending_bytes(self) -> int:
        return self.path.stat().st_size - self.offset if self.path.exists() else 0

    def append(self, encoded: str) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("ab") as stream:
            stream.write(encoded.encode("utf-8"))
            stream.flush()
        self.count += 1

    def peek(self, limit: int) -> list[WalRecord]:
        records: list[WalRecord] = []
        if not self.path.exists():
            return records
        with self.path.open("rb") as stream:
            stream.seek(self.offset)
            while len(records) < limit:
                if records and stream.tell() - self.offset >= 8 * 1024 * 1024:
                    break
                line = stream.readline()
                if not line:
                    break
                if line.strip():
                    records.append(WalRecord(line.decode("utf-8").rstrip("\r\n"), stream.tell()))
        return records

    def acknowledge(self, records: list[WalRecord]) -> None:
        if not records:
            return
        if self.peek(len(records)) != records:
            raise RuntimeError("Runtime telemetry WAL changed unexpectedly during delivery.")
        stat = self.path.stat()
        offset = records[-1].end
        temporary = self.cursor_path.with_suffix(".cursor.tmp")
        with temporary.open("w", encoding="utf-8") as stream:
            json.dump({"device": stat.st_dev, "inode": stat.st_ino, "offset": offset}, stream)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(self.cursor_path)
        self.offset = offset
        self.count -= len(records)
        # Failure to compact does not undo a durable ACK. Retry reclamation on
        # the next ACK; callers still see the pending suffix via the cursor.
        if offset == stat.st_size or (offset >= self.compact_after_bytes and offset * 2 >= stat.st_size):
            try:
                self._compact()
            except OSError:
                logging.getLogger(__name__).warning("Telemetry WAL compaction failed; acknowledged cursor retained for retry", exc_info=True)

    def _compact(self) -> None:
        temporary = self.path.with_suffix(".wal.tmp")
        with self.path.open("rb") as source, temporary.open("wb") as target:
            source.seek(self.offset)
            shutil.copyfileobj(source, target, length=1024 * 1024)
            target.flush()
            os.fsync(target.fileno())
        temporary.replace(self.path)
        # The persisted cursor belongs to the old inode. If interrupted here,
        # startup ignores it and reads the complete, unacknowledged new file.
        self.offset = 0
