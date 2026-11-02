from __future__ import annotations

from ...runtime.contracts import RiskFinding
from ...safety.taxonomy import taxonomy_for_evaluator
from .contracts import ActionRequest, ActionResult, action_result
from .names import ACTION_TOPIC_RULES


class TopicRulesActionProvider:
    """Require semantic judgment for all Topic boundaries."""

    name = ACTION_TOPIC_RULES
    version = "1.0.0"
    capabilities = frozenset({"topic_control"})
    rails = frozenset({"input", "output"})

    async def execute(self, request: ActionRequest) -> ActionResult:
        reason = "Topic allowlist and deny-list boundaries require semantic review of all requested tasks; an allowed keyword cannot bypass denied topics."
        return action_result(
            request,
            "unknown",
            request.content,
            findings=(
                RiskFinding(
                    risk="topic_control",
                    taxonomy_id=taxonomy_for_evaluator("topic_control"),
                    verdict="unknown",
                    confidence=0.5,
                    evidence=reason,
                    recommended_action=request.proposed_action,
                ),
            ),
            reason=reason,
        )
