from __future__ import annotations

from dataclasses import asdict

from .domain import PolicySpec
from .registry import policies, policy


def policy_catalog() -> tuple[dict[str, object], ...]:
    return tuple(policy_payload(item) for item in policies())


def policy_payload(item: PolicySpec) -> dict[str, object]:
    return {
        "implementation": "rules",
        "id": item.id,
        "name": item.name,
        "description": item.description,
        "source": item.source,
        "version": item.version,
        "tags": tuple({**asdict(tag), "id": tag.id} for tag in item.tags),
        "parameters": tuple(asdict(parameter) for parameter in item.parameters),
        "rails": item.rails,
        "effects": item.effects,
        "forms": item.forms,
        "rules": tuple(asdict(rule) for rule in item.rules),
        "test_cases": tuple(asdict(test_case) for test_case in item.test_cases),
        "test_count": item.test_count,
        "safety_level": item.safety_level,
        "output_delivery": item.output_delivery,
    }


def policy_payload_by_id(policy_id: str) -> dict[str, object] | None:
    item = policy(policy_id)
    return policy_payload(item) if item is not None else None
