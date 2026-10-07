"""Validate the complete local Policy closure carried by an Artifact."""
from __future__ import annotations

import json
from functools import lru_cache
from types import MappingProxyType
from typing import Mapping

from .codec import policy_from_payload
from .domain import PolicySpec
from ..runtime.enforcement_action_generated import ENFORCEMENT_ACTIONS
from ..safety.taxonomy import taxonomy


@lru_cache(maxsize=128)
def pinned_definitions(value: str) -> Mapping[str, PolicySpec]:
    payload = json.loads(value)
    if not isinstance(payload, dict):
        raise ValueError("Pinned Policy definitions must be a JSON object")
    definitions = {key: policy_from_payload(item) for key, item in payload.items()}
    for key, definition in definitions.items():
        if key != definition.id or not key or not definition.version or not definition.rules:
            raise ValueError("Pinned Policy identity, version and Rules are required")
        seen = set()
        for rule in definition.rules:
            if not rule.id or rule.id in seen:
                raise ValueError("Pinned Policy Rule IDs must be nonempty and unique")
            seen.add(rule.id)
            if rule.implementation.execution != "local" or rule.implementation.detector not in {
                "regex", "keyword", "conditions", "code_block",
            }:
                raise ValueError("Pinned local Policy definitions require supported local detectors")
            if rule.detector.version != "1.0.0":
                raise ValueError(f"Unsupported detector version: {rule.detector.ref}@{rule.detector.version}")
            if rule.effect not in ENFORCEMENT_ACTIONS:
                raise ValueError(f"Unknown Rule action: {rule.effect}")
            if not rule.rails or set(rule.rails) - {"input", "retrieval", "dialog", "execution", "output"}:
                raise ValueError("Pinned Policy Rules require valid rails")
            if not rule.taxonomy_ids or any(not taxonomy().contains(value) for value in rule.taxonomy_ids):
                raise ValueError("Pinned Policy Rules require known Taxonomy categories")
    return MappingProxyType(definitions)


def definitions_from_parameters(parameters: Mapping[str, str]) -> Mapping[str, PolicySpec]:
    selected = {item.strip() for item in parameters.get("policy_ids", "").splitlines() if item.strip()}
    definitions = pinned_definitions(parameters.get("policy_definitions_json", "{}"))
    versions = json.loads(parameters.get("policy_versions_json", "{}"))
    if (not isinstance(versions, dict) or selected != definitions.keys() or selected != versions.keys()
            or any(definitions[key].version != versions[key] for key in selected)):
        raise ValueError("Pinned Policy definitions do not match the selected Policy versions; all implementations must be embedded")
    for name in ("enabled_rules_json", "rule_order_json"):
        selections = json.loads(parameters.get(name, "{}"))
        if not isinstance(selections, dict) or selections.keys() - selected:
            raise ValueError(f"{name} references unavailable Policies")
        for key, ids in selections.items():
            if not isinstance(ids, list) or any(not isinstance(value, str) for value in ids):
                raise ValueError(f"{name} requires Rule ID lists")
            if len(ids) != len(set(ids)) or set(ids) - {rule.id for rule in definitions[key].rules}:
                raise ValueError(f"{name} references duplicate or unavailable Rules")
    return definitions
