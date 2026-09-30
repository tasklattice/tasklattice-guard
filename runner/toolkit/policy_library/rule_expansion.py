"""Materialize parameterized Rule entries before detection, preserving each directive."""
from __future__ import annotations
from dataclasses import replace
import json

from .domain import PolicyRuleSpec

RISK_LEVELS = {"critical", "high", "medium", "low", "informational"}


def expand_rule(rule: PolicyRuleSpec, parameters: dict[str, str]) -> tuple[PolicyRuleSpec, ...]:
    if not rule.rule_expansion:
        return (rule,)
    spec = rule.rule_expansion
    entries = json.loads(parameters.get(spec["parameter"], "[]"))
    if not isinstance(entries, list) or not 1 <= len(entries) <= 50:
        raise ValueError("Rule entries require 1–50 items")
    result = []
    ids = set()
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) - {"id", "phrase", "action", "replacement"}:
            raise ValueError("Invalid Rule entry")
        id = entry.get("id", "")
        text = entry.get(spec["text_field"], "")
        action = entry.get(spec["action_field"], rule.effect)
        replacement = entry.get(spec["replacement_field"], rule.redaction or "[REDACTED]")
        risk = rule.risk_severity
        if not isinstance(id, str) or not 1 <= len(id.strip()) <= 100 or id.strip() in ids:
            raise ValueError("Rule entry IDs must be nonempty and unique")
        if not isinstance(text, str) or not 1 <= len(text.strip()) <= 240 or not isinstance(action, str) or action not in {"reject", "redact"}:
            raise ValueError("Rule entries require text and a supported handling action")
        if not isinstance(replacement, str) or len(replacement) > 240 or (action == "redact" and not replacement):
            raise ValueError("Rule replacement text is invalid")
        if not isinstance(risk, str) or risk not in RISK_LEVELS:
            raise ValueError("Rule risk level is invalid")
        ids.add(id.strip())
        result.append(replace(rule, id=f"{rule.id}/{id.strip()}", name=text.strip(), effect=action,
                              redaction=replacement, risk_severity=risk, rule_expansion=None,
                              keywords=(), detector_options={"terms":[text.strip()], "literal":True}))
    return tuple(result)
