"""Semantic PII through JEV's native System One category questions.

The semantic boundary — the question, the personal-data categories and the two
criteria — is authored in the ``pii-semantic`` Policy package and arrives here as
request parameters (see ``policy_prompt.py``). This adapter only translates that
definition into JEV's Noul contract and maps the returned probability onto the
shared uncertainty band; it cannot widen or narrow what counts as PII.

A gray result is answered by the separately validated ``classifier_review``
binding when it is configured for the current Rail. A semantic match replaces the
complete evaluated block with ``[PII_REDACTED]``; the model does not return
trustworthy character spans.

The policy-owned definition was measured offline on the 7 923-case PII Masking
300K cohort (80 annotated / 80 clean, thresholds 0.1 / 0.9): annotated
46 matched / 30 gray / 4 no, clean 2 matched / 4 gray / 74 no. Named
address-only values stay below 0.1, so rule-based Policies remain the primary
detector for that class.
"""
from __future__ import annotations

from .contracts import EvaluationRequest
from .jev import JEV_PROFILE, JevNoulEvaluator
from .policy_prompt import definition_provenance, definition_revision, questions_for
from ...evaluation.contracts import CONTRACT_PII_SEMANTIC

REDACTION = "[PII_REDACTED]"


class JevPiiEvaluator(JevNoulEvaluator):
    id = "typesafe-jev-pii"
    scope_label = "input/output Semantic PII"
    display_name = "Jev Semantic PII"
    operation = "pii_classification"
    capabilities = frozenset({"pii"})
    contracts = frozenset({CONTRACT_PII_SEMANTIC})
    rails = frozenset({"input", "output"})
    reasons = {
        "matched": "Personal information was detected in the evaluated content.",
        "not_matched": "No personal information was detected in the evaluated content.",
        "unknown": "Jev PII probabilities fall within the configured uncertainty interval.",
    }

    def __init__(self, **kwargs):
        super().__init__(profile_ref=JEV_PROFILE, **kwargs)

    def state(self, request: EvaluationRequest) -> dict[str, object]:
        context = [dict(role=m["role"], content=m["content"]) for m in request.context_messages[-12:]
                   if m.get("role") in {"user", "assistant"} and isinstance(m.get("content"), str)]
        role = "assistant" if request.rail_type == "output" else "user"
        if context and context[-1] == {"role": role, "content": request.content}:
            context.pop()
        field = "current_output" if request.rail_type == "output" else "current_input"
        return {field: request.content, "context_messages": context}

    def model_state(self, request: EvaluationRequest) -> str | dict[str, object]:
        # PII evaluates the current target block; review still receives state().
        field = "current_output" if request.rail_type == "output" else "current_input"
        return {field: request.content, "context_messages": []}

    def questions(self, request: EvaluationRequest) -> dict[str, dict[str, object]]:
        return questions_for(request, provider="jev", stage="primary")

    def revision(self, request: EvaluationRequest) -> str:
        return definition_revision(request, provider="jev")

    def evidence_extra(self, request: EvaluationRequest) -> dict[str, object]:
        return definition_provenance(request, provider="jev")

    def _redacts(self, request: EvaluationRequest, verdict: str) -> bool:
        return verdict == "matched" and request.proposed_action == "transform"

    def result_content(self, request: EvaluationRequest, verdict: str) -> str:
        return REDACTION if self._redacts(request, verdict) else request.content

    def result_replacement(self, request: EvaluationRequest, verdict: str) -> str | None:
        return REDACTION if self._redacts(request, verdict) else None
