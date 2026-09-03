from __future__ import annotations

import json

from runner.toolkit.safety.mappings import provider_mapping
from runner.toolkit.safety.taxonomy import (
    TALI_TAXONOMY_ID,
    TALI_TAXONOMY_VERSION,
    taxonomy,
)
from runner.toolkit.policy_library.registry import policies
from runner.toolkit.policy_library.loader import _ASSET_PATHS


def test_tali_taxonomy_is_versioned_and_hierarchical() -> None:
    registry = taxonomy()

    assert registry.id == TALI_TAXONOMY_ID
    assert registry.version == TALI_TAXONOMY_VERSION
    assert len(registry.checksum) == 64
    assert registry.is_descendant("TALI-PRIVACY-PII", "TALI-PRIVACY")
    assert registry.get("TALI-MODEL-SECURITY-JAILBREAK").scopes == ("input",)


def test_vendor_categories_map_to_canonical_tali_categories() -> None:
    qwen = provider_mapping("qwen3guard", "Unethical Acts")
    llama = provider_mapping("llama_guard_3", "S14")

    assert qwen is not None
    assert qwen.taxonomy_id == "TALI-SOCIAL-HARM"
    assert qwen.quality == "partial"
    assert qwen.requires_refinement is True
    assert llama is not None
    assert llama.taxonomy_id == "TALI-TOOL-SECURITY-CODE-INTERPRETER-ABUSE"
    assert llama.quality == "direct"


def test_every_policy_asset_declares_a_tali_category() -> None:
    raw_rules = tuple(
        rule
        for path in _ASSET_PATHS
        for policy in json.loads(path.read_text())
        for rule in policy["rules"]
    )
    assert raw_rules
    assert all(rule.get("taxonomy_ids") for rule in raw_rules)


def test_every_loaded_policy_rule_has_a_valid_tali_category() -> None:
    registry = taxonomy()
    rules = tuple(rule for item in policies() for rule in item.rules)

    assert rules
    assert all(rule.taxonomy_ids for rule in rules)
    assert all(
        registry.contains(category_id)
        for rule in rules
        for category_id in rule.taxonomy_ids
    )
