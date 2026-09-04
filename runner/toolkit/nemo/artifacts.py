from __future__ import annotations

import hashlib
import json
from dataclasses import asdict

from ..runtime.contracts import NeMoConfigSnapshot


def config_checksum(snapshot: NeMoConfigSnapshot) -> str:
    """Return the immutable identity of the complete runtime snapshot."""
    payload = asdict(snapshot)
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()
