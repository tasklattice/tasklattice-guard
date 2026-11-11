import json

import pytest

from runner.telemetry_wal import TelemetryWal


def spool(tmp_path, count=100, **options):
    path = tmp_path / "runtime-events.wal"
    # Existing versions wrote this same file without an acknowledgement cursor.
    path.write_text("".join(json.dumps({"id": index, "padding": "x" * 1000}) + "\n" for index in range(count)))
    return TelemetryWal(path, **options)


def ids(wal):
    return [json.loads(record.line)["id"] for record in wal.peek(1000)]


def test_acknowledgement_survives_restart_without_rewriting_backlog(tmp_path):
    wal = spool(tmp_path)
    original = wal.path.read_bytes()
    wal.acknowledge(wal.peek(10))
    assert wal.path.read_bytes() == original
    reopened = TelemetryWal(wal.path)
    assert reopened.count == 90
    assert ids(reopened) == list(range(10, 100))
    assert reopened.pending_bytes < len(original)


def test_acknowledgement_preserves_appends_during_upload(tmp_path):
    wal = spool(tmp_path, count=2)
    batch = wal.peek(2)
    wal.append('{"id":2}\n')
    wal.acknowledge(batch)
    assert ids(TelemetryWal(wal.path)) == [2]
    assert wal.count == 1


def test_atomic_compaction_keeps_unacknowledged_tail_with_old_cursor(tmp_path):
    wal = spool(tmp_path, compact_after_bytes=1)
    wal.acknowledge(wal.peek(60))
    # Compaction deliberately leaves the old inode-bound cursor on disk: this
    # is also the state after interruption immediately following replacement.
    assert wal.offset == 0
    reopened = TelemetryWal(wal.path, compact_after_bytes=1)
    assert ids(reopened) == list(range(60, 100))
    reopened.acknowledge(reopened.peek(40))
    assert reopened.path.read_bytes() == b""
    assert TelemetryWal(wal.path).count == 0


def test_failed_cursor_write_retains_the_batch_for_retry(tmp_path, monkeypatch):
    wal = spool(tmp_path)
    original = wal.path.read_bytes()
    def fail(_descriptor):
        raise OSError("disk full")
    monkeypatch.setattr("runner.telemetry_wal.os.fsync", fail)
    with pytest.raises(OSError, match="disk full"):
        wal.acknowledge(wal.peek(10))
    assert wal.offset == 0
    assert wal.count == 100
    assert wal.path.read_bytes() == original
    assert ids(TelemetryWal(wal.path)) == list(range(100))


def test_compaction_failure_does_not_resend_an_acknowledged_prefix(tmp_path, monkeypatch):
    wal = spool(tmp_path, compact_after_bytes=1)
    def fail(*_args, **_kwargs):
        raise OSError("disk full")
    monkeypatch.setattr("runner.telemetry_wal.shutil.copyfileobj", fail)
    wal.acknowledge(wal.peek(60))
    assert ids(TelemetryWal(wal.path)) == list(range(60, 100))
    assert wal.count == 40


def test_bounded_batch_reads_and_amortized_compaction(tmp_path, monkeypatch):
    wal = spool(tmp_path, count=1000, compact_after_bytes=1)
    copied = []
    import shutil
    copy = shutil.copyfileobj
    def observe(source, target, **kwargs):
        copied.append(wal.path.stat().st_size - source.tell())
        return copy(source, target, **kwargs)
    monkeypatch.setattr("runner.telemetry_wal.shutil.copyfileobj", observe)
    original_bytes = wal.path.stat().st_size
    for _ in range(100):
        batch = wal.peek(10)
        assert len(batch) == 10
        wal.acknowledge(batch)
    assert wal.count == 0
    assert sum(copied) < original_bytes
    assert len(copied) < 10


def test_utf8_offsets_and_blank_legacy_lines(tmp_path):
    path = tmp_path / "runtime-events.wal"
    path.write_text('\n{"id":"中文"}\n\n{"id":"后续"}\n')
    wal = TelemetryWal(path)
    wal.acknowledge(wal.peek(1))
    assert ids(TelemetryWal(path)) == ["后续"]
