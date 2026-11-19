"""TypeSafe input Topic Control, including the retained topic-only profile.

The allow/deny questions are authored in the ``business-topics`` Policy; the
adapter selects the entries the configured scope enables and substitutes the
Guardrail's topic values.
"""
from __future__ import annotations

from .contracts import EvaluationRequest
from .jev import JEV_TOPIC_PROFILE, JevNoulEvaluator
from .policy_prompt import definition_provenance, definition_revision, questions_for


def topic_questions(request: EvaluationRequest, *, stage: str = "primary") -> dict[str, dict[str, object]]:
    """Select the Policy entries the configured scope actually enables."""
    configured = dict(request.parameters)
    mode = configured.get("topic_mode", "strict")
    if mode not in {"strict", "permissive"}:
        raise ValueError("Unsupported topic mode.")
    selected: dict[str, dict[str, object]] = {}
    if configured.get("restricted_topics", "").strip():
        selected.update(questions_for(request, provider="jev", stage=stage, when="denied"))
    if mode != "permissive":
        selected.update(questions_for(request, provider="jev", stage=stage, when="unlisted"))
    return selected


class JevTopicEvaluator(JevNoulEvaluator):
    id = "typesafe-jev-topic"
    scope_label = "input Topic Control"
    display_name = "Jev Topic Control"
    operation = "topic_classification"
    capabilities = frozenset({"topic_control"})
    contracts = frozenset({"tali.guard.topic-control.semantic.v1"})
    reasons = {"matched": "A requested task violates the configured topic boundary.",
               "not_matched": "No requested task violates the configured topic boundary.",
               "unknown": "Jev probabilities fall within the configured uncertainty interval."}

    def __init__(self, *, profile_ref: str = JEV_TOPIC_PROFILE, **kwargs):
        super().__init__(profile_ref=profile_ref, **kwargs)

    def questions(self, request: EvaluationRequest) -> dict[str, dict[str, object]]:
        return topic_questions(request)

    def revision(self, request: EvaluationRequest) -> str:
        return definition_revision(request, provider="jev")

    def evidence_extra(self, request: EvaluationRequest) -> dict[str, object]:
        return definition_provenance(request, provider="jev")
