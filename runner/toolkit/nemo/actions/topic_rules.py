from __future__ import annotations

import re
import unicodedata

from ...runtime.contracts import RiskFinding
from ...safety.taxonomy import taxonomy_for_evaluator
from .contracts import ActionRequest, ActionResult, action_result
from .names import ACTION_TOPIC_RULES


class TopicRulesActionProvider:
    """Apply explicit topic allow/restrict rules before semantic topic judging."""

    name = ACTION_TOPIC_RULES
    version = "1.0.0"
    capabilities = frozenset({"topic_control"})
    rails = frozenset({"input", "output"})

    async def execute(self, request: ActionRequest) -> ActionResult:
        parameters = dict(request.parameters)
        allowed = _policy_lines(parameters.get("allowed_topics", ""))
        restricted = _policy_lines(parameters.get("restricted_topics", ""))
        content = _normalize_topic(request.content)
        allowed_matches = tuple(item for item in allowed if item in content)
        restricted_matches = tuple(item for item in restricted if item in content)

        if restricted_matches and not allowed_matches:
            evidence = ", ".join(restricted_matches[:3])
            return action_result(
                request,
                "unsafe",
                request.content,
                findings=(
                    RiskFinding(
                        risk="topic_control",
                        taxonomy_id=taxonomy_for_evaluator("topic_control"),
                        verdict="unsafe",
                        confidence=0.98,
                        evidence=f"Matched an explicitly restricted topic: {evidence}.",
                        recommended_action=request.proposed_action,
                    ),
                ),
                reason="The request directly matched an explicitly restricted topic.",
            )
        if allowed_matches and not restricted_matches:
            return action_result(
                request,
                "safe",
                request.content,
                reason="The request directly matched an explicitly allowed topic.",
            )
        reason = (
            "The request matched both allowed and restricted topic language; "
            "primary intent needs deeper review."
            if allowed_matches and restricted_matches
            else "The request did not directly match an explicit topic boundary; "
            "primary intent needs deeper review."
        )
        return action_result(
            request,
            "uncertain",
            request.content,
            findings=(
                RiskFinding(
                    risk="topic_control",
                    taxonomy_id=taxonomy_for_evaluator("topic_control"),
                    verdict="uncertain",
                    confidence=0.5,
                    evidence=reason,
                    recommended_action=request.proposed_action,
                ),
            ),
            reason=reason,
        )


def _policy_lines(value: str) -> tuple[str, ...]:
    return tuple(
        normalized
        for item in value.splitlines()
        if (normalized := _normalize_topic(item))
    )


def _normalize_topic(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return " ".join(re.sub(r"[^\w\u3400-\u9fff]+", " ", normalized).split())
