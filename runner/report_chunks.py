"""Bounded report encoding and replay; complete reports are spooled to disk.

Only one typed case, one batch and one compressed wire packet are materialized
at a time. The spool survives stream reconnects and is closed on cache eviction.
"""
from __future__ import annotations

import gzip
import hashlib
import tempfile
import uuid
from collections.abc import Iterable, Iterator
from dataclasses import dataclass

from . import generated as protocol

BATCH_BYTES = 1024 * 1024
DECODE_BYTES = 8 * 1024 * 1024
TOTAL_BYTES = 128 * 1024 * 1024


@dataclass(frozen=True)
class _Part:
    offset: int
    length: int
    raw_bytes: int
    digest: str
    case_offset: int


class ReportSpool:
    def __init__(self, metadata: protocol.ValidationResult, cases: Iterable[protocol.ValidationCaseResult]):
        self.file = tempfile.TemporaryFile(prefix="guard-report-")
        self.run_id, self.runner_id = metadata.run_id, metadata.runner_id
        self.upload_id = str(uuid.uuid4())
        self.parts: list[_Part] = []
        self.size = self.raw_bytes = self.cases = 0
        try:
            batch = protocol.ValidationResult(run_id=self.run_id, runner_id=self.runner_id)
            offset, batch_bytes = 0, 0
            for case in cases:
                size = case.ByteSize()
                if size > DECODE_BYTES // 2:
                    raise ValueError("A test case exceeds the 4 MiB report encoding budget.")
                if batch.results and (len(batch.results) >= 50 or batch_bytes + size > BATCH_BYTES):
                    self._append(batch, offset)
                    offset += len(batch.results)
                    batch.ClearField("results")
                    batch_bytes = 0
                batch.results.append(case)
                batch_bytes += size
                self.cases += 1
                if self.cases > 10000:
                    raise ValueError("Report exceeds the 10000-case budget.")
            if batch.results:
                self._append(batch, offset)
            final = protocol.ValidationResult()
            final.CopyFrom(metadata)
            final.ClearField("results")
            self._append(final, self.cases)
            self.manifest_digest = hashlib.sha256("\n".join(p.digest for p in self.parts).encode()).hexdigest()
            self.file.flush()
        except BaseException:
            self.close()
            raise

    def _append(self, result: protocol.ValidationResult, case_offset: int):
        raw = result.SerializeToString()
        self.raw_bytes += len(raw)
        if len(raw) > DECODE_BYTES or self.raw_bytes > TOTAL_BYTES:
            raise ValueError("Report exceeds its decoded size budget.")
        packed = gzip.compress(raw, compresslevel=1, mtime=0)
        self.parts.append(_Part(self.file.tell(), len(packed), len(raw), hashlib.sha256(raw).hexdigest(), case_offset))
        self.file.write(packed)
        self.size += len(packed)

    def messages(self) -> Iterator[protocol.RunnerMessage]:
        for index, part in enumerate(self.parts):
            self.file.seek(part.offset)
            yield protocol.RunnerMessage(validation_report_chunk=protocol.ValidationReportChunk(
                runner_id=self.runner_id, run_id=self.run_id, upload_id=self.upload_id,
                manifest_digest=self.manifest_digest, sequence=index, chunks=len(self.parts), cases=self.cases,
                case_offset=part.case_offset, raw_size_bytes=part.raw_bytes, sha256=part.digest,
                gzip_result=self.file.read(part.length), final=index == len(self.parts) - 1,
            ))

    def close(self):
        self.file.close()
