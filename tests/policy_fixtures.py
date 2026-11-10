"""Test fixtures: the Policy-published classifier questions.

Production Guardrails carry these resolved values in their plan. Tests build the
same request shape instead of relying on a Runner default, which no longer exists.
"""
from __future__ import annotations

import re
from functools import lru_cache

from runner.toolkit.policy_library.loader import load_builtin_policies

CAPABILITY_POLICY = {"pii": "pii-semantic", "content_safety": "content-safety-model",
                     "jailbreak": "prompt-instruction-attacks", "topic_control": "business-topics",
                     "classifier_review": "content-safety-model"}


@lru_cache(maxsize=None)
def published_questions(policy_id: str) -> tuple[tuple[str, str], ...]:
    for policy in load_builtin_policies():
        if policy.id != policy_id:
            continue
        defaults = {parameter.name: parameter.default or "" for parameter in policy.parameters}
        for rule in policy.rules:
            raw = (rule.detector_options or {}).get("questions")
            if isinstance(raw, str) and raw.strip():
                resolved = re.sub(r"\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}", lambda match: defaults.get(match.group(1), ""), raw)
                return (("questions", resolved),)
    raise AssertionError(f"Policy {policy_id} publishes no classifier questions")


def classifier_parameters(policy_id: str, *extra: tuple[str, str]) -> tuple[tuple[str, str], ...]:
    return (*published_questions(policy_id), *extra)


def question_parameter(capability: str) -> tuple[tuple[str, str], ...]:
    """The ("questions", …) parameter a published plan carries for a capability."""
    return (("questions", published_questions(CAPABILITY_POLICY[capability])[0][1]),)
