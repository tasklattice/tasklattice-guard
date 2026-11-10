"""Laya input Topic Control, including its dedicated topic-only profile."""
from __future__ import annotations

from dataclasses import replace
import json
import re

from .contracts import EvaluationRequest
from .policy_prompt import definition_provenance, definition_revision, questions_for
from .laya import LAYA_TOPIC_PROFILE, LayaNoulEvaluator

def topic_parts(text: str) -> tuple[str, ...]:
    # Coverage signal, not a task extractor. Never independently classify
    # fragments: that would lose references across sentences.
    parts = tuple(part.strip() for part in re.split(r"(?<=[.!?])\s+|[。！？；;\n]+", text) if part.strip())
    return parts if len(parts) > 1 else ()


def compound_request(text: str) -> bool:
    # Conservative abstention: conjunctions may join tasks, and this checkpoint
    # can confidently classify only the allowed half. A reviewer sees the full
    # request and can distinguish one topic from multiple tasks.
    return bool(topic_parts(text) or re.search(r"\b(?:and|also|then|additionally|plus)\b|另外|同时|并且|还要", text, re.I))


def topic_questions(request: EvaluationRequest, *, stage: str) -> dict[str, dict[str, object]]:
    """Select the Policy entries the configured scope enables for this stage."""
    configured = dict(request.parameters)
    mode = configured.get("topic_mode", "strict")
    if mode not in {"strict", "permissive"}:
        raise ValueError("Unsupported topic mode.")
    selected: dict[str, dict[str, object]] = {}
    if configured.get("restricted_topics", "").strip():
        selected.update(questions_for(request, provider="laya", stage=stage, when="denied"))
    if mode != "permissive":
        when = "unlisted_allowed" if stage == "primary" and configured.get("allowed_topics", "").strip() else (
            "unlisted" if stage == "review" else "unlisted_open")
        selected.update(questions_for(request, provider="laya", stage=stage, when=when))
    return selected


class LayaTopicEvaluator(LayaNoulEvaluator):
    id = "laya-topic"
    scope_label = "input Topic Control"
    display_name = "Laya Topic Control"
    operation = "topic_classification"
    capabilities = frozenset({"topic_control"})
    contracts = frozenset({"tali.guard.topic-control.semantic.v1"})
    reasons = {"matched": "A requested task violates the configured topic boundary.",
               "not_matched": "No requested task violates the configured topic boundary.",
               "unknown": "Laya probabilities fall within the configured uncertainty interval."}

    def __init__(self, *, profile_ref: str = LAYA_TOPIC_PROFILE, **kwargs):
        super().__init__(profile_ref=profile_ref, **kwargs)

    def questions(self, request: EvaluationRequest) -> dict[str, dict[str, object]]:
        # Preserve the configured scope/empty-rule behavior of the canonical
        # questions, but keep dynamic topics out of the fixed question budget.
        return topic_questions(request, stage="primary")

    def model_state(self, request: EvaluationRequest) -> dict[str, object]:
        state = self.state(request)
        configured = dict(request.parameters)
        result = {"request": state["current_input"]}
        if configured.get("topic_mode", "strict") != "permissive":
            result["topic"] = configured.get("allowed_topics", "")
        if configured.get("restricted_topics", "").strip():
            result["restricted_topics"] = configured["restricted_topics"]
        if state["context_messages"]:
            result["context_messages"] = state["context_messages"]
        return result

    def review_questions(self, request: EvaluationRequest) -> dict[str, dict[str, object]]:
        return topic_questions(request, stage="review")

    def revision(self, request: EvaluationRequest) -> str:
        return definition_revision(request, provider="laya")

    def evidence_extra(self, request: EvaluationRequest) -> dict[str, object]:
        return definition_provenance(request, provider="laya")

    async def evaluate_primary(self, request: EvaluationRequest):
        result = await super().evaluate_primary(request)
        if result.verdict == "error" or not self.questions(request):
            return result
        configured = dict(request.parameters)
        # Coverage decisions describe the same inference, including the
        # mode-derived request budget, rather than a new native request.
        request_budget = json.loads(result.trace[0].evidence)["request_budget"]
        # The native encoder does not reliably evaluate the union of a list:
        # both confident false positives and false negatives were observed.
        # Preserve its scores, but require full-policy review in either direction.
        counts = {key: len([part for part in re.split(r"[\n;；]+", configured.get(key, "")) if part.strip()])
                  for key in ("allowed_topics", "restricted_topics")}
        if any(count > 1 for count in counts.values()):
            reason = "Laya cannot establish complete coverage of a multi-topic policy; independent review is required."
            trace = self._trace(request, "unknown", reason, {}, model_metadata={
                "topic_counts": counts, "coverage": "multi_topic_scope_unverified"}, request_budget=request_budget)
            return replace(result, verdict="unknown", findings=(), reason=reason, evidence=reason,
                           trace=(*result.trace, replace(trace, id=trace.id + ":coverage")), unknown_reason="uncertain")
        if result.verdict == "matched":
            return result
        parts = topic_parts(request.content)
        if compound_request(request.content):
            reason = "Laya cannot establish that every task in a compound request is in scope; independent review is required."
            trace = self._trace(request, "unknown", reason, {}, model_metadata={"sentence_count": len(parts),
                "coverage": "compound_scope_unverified"}, request_budget=request_budget)
            return replace(result, verdict="unknown", reason=reason, evidence=reason,
                           trace=(*result.trace, replace(trace, id=trace.id + ":coverage")), unknown_reason="uncertain")
        return result
