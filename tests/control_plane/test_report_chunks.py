from __future__ import annotations

import asyncio
import gzip
import hashlib

import pytest

from runner import generated as protocol
from runner.report_chunks import ReportSpool, BATCH_BYTES
from tests.control_plane.test_testing_report_delivery import fixture_client


def spool(cases=120):
    return ReportSpool(protocol.ValidationResult(run_id="chunked", runner_id="runner-0", accepted=True,
        status=protocol.VALIDATION_STATUS_PASSED, metrics=protocol.ValidationMetrics(total=cases, passed=cases)),
        (protocol.ValidationCaseResult(case_id=f"case-{n}", passed=True, output_content="x" * 40000) for n in range(cases)))


def test_spool_bounds_each_batch_and_preserves_evidence_and_manifest():
    report = spool()
    try:
        messages = list(report.messages())
        assert len(messages) > 4
        restored = []
        digests = []
        for index, message in enumerate(messages):
            chunk = message.validation_report_chunk
            assert chunk.sequence == index
            assert chunk.case_offset == len(restored)
            raw = gzip.decompress(chunk.gzip_result)
            assert len(raw) == chunk.raw_size_bytes
            assert len(raw) <= BATCH_BYTES + 10000
            assert hashlib.sha256(raw).hexdigest() == chunk.sha256
            digests.append(chunk.sha256)
            result = protocol.ValidationResult.FromString(raw)
            assert len(result.results) <= 50
            restored.extend(result.results)
        assert len(restored) == 120
        assert all(r.output_content == "x" * 40000 for r in restored)
        assert messages[-1].validation_report_chunk.final
        assert result.metrics.total == 120
        assert report.manifest_digest == hashlib.sha256("\n".join(digests).encode()).hexdigest()
        assert list(report.messages()) == messages
    finally:
        report.close()
    assert report.file.closed


@pytest.mark.asyncio
async def test_delivery_waits_for_durable_ack_and_replays_without_execution():
    client = fixture_client()
    report = spool(52)
    client._cache_report_spool(report)
    task = asyncio.create_task(client._validate(protocol.ValidationRequest(run_id="chunked")))
    try:
        for expected in report.messages():
            first = await asyncio.wait_for(client._outgoing.get(), 1)
            chunk = first.validation_report_chunk
            assert chunk == expected.validation_report_chunk
            await asyncio.sleep(0)
            assert client._outgoing.empty()
            await client._handle(protocol.ControllerMessage(validation_report_chunk_ack=protocol.ValidationReportChunkAck(
                run_id=chunk.run_id, upload_id=chunk.upload_id, sequence=chunk.sequence)))
        await asyncio.wait_for(task, 1)
        client._validator.run.assert_not_awaited()
        assert not client._chunk_acks
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        report.close()


@pytest.mark.asyncio
async def test_stop_interrupts_unacknowledged_upload_without_leaking_waiters():
    client = fixture_client()
    report = spool(1)
    task = asyncio.create_task(client._send_report_chunks(report))
    try:
        await asyncio.wait_for(client._outgoing.get(), 1)
        await client.stop()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert not client._chunk_acks
    finally:
        report.close()


def test_oversized_case_is_rejected_explicitly():
    with pytest.raises(ValueError, match="case exceeds"):
        ReportSpool(protocol.ValidationResult(run_id="large"), [protocol.ValidationCaseResult(output_content="x" * (5 * 1024 * 1024))])


@pytest.mark.asyncio
async def test_permanent_rejection_stops_retry_and_releases_disk_spool():
    client = fixture_client()
    report = spool(52)
    client._cache_report_spool(report)
    task = asyncio.create_task(client._send_report_chunks(report))
    message = await asyncio.wait_for(client._outgoing.get(), 1)
    chunk = message.validation_report_chunk
    await client._handle(protocol.ControllerMessage(validation_report_chunk_ack=protocol.ValidationReportChunkAck(
        run_id=chunk.run_id, upload_id=chunk.upload_id, sequence=chunk.sequence, rejection_code="report_rejected")))
    await asyncio.wait_for(task, 1)
    assert not client._chunk_acks
    assert not client._report_spools
    assert client._report_spool_bytes == 0
    assert report.file.closed
    assert client._outgoing.empty()
