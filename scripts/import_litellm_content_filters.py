#!/usr/bin/env python3
"""Build TaskLattice's 22 local content-filter Policies from pinned LiteLLM data.

The generated catalog is runtime-independent: TaskLattice does not import or call
LiteLLM. This importer is retained only to make provenance and future reviews
reproducible.
"""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path
from typing import Any

import yaml


REVISION = "ead62528e607b9d8e61273def638799c9c3a69ba"
BASE = (
    "litellm/proxy/guardrails/guardrail_hooks/"
    "litellm_content_filter"
)
CATEGORY_NAMES = (
    "denied_financial_advice",
    "denied_insults",
    "denied_legal_advice",
    "denied_medical_advice",
    "harmful_violence",
    "harmful_self_harm",
    "harmful_child_safety",
    "harmful_illegal_weapons",
    "bias_gender",
    "bias_racial",
    "bias_religious",
    "bias_sexual_orientation",
    "prompt_injection_jailbreak",
    "prompt_injection_data_exfiltration",
    "prompt_injection_sql",
    "prompt_injection_malicious_code",
    "prompt_injection_system_prompt",
    "harm_toxic_abuse",
)
MISSING_PATTERN_SAMPLES = {
    # The pinned upstream TFN pattern accepts contiguous digits; an older
    # TaskLattice acceptance sample used a locally broadened spaced form.
    "au_tfn": "Tax file number 111111111.",
    "url": "The private endpoint is https://example.com/internal.",
    "weapons_firearms": "The firearm was found in the room.",
    "weapons_other": "The suspect carried a switchblade.",
    "explosives": "Instructions for a pipe bomb are prohibited.",
    "violence_threats": "They sent a death threat yesterday.",
    "terrorism": "The message promoted a terrorist attack.",
    "self_harm_suicide": "The message says I want to die.",
    "illegal_activities": "The request describes money laundering.",
    "harassment_hate": "The account was used for doxxing.",
    "ca_sin": "Social insurance number 123-456-789.",
    "ca_ohip": "OHIP number 1234-567-890 AB.",
    "ca_on_drivers_licence": "Driver's licence A1234-56789-01234.",
    "ca_immigration_doc": "UCI 1234-5678-90.",
    "ca_bank_account": "Bank account 12345-001-1234567.",
    "ca_postal_code": "Postal code M5V 3A8.",
    "uoft_student_id": "University of Toronto student number 1000000000.",
    "uoft_utorid": "UTORid smith123.",
    "uoft_tcard": "TCard number 1234567890123456.",
}


