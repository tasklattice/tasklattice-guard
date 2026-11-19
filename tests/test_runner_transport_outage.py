from __future__ import annotations

import json
import logging

import grpc
import httpx
import pytest

from runner.outage import TransportOutage, describe_transport_error, is_transient_transport_error


class _RpcError(grpc.RpcError):
    """A status-only RpcError; grpc's own construction needs a live channel."""

    def __init__(self, code: grpc.StatusCode) -> None:
        self._code = code

    def code(self) -> grpc.StatusCode:
        return self._code


def _status_error(status: int) -> httpx.HTTPStatusError:
    request = httpx.Request("POST", "http://controller.invalid/runtime/v1/telemetry")
    return httpx.HTTPStatusError("rejected", request=request, response=httpx.Response(status, request=request))


def _events(caplog: pytest.LogCaptureFixture) -> list[dict]:
    parsed = []
    for record in caplog.records:
        if not record.name.startswith("uvicorn.error") or record.msg != "%s":
            continue
        parsed.append(json.loads(record.getMessage()))
    return parsed


def _outage(caplog: pytest.LogCaptureFixture, summary_interval_seconds: float = 60.0) -> TransportOutage:
    caplog.set_level(logging.DEBUG, logger="uvicorn.error.tasklattice.runner.transport")
    return TransportOutage("controller control stream", summary_interval_seconds=summary_interval_seconds)


def test_transient_and_permanent_failures_are_separated() -> None:
    assert is_transient_transport_error(_RpcError(grpc.StatusCode.UNAVAILABLE))
    assert is_transient_transport_error(_RpcError(grpc.StatusCode.DEADLINE_EXCEEDED))
    assert is_transient_transport_error(_RpcError(grpc.StatusCode.ABORTED))
    assert is_transient_transport_error(httpx.ConnectError("refused"))
    assert is_transient_transport_error(_status_error(503))
    # A wrong credential or a broken stream contract does not heal by retrying.
    assert not is_transient_transport_error(_RpcError(grpc.StatusCode.UNAUTHENTICATED))
    assert not is_transient_transport_error(_RpcError(grpc.StatusCode.PERMISSION_DENIED))
    assert not is_transient_transport_error(_RpcError(grpc.StatusCode.INVALID_ARGUMENT))
    assert not is_transient_transport_error(_status_error(400))
    assert not is_transient_transport_error(RuntimeError("busy"))
    # Disk failures are not transport failures.
    assert not is_transient_transport_error(FileNotFoundError("runtime-events.wal"))


def test_reason_never_repeats_peer_details() -> None:
    # grpc puts the resolved address in details(); the logged reason must not.
    assert describe_transport_error(_RpcError(grpc.StatusCode.UNAVAILABLE)) == "UNAVAILABLE"
    assert describe_transport_error(_status_error(502)) == "HTTP 502"
    assert describe_transport_error(RuntimeError("busy")) == "RuntimeError"


def test_one_outage_reports_once_then_recovers(caplog: pytest.LogCaptureFixture) -> None:
    outage = _outage(caplog)
    for _ in range(5):
        outage.failed(httpx.ConnectError("refused"), retry_in=1.0, target="controller:9090")
    assert outage.attempts == 5
    # Tracebacks stay available without being printed per attempt.
    assert [record.levelno for record in caplog.records] == [logging.WARNING] + [logging.DEBUG] * 5
    assert _events(caplog)[0] == {
        "attempts": 1, "event": "transport_unavailable", "reason": "ConnectError",
        "retry_in_s": 1.0, "subject": "controller control stream", "target": "controller:9090",
    }
    assert outage.recovered()
    assert _events(caplog)[-1]["event"] == "transport_restored"
    assert not outage.recovered()


def test_long_outage_is_summarized_instead_of_repeated(caplog: pytest.LogCaptureFixture) -> None:
    outage = _outage(caplog, summary_interval_seconds=0)
    outage.failed(httpx.ConnectError("refused"))
    outage.failed(httpx.ConnectError("refused"))
    names = [event["event"] for event in _events(caplog)]
    assert names == ["transport_unavailable", "transport_still_unavailable"]


def test_rejected_credential_is_reported_once_per_shape(caplog: pytest.LogCaptureFixture) -> None:
    outage = _outage(caplog, summary_interval_seconds=0)
    for _ in range(3):
        outage.failed(_RpcError(grpc.StatusCode.UNAUTHENTICATED))
    assert [event["event"] for event in _events(caplog)] == [
        "transport_rejected", "transport_still_rejected", "transport_still_rejected",
    ]
    # A different rejection shape is reported immediately.
    outage.failed(_RpcError(grpc.StatusCode.PERMISSION_DENIED))
    assert [event for event in _events(caplog) if event["event"] == "transport_rejected"][-1]["reason"] == (
        "PERMISSION_DENIED"
    )
    assert outage.recovered()
