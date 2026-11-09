from __future__ import annotations

import json
from pathlib import Path

from ..policy_runtime.domain import PolicySpec
from ..policy_runtime.codec import policy_from_payload

_ASSET_DIR = Path(__file__).resolve().parent / "assets"
_ASSET_PATHS = (_ASSET_DIR / "policies.json",)


def load_builtin_policies() -> tuple[PolicySpec, ...]:
    """Load TaskLattice's canonical, versioned built-in Policy catalog."""

    merged: dict[str, dict[str, object]] = {}
    for path in _ASSET_PATHS:
        if not path.exists():
            continue
        payload = json.loads(path.read_text())
        if not isinstance(payload, list):
            raise RuntimeError(f"The built-in Policy catalog {path.name} must be a JSON list.")
        for item in payload:
            if not isinstance(item, dict) or not item.get("id"):
                raise RuntimeError(f"The built-in Policy catalog {path.name} contains an invalid Policy.")
            if str(item["id"]) in merged:
                raise RuntimeError(f"Duplicate bundled Policy ID: {item['id']}")
            merged[str(item["id"])] = item
    return tuple(_policy(item) for item in merged.values())


def _policy(payload: dict[str, object]) -> PolicySpec:
    return policy_from_payload(payload)
