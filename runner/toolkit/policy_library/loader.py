from __future__ import annotations

import json
from pathlib import Path

from .domain import (
    PolicyImplementationRef,
    PolicyParameterSpec,
    PolicyRuleSpec,
    PolicySpec,
    PolicyTag,
    PolicyTestCaseSpec,
)
from .frameworks import framework_tags_for_policy


_ASSET_DIR = Path(__file__).resolve().parent / "assets"
_ASSET_PATHS = (
    _ASSET_DIR / "builtin_policies.json",
    _ASSET_DIR / "local_content_filters.json",
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
    declared_tags = tuple(PolicyTag(**item) for item in payload.get("tags", ()))
    framework_tags = framework_tags_for_policy(str(payload["id"]))
    tags = tuple(
        {
            tag.id: tag
            for tag in (*framework_tags, *declared_tags)
        }.values()
    )
    return PolicySpec(
        id=str(payload["id"]),
        name=str(payload["name"]),
        description=str(payload["description"]),
        source=str(payload["source"]),
        version=str(payload["version"]),
        tags=tags,
        parameters=tuple(
            PolicyParameterSpec(**item) for item in payload.get("parameters", ())
        ),
        rules=tuple(_rule(str(payload["id"]), item) for item in payload.get("rules", ())),
        test_cases=tuple(_test_case(item) for item in payload.get("test_cases", ())),
        safety_level=str(payload.get("safety_level", "balanced")),
        output_delivery=str(payload.get("output_delivery", "window_buffered")),
    )


def _rule(policy_id: str, payload: dict[str, object]) -> PolicyRuleSpec:
    values = dict(payload)
    if not values.get("taxonomy_ids"):
        raise RuntimeError(
            f"Policy {policy_id!r} Rule {values.get('id')!r} must declare taxonomy_ids."
        )
    values["rails"] = tuple(values.get("rails", ()))
    values["implementation"] = PolicyImplementationRef(
        **values["implementation"]
    )
    for field in (
        "identifiers",
        "conditions",
        "keywords",
        "always_block",
        "exceptions",
        "phrase_patterns",
        "taxonomy_ids",
    ):
        values[field] = tuple(
            tuple(item) if isinstance(item, list) else item
            for item in values.get(field, ())
        )
    return PolicyRuleSpec(**values)


def _test_case(payload: dict[str, object]) -> PolicyTestCaseSpec:
    values = dict(payload)
    values["covered_rule_ids"] = tuple(values.get("covered_rule_ids", ()))
    values["parameter_names"] = tuple(values.get("parameter_names", ()))
    return PolicyTestCaseSpec(**values)