def _git_show(repo: Path, revision: str, path: str) -> str:
    result = subprocess.run(
        ("git", "-C", str(repo), "show", f"{revision}:{path}"),
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout


def _implementation(form: str, binding_id: str, rule_id: str) -> dict[str, Any]:
    return {
        "engine": "nemo-guardrails",
        "form": form,
        "binding_id": binding_id,
        "implementation_rule_id": rule_id,
        "detector": form,
        "flow_name": None,
        "action_name": "GuardContentFilterAction",
    }


def _tags(form: str, capability: str) -> list[dict[str, str]]:
    return [
        {
            "namespace": "collection",
            "value": "local-content-filter",
            "label": "Local Content Filter",
            "source": "declared",
        },
        {
            "namespace": "capability",
            "value": capability,
            "label": capability.replace("-", " ").title(),
            "source": "declared",
        },
        {
            "namespace": "implementation",
            "value": form.replace("_", "-"),
            "label": form.replace("_", " ").title(),
            "source": "derived",
        },
        {
            "namespace": "stage",
            "value": "input",
            "label": "Before model",
            "source": "derived",
        },
        {
            "namespace": "stage",
            "value": "output",
            "label": "After model",
            "source": "derived",
        },
    ]


def _category_payload(
    repo: Path,
    revision: str,
    name: str,
) -> dict[str, Any]:
    if name == "harm_toxic_abuse":
        entries = json.loads(
            _git_show(repo, revision, f"{BASE}/categories/{name}.json")
        )
        severity_map = {1: "low", 2: "medium", 3: "high", 4: "high"}
        keywords = [
            (phrase.strip(), severity_map.get(item.get("severity", 2), "medium"))
            for item in entries
            for phrase in str(item.get("match", "")).split("|")
            if phrase.strip()
        ]
        return {
            "category_name": name,
            "display_name": "Toxic & Abusive Language",
            "description": "Detects harmful, toxic, abusive, and hateful language.",
            "default_action": "BLOCK",
            "keywords": keywords,
            "always_block": [],
            "exceptions": [],
            "identifiers": [],
            "conditions": [],
            "phrase_patterns": [],
        }

    payload = yaml.safe_load(
        _git_show(repo, revision, f"{BASE}/categories/{name}.yaml")
    )
    conditions = list(payload.get("additional_block_words") or [])
    inherited = payload.get("inherit_from")
    if inherited:
        inherited_name = str(inherited).removesuffix(".json").removesuffix(".yaml")
        inherited_payload = _category_payload(repo, revision, inherited_name)
        conditions.extend(item[0] for item in inherited_payload["keywords"])

    def pairs(key: str, default_severity: str) -> list[tuple[str, str]]:
        result: list[tuple[str, str]] = []
        for item in payload.get(key) or []:
            if isinstance(item, str):
                result.append((item, default_severity))
            else:
                result.append(
                    (
                        str(item.get("keyword", "")),
                        str(item.get("severity", default_severity)),
                    )
                )
        return [item for item in result if item[0]]

    return {
        "category_name": str(payload.get("category_name", name)),
        "display_name": str(
            payload.get("display_name") or name.replace("_", " ").title()
        ),
        "description": str(payload.get("description", "")),
        "default_action": str(payload.get("default_action", "BLOCK")),
        "keywords": pairs("keywords", "medium"),
        "always_block": pairs("always_block_keywords", "high"),
        "exceptions": list(payload.get("exceptions") or []),
        "identifiers": list(payload.get("identifier_words") or []),
        "conditions": conditions,
        "phrase_patterns": list(payload.get("phrase_patterns") or []),
    }


def _category_sample(payload: dict[str, Any]) -> str:
    if payload["always_block"]:
        return f"Please review this request: {payload['always_block'][0][0]}."
    if payload["identifiers"] and payload["conditions"]:
        return (
            "Please help with "
            f"{payload['identifiers'][0]} {payload['conditions'][0]}."
        )
    eligible = [
        keyword
        for keyword, severity in payload["keywords"]
        if severity in {"medium", "high"}
    ]
    if eligible:
        return f"The message contains {eligible[0]}."
    raise RuntimeError(f"Category {payload['category_name']} has no acceptance sample.")


def _category_policy(payload: dict[str, Any]) -> dict[str, Any]:
    name = payload["category_name"]
    policy_id = f"filter-{name.replace('_', '-')}"
    rule_id = f"category/{name}"
    capability = (
        "prompt-security"
        if name.startswith("prompt_injection")
        else "content-safety"
    )
    rule = {
        "id": rule_id,
        "name": payload["display_name"],
        "description": payload["description"],
        "form": "category",
        "effect": (
            "redact" if payload["default_action"].upper() == "MASK" else "reject"
        ),
        "rails": ["input", "output"],
        "implementation": _implementation("category", name, name),
        "expression": None,
        "context_expression": None,
        "redaction": None,
        "severity_threshold": "medium",
        "identifiers": payload["identifiers"],
        "conditions": payload["conditions"],
        "keywords": payload["keywords"],
        "always_block": payload["always_block"],
        "exceptions": payload["exceptions"],
        "phrase_patterns": payload["phrase_patterns"],
    }
    return {
        "id": policy_id,
        "name": payload["display_name"],
        "description": payload["description"],
        "source": "built_in",
        "version": "1.95.0",
        "tags": _tags("category", capability),
        "parameters": [],
        "rules": [rule],
        "safety_level": "balanced",
        "output_delivery": "window_buffered",
        "test_cases": [
            {
                "id": f"accept/{name}",
                "name": f"Detect {payload['display_name']}",
                "description": "Required acceptance case for the imported local category.",
                "stage": "input",
                "content": _category_sample(payload),
                "expected_decision": "block",
                "covered_rule_ids": [rule_id],
                "group": "Rule acceptance",
                "kind": "rule_acceptance",
                "required": True,
                "parameter_names": [],
            }
        ],
    }


def _legacy_pattern_samples(catalog_path: Path) -> dict[str, str]:
    catalog = json.loads(catalog_path.read_text())
    samples: dict[str, str] = {}
    for policy in catalog:
        rules = {
            rule["id"]: rule["implementation"]["implementation_rule_id"]
            for rule in policy.get("rules", [])
            if rule.get("form") == "regex"
        }
        for case in policy.get("test_cases", []):
            if case.get("kind") != "rule_acceptance":
                continue
            for rule_id in case.get("covered_rule_ids", []):
                if rule_id in rules:
                    samples.setdefault(rules[rule_id], case["content"])
    return samples


def _pattern_policy(
    repo: Path,
    revision: str,
    legacy_catalog: Path,
) -> dict[str, Any]:
    patterns = json.loads(
        _git_show(repo, revision, f"{BASE}/patterns.json")
    )["patterns"]
    samples = _legacy_pattern_samples(legacy_catalog)
    samples.update(MISSING_PATTERN_SAMPLES)
    missing = sorted(item["name"] for item in patterns if item["name"] not in samples)
    if missing:
        raise RuntimeError("Pattern acceptance samples are missing: " + ", ".join(missing))

    rules = []
    tests = []
    for item in patterns:
        name = item["name"]
        rule_id = f"pattern/{name}"
        rules.append(
            {
                "id": rule_id,
                "name": item["display_name"],
                "description": item["description"],
                "form": "regex",
                "effect": "redact",
                "rails": ["input", "output"],
                "implementation": _implementation("regex", "pattern-matching", name),
                "expression": item["pattern"],
                "context_expression": item.get("keyword_pattern"),
                "context_max_gap_words": (
                    1 if item.get("keyword_pattern") else None
                ),
                "allow_word_numbers": bool(item.get("allow_word_numbers", False)),
                "redaction": f"[{name}_REDACTED]",
                "severity_threshold": None,
                "identifiers": [],
                "conditions": [],
                "keywords": [],
                "always_block": [],
                "exceptions": [],
                "phrase_patterns": [],
            }
        )
        tests.append(
            {
                "id": f"accept/{name}",
                "name": f"Detect {item['display_name']}",
                "description": f"Required acceptance case for {item['category']}.",
                "stage": "input",
                "content": samples[name],
                "expected_decision": "transform",
                "covered_rule_ids": [rule_id],
                "group": "Rule acceptance",
                "kind": "rule_acceptance",
                "required": True,
                "parameter_names": [],
            }
        )
    return {
        "id": "pattern-matching",
        "name": "Pattern Matching",
        "description": "Detects and masks 82 reviewed identity, credential, financial, safety, and regional data patterns locally.",
        "source": "built_in",
        "version": "1.95.0",
        "tags": _tags("regex", "sensitive-data"),
        "parameters": [],
        "rules": rules,
        "test_cases": tests,
        "safety_level": "balanced",
        "output_delivery": "window_buffered",
    }


def _keyword_policy() -> dict[str, Any]:
    rule_id = "keyword/blocked-words"
    return {
        "id": "keyword-blocking",
        "name": "Keyword Blocking",
        "description": "Blocks or masks a reviewed, line-separated list of words and phrases without an external model call.",
        "source": "built_in",
        "version": "1.95.0",
        "tags": _tags("keyword", "content-safety"),
        "parameters": [
            {
                "name": "blocked_words",
                "label": "Blocked words and phrases",
                "kind": "textarea",
                "required": True,
                "placeholder": "One word or phrase per line",
                "description": "The reviewed local deny-list for this Guardrail binding.",
            }
        ],
        "rules": [
            {
                "id": rule_id,
                "name": "Reviewed blocked words",
                "description": "Matches the configured line-separated keyword list.",
                "form": "keyword",
                "effect": "reject",
                "rails": ["input", "output"],
                "implementation": _implementation("keyword", "keyword-blocking", "blocked-words"),
                "expression": None,
                "context_expression": None,
                "redaction": "[KEYWORD_REDACTED]",
                "severity_threshold": None,
                "identifiers": [],
                "conditions": [],
                "keywords": [["{{blocked_words}}", "medium"]],
                "always_block": [],
                "exceptions": [],
                "phrase_patterns": [],
            }
        ],
        "test_cases": [
            {
                "id": "accept/blocked-words",
                "name": "Detect a reviewed blocked phrase",
                "description": "Required acceptance case for the configured deny-list.",
                "stage": "input",
                "content": "The phrase {{blocked_words}} is prohibited.",
                "expected_decision": "block",
                "covered_rule_ids": [rule_id],
                "group": "Rule acceptance",
                "kind": "rule_acceptance",
                "required": True,
                "parameter_names": ["blocked_words"],
            }
        ],
        "safety_level": "balanced",
        "output_delivery": "window_buffered",
    }


def _code_policy() -> dict[str, Any]:
    rule_id = "code/execution"
    return {
        "id": "block-code-execution",
        "name": "Block Code Execution",
        "description": "Detects executable fenced code and explicit execution requests while allowing explanation and review intent.",
        "source": "built_in",
        "version": "1.95.0",
        "tags": _tags("code_block", "code-safety"),
        "parameters": [
            {
                "name": "blocked_languages",
                "label": "Blocked languages",
                "kind": "textarea",
                "required": False,
                "placeholder": "Blank for all, or one language per line",
                "description": "Language aliases such as py, js, sh, and ts are normalized.",
            },
            {
                "name": "confidence_threshold",
                "label": "Confidence threshold",
                "kind": "text",
                "required": False,
                "placeholder": "0.5",
                "description": "A value from 0 to 1; blank uses 0.5.",
            },
            {
                "name": "detect_execution_intent",
                "label": "Require execution intent on input",
                "kind": "text",
                "required": False,
                "placeholder": "true",
                "description": "Blank defaults to true. Output code is always enforced.",
            },
        ],
        "rules": [
            {
                "id": rule_id,
                "name": "Executable code and execution intent",
                "description": "Detects fenced executable code and explicit requests to execute commands.",
                "form": "code_block",
                "effect": "reject",
                "rails": ["input", "output"],
                "implementation": _implementation("code_block", "block-code-execution", "execution"),
                "expression": None,
                "context_expression": None,
                "redaction": "[CODE_BLOCK_REDACTED]",
                "severity_threshold": None,
                "identifiers": [],
                "conditions": [],
                "keywords": [],
                "always_block": [],
                "exceptions": [],
                "phrase_patterns": [],
            }
        ],
        "test_cases": [
            {
                "id": "accept/code-execution",
                "name": "Block an executable Python request",
                "description": "Required acceptance case for executable fenced code.",
                "stage": "input",
                "content": "Please run this code:\n```python\nprint('hello')\n```",
                "expected_decision": "block",
                "covered_rule_ids": [rule_id],
                "group": "Rule acceptance",
                "kind": "rule_acceptance",
                "required": True,
                "parameter_names": [],
            }
        ],
        "safety_level": "strict",
        "output_delivery": "full_buffered",
    }


def _competitor_policy(legacy_catalog: Path) -> dict[str, Any]:
    catalog = json.loads(legacy_catalog.read_text())
    previous = next(
        item for item in catalog if item["id"] == "competitor-mention-detection"
    )
    rule_id = "competitor/intent"
    scenarios = [
        {
            **case,
            "covered_rule_ids": [rule_id],
        }
        for case in previous["test_cases"]
        if case.get("group") != "Rule acceptance"
    ]
    return {
        "id": "competitor-mention-detection",
        "name": "Competitor Name Blocking",
        "description": "Detects reviewed competitor entities, aliases, obfuscation, recommendations, comparisons, and category-ranking intent while allowing destination and service questions.",
        "source": "built_in",
        "version": "1.95.0",
        "tags": _tags("competitor_intent", "brand-safety"),
        "parameters": previous["parameters"],
        "rules": [
            {
                "id": rule_id,
                "name": "Competitor entity and comparison intent",
                "description": "Normalizes aliases and obfuscation, then distinguishes competitor intent from destination and operational context.",
                "form": "competitor_intent",
                "effect": "reject",
                "rails": ["input", "output"],
                "implementation": _implementation("competitor_intent", "competitor", "intent"),
                "expression": None,
                "context_expression": None,
                "redaction": "[COMPETITOR_CONTENT_REDACTED]",
                "severity_threshold": None,
                "identifiers": [],
                "conditions": [],
                "keywords": [],
                "always_block": [],
                "exceptions": [],
                "phrase_patterns": [],
            }
        ],
        "test_cases": [
            {
                "id": "accept/competitor-intent",
                "name": "Detect a reviewed competitor comparison",
                "description": "Required acceptance case for normalized competitor intent.",
                "stage": "input",
                "content": "Compare {{competitors}} with {{brand_name}}.",
                "expected_decision": "block",
                "covered_rule_ids": [rule_id],
                "group": "Rule acceptance",
                "kind": "rule_acceptance",
                "required": True,
                "parameter_names": ["competitors", "brand_name"],
            },
            *scenarios,
        ],
        "safety_level": "balanced",
        "output_delivery": "window_buffered",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--litellm-repo", type=Path, required=True)
    parser.add_argument("--revision", default=REVISION)
    parser.add_argument(
        "--legacy-catalog",
        type=Path,
        default=Path("runner/toolkit/policy_library/assets/builtin_policies.json"),
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("runner/toolkit/policy_library/assets/local_content_filters.json"),
    )
    args = parser.parse_args()

    policies = [
        _category_policy(
            _category_payload(args.litellm_repo, args.revision, name)
        )
        for name in CATEGORY_NAMES
    ]
    policies.extend(
        (
            _pattern_policy(
                args.litellm_repo,
                args.revision,
                args.legacy_catalog,
            ),
            _keyword_policy(),
            _code_policy(),
            _competitor_policy(args.legacy_catalog),
        )
    )
    if len(policies) != 22:
        raise RuntimeError(f"Expected 22 local content filters, got {len(policies)}.")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(policies, ensure_ascii=False, indent=2) + "\n"
    )


if __name__ == "__main__":
    main()
