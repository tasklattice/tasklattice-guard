"""Typed transport boundary for bounded, authority-free admission diagnostics."""
from __future__ import annotations

import json

from google.protobuf.json_format import ParseDict

from . import generated as protocol


def admission_snapshot_to_proto(payload: bytes) -> protocol.TenantAdmissionSnapshot:
    """Do not emit private instrumentation errors or an unbounded payload."""
    try:
        if len(payload) > 65_536:
            return protocol.TenantAdmissionSnapshot(version=1, available=False, reason="payload_limit")
        # Metrics use an internal dictionary contract. ParseDict accepts its
        # camel/snake field names while enforcing the generated message types.
        return ParseDict(json.loads(payload), protocol.TenantAdmissionSnapshot())
    except Exception:
        return protocol.TenantAdmissionSnapshot(version=1, available=False, reason="instrumentation_unavailable")
