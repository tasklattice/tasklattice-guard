"""Direction-specific content safety through TypeSafe, independent of jailbreak detection.

The question, the reviewed unsafe-content categories and both criteria are
authored in the ``content-safety-model`` Policy and arrive as request
parameters; this adapter only selects the Rail's entry and sends it.
"""
from __future__ import annotations

from .contracts import EvaluationRequest
from .jev import JEV_PROFILE, JevNoulEvaluator
from .policy_prompt import definition_provenance, definition_revision, questions_for


class JevContentSafetyEvaluator(JevNoulEvaluator):
    id = "typesafe-jev-content-safety"
    scope_label = "input/output Content Safety"
    display_name = "Jev Content Safety"
    operation = "content_safety_classification"
    capabilities = frozenset({"content_safety"})
    contracts = frozenset({"tali.guard.content-safety.v1"})
    rails = frozenset({"input", "output"})
    reasons = {
        "matched": "The evaluated content contains or requests unsafe content under the content safety policy.",
        "not_matched": "No content safety violation was detected in the evaluated content.",
        "unknown": "Jev probabilities fall within the configured uncertainty interval.",
    }

    def __init__(self, **kwargs):
        super().__init__(profile_ref=JEV_PROFILE, **kwargs)

    def revision(self, request: EvaluationRequest) -> str:
        return definition_revision(request, provider="jev")

    def evidence_extra(self, request: EvaluationRequest) -> dict[str, object]:
        return definition_provenance(request, provider="jev")

    def state(self, request: EvaluationRequest) -> dict[str, object]:
        if request.rail_type != "output":
            return super().state(request)
        context = [dict(role=m["role"], content=m["content"]) for m in request.context_messages[-12:]
                   if m.get("role") in {"user", "assistant"} and isinstance(m.get("content"), str)]
        if context and context[-1] == {"role": "assistant", "content": request.content}:
            context.pop()
        return {"current_output": request.content, "context_messages": context}

    def questions(self, request: EvaluationRequest) -> dict[str, dict[str, object]]:
        return questions_for(request, provider="jev", stage="primary")
