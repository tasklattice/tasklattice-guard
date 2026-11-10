"""Direction-specific content safety through Laya."""
from __future__ import annotations

from .contracts import EvaluationRequest
from .policy_prompt import definition_provenance, definition_revision, questions_for
from .laya import LAYA_PROFILE, LayaNoulEvaluator


class LayaContentSafetyEvaluator(LayaNoulEvaluator):
    id = "laya-content-safety"
    scope_label = "input/output Content Safety"
    display_name = "Laya Content Safety"
    operation = "content_safety_classification"
    capabilities = frozenset({"content_safety"})
    contracts = frozenset({"tali.guard.content-safety.v1"})
    rails = frozenset({"input", "output"})
    decision_rule = "unanimous_safety_checks"
    reasons = {
        "matched": "The evaluated content contains or requests unsafe content under the content safety policy.",
        "not_matched": "No content safety violation was detected in the evaluated content.",
        "unknown": "Laya safety checks disagree or fall within the configured uncertainty interval.",
    }

    def __init__(self, **kwargs):
        super().__init__(profile_ref=LAYA_PROFILE, **kwargs)

    def revision(self, request: EvaluationRequest) -> str:
        return definition_revision(request, provider="laya")

    def evidence_extra(self, request: EvaluationRequest) -> dict[str, object]:
        return definition_provenance(request, provider="laya")

    def classify(self, probabilities: dict[str, float]) -> str:
        # Keep the broad safety question: an assistance-only question misses
        # some harmful requests. Neither native wording is a calibrated oracle.
        # Disagreement is abstention, never a safe result or a forced violation.
        if all(p >= self._upper for p in probabilities.values()):
            return "matched"
        if all(p <= self._lower for p in probabilities.values()):
            return "not_matched"
        return "unknown"

    def state(self, request: EvaluationRequest) -> dict[str, object]:
        if request.rail_type != "output":
            return super().state(request)
        context = [dict(role=m["role"], content=m["content"]) for m in request.context_messages[-12:]
                   if m.get("role") in {"user", "assistant"} and isinstance(m.get("content"), str)]
        if context and context[-1] == {"role": "assistant", "content": request.content}:
            context.pop()
        return {"current_output": request.content, "context_messages": context}

    def model_state(self, request: EvaluationRequest) -> str | dict[str, object]:
        # The small encoder cannot reliably distinguish an unsafe user request
        # from a safe assistant refusal in a serialized conversation. Its output
        # check classifies only the response; gray-area review gets the complete
        # context from state(), with explicit assistant-only policy criteria.
        return request.content if request.rail_type == "output" else super().model_state(request)

    def questions(self, request: EvaluationRequest) -> dict[str, dict[str, object]]:
        # The small encoder gets the Policy's short primary wording; the reviewed
        # taxonomy is reserved for the gray-area reviewer.
        return questions_for(request, provider="laya", stage="primary")

    def review_questions(self, request: EvaluationRequest) -> dict[str, dict[str, object]]:
        # The independent reviewer receives the complete Policy taxonomy and
        # exceptions; the first-stage encoder only uses its short native concept.
        return questions_for(request, provider="laya", stage="review")
