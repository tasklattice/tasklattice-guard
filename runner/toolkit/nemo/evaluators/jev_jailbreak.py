"""Input jailbreak detection through TypeSafe's native System One API.

Every question and criterion is authored in the ``prompt-instruction-attacks``
Policy; this adapter only selects the entry for the evaluated boundary and
projects it onto the Noul contract.
"""
from __future__ import annotations

from .contracts import EvaluationRequest
from .jev import JEV_PROFILE, JevNoulEvaluator
from .policy_prompt import definition_provenance, definition_revision, questions_for

EXTERNAL_SOURCES = frozenset({"retrieved_content", "tool_output"})


class JevJailbreakEvaluator(JevNoulEvaluator):
    id = "typesafe-jev-jailbreak"
    scope_label = "input Jailbreak detection"
    display_name = "Jev Jailbreak Protection"
    operation = "jailbreak_classification"
    capabilities = frozenset({"jailbreak"})
    contracts = frozenset({"tali.guard.jailbreak.v1"})
    reasons = {
        "matched": "The current input attempts to override a trusted instruction or safety boundary.",
        "not_matched": "No jailbreak attempt was detected in the current input.",
        "unknown": "Jev probabilities fall within the configured uncertainty interval.",
    }

    def __init__(self, **kwargs):
        super().__init__(profile_ref=JEV_PROFILE, **kwargs)

    def questions(self, request: EvaluationRequest) -> dict[str, dict[str, object]]:
        # Select the Policy entry for this boundary: a direct user turn, external
        # reference content, or a memory operation that can plant future behavior.
        when = "external" if request.target_source in EXTERNAL_SOURCES else "direct"
        selected = questions_for(request, provider="jev", stage="primary", when=when)
        if request.target_source in EXTERNAL_SOURCES and self.state(request).get("memory_operation") in {"read", "write"}:
            selected.update(questions_for(request, provider="jev", stage="primary", when="memory"))
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
        return definition_revision(request, provider="jev")

    def evidence_extra(self, request: EvaluationRequest) -> dict[str, object]:
        return definition_provenance(request, provider="jev")
