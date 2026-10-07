from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

from ..policy_runtime.domain import PolicySpec
from ..policy_runtime.codec import policy_from_payload
from .frameworks import framework_tags_for_policy


_ASSET_DIR = Path(__file__).resolve().parent / "assets"
_ASSET_PATHS = (
    _ASSET_DIR / "builtin_policies.json",
    _ASSET_DIR / "local_content_filters.json",
    _ASSET_DIR / "model_capability_policies.json",
    _ASSET_DIR / "focused_policies.json",
    _ASSET_DIR / "china_policies.json",
    _ASSET_DIR / "configurable_policies.json",
    _ASSET_DIR / "custom_policies.json",
)


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
            # Later, focused asset collections may intentionally replace a legacy
            # definition while keeping the public Policy ID stable.
            merged[str(item["id"])] = item
    return tuple(_policy(item) for item in merged.values())


def _policy(payload: dict[str, object]) -> PolicySpec:
    definition = policy_from_payload(payload)
    tags = {tag.id: tag for tag in (*framework_tags_for_policy(definition.id), *definition.tags)}
    return replace(definition, tags=tuple(tags.values()))
