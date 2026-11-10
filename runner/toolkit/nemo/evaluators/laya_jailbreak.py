"""Input jailbreak detection through Laya's native System One API.

Questions come from the ``prompt-instruction-attacks`` Policy: the encoder gets
the short primary variants, the gray-area reviewer gets the full definition.
"""
from __future__ import annotations

from .contracts import EvaluationRequest
from .laya import LAYA_PROFILE, LayaNoulEvaluator
from .policy_prompt import definition_provenance, definition_revision, questions_for

EXTERNAL_SOURCES = frozenset({"retrieved_content", "tool_output"})


class LayaJailbreakEvaluator(LayaNoulEvaluator):
    id = "laya-jailbreak"
    scope_label = "input Jailbreak detection"
    display_name = "Laya Jailbreak Protection"
    operation = "jailbreak_classification"
    capabilities = frozenset({"jailbreak"})
    contracts = frozenset({"tali.guard.jailbreak.v1"})
    reasons = {
        "matched": "The current input attempts to override a trusted instruction or safety boundary.",
        "not_matched": "No jailbreak attempt was detected in the current input.",
        "unknown": "Laya probabilities fall within the configured uncertainty interval.",
    }

    def __init__(self, **kwargs):
        super().__init__(profile_ref=LAYA_PROFILE, **kwargs)

    def questions(self, request: EvaluationRequest) -> dict[str, dict[str, object]]:
        # The encoder's shorter Policy variant: full questions stay for review.
        when = "external" if request.target_source in EXTERNAL_SOURCES else "direct"
        selected = questions_for(request, provider="laya", stage="primary", when=when)
        if self.state(request).get("memory_operation") in {"read", "write"}:
            selected.update(questions_for(request, provider="laya", stage="primary", when="memory"))
        return selected

    def review_questions(self, request: EvaluationRequest) -> dict[str, dict[str, object]]:
        when = "external" if request.target_source in EXTERNAL_SOURCES else "direct"
        selected = questions_for(request, provider="laya", stage="review", when=when)
        if self.state(request).get("memory_operation") in {"read", "write"}:
            selected.update(questions_for(request, provider="laya", stage="review", when="memory"))
        return selected

    def state(self, request: EvaluationRequest) -> dict[str, object]:
        state = super().state(request)
        if request.target_source in EXTERNAL_SOURCES:
            blocks = request.content_view.blocks if request.content_view else request.content_blocks
            state.update(target_source=request.target_source,
                         user_task="\n".join(b.text for b in blocks if b.role == "query"))
            active = request.content_view.active_block if request.content_view else next(
                (b for b in blocks if b.id == request.active_block_id), None)
            if active and active.metadata_value("memory.operation") in {"read", "write"}:
                state.update(memory_operation=active.metadata_value("memory.operation"),
                             source_query=active.metadata_value("memory.source_query") or "")
        return state

    def revision(self, request: EvaluationRequest) -> str:
        return definition_revision(request, provider="laya")

    def evidence_extra(self, request: EvaluationRequest) -> dict[str, object]:
        return definition_provenance(request, provider="laya")
