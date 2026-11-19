"""Semantic PII through Laya's native System One decision questions.

The four single-concept questions are authored in the ``pii-semantic`` Policy as
its Laya variant; this adapter only submits and scores them. That shape was
measured to be the best Laya operating point on the frozen evaluation set *and*
to pass the two-sample control-plane capability probe at 0.1 / 0.9:

  safe:   name 0.0862, identifier 0.0742, address 0.0395, dob 0.0000
  unsafe: name 1.0000, identifier 0.9846, address 0.1128, dob 0.6728

The probe is a smoke test, not a quality guarantee: on the 44-sample synthetic
set this design redacts 10/20 PII samples, conservatively blocks 10/20, and
blocks 11/24 benign samples (2 more are over-redacted). Keep the independent PII
regression as the quality gate.

A semantic match replaces the complete evaluated block with ``[PII_REDACTED]``;
the model does not return trustworthy character spans.
"""
from __future__ import annotations

from .contracts import EvaluationRequest
from .policy_prompt import definition_provenance, definition_revision, questions_for

REDACTION = "[PII_REDACTED]"
from .laya import LAYA_PROFILE, LayaNoulEvaluator
from ...evaluation.contracts import CONTRACT_PII_SEMANTIC

class LayaPiiEvaluator(LayaNoulEvaluator):
    id = "laya-pii"
    scope_label = "input/output Semantic PII"
    display_name = "Laya Semantic PII"
    operation = "pii_classification"
    capabilities = frozenset({"pii"})
    contracts = frozenset({CONTRACT_PII_SEMANTIC})
    rails = frozenset({"input", "output"})
    decision_rule = "any_upper_all_lower"
    reasons = {
        "matched": "Personal information was detected in the evaluated content.",
        "not_matched": "No personal information was detected in the evaluated content.",
        "unknown": "Laya PII checks disagree or fall within the configured uncertainty interval.",
    }

    def __init__(self, **kwargs):
        super().__init__(profile_ref=LAYA_PROFILE, **kwargs)

    def revision(self, request: EvaluationRequest) -> str:
        return definition_revision(request, provider="laya")

    def evidence_extra(self, request: EvaluationRequest) -> dict[str, object]:
        return definition_provenance(request, provider="laya")

    def state(self, request: EvaluationRequest) -> dict[str, object]:
        context = [dict(role=m["role"], content=m["content"]) for m in request.context_messages[-12:]
                   if m.get("role") in {"user", "assistant"} and isinstance(m.get("content"), str)]
        role = "assistant" if request.rail_type == "output" else "user"
        if context and context[-1] == {"role": role, "content": request.content}:
            context.pop()
        field = "current_output" if request.rail_type == "output" else "current_input"
        return {field: request.content, "context_messages": context}

    def model_state(self, request: EvaluationRequest) -> str | dict[str, object]:
        # PII evaluates the current target block, matching the OpenAI-compatible
        # adapter and the frozen measurements. Unrelated conversation history must
        # not raise or lower a block's PII score; review still receives state().
        field = "current_output" if request.rail_type == "output" else "current_input"
        return {field: request.content, "context_messages": []}

    def questions(self, request: EvaluationRequest) -> dict[str, dict[str, object]]:
        # The Policy's Laya variant keeps one question per measurable concept.
        return questions_for(request, provider="laya", stage="primary")

    def _redacts(self, request: EvaluationRequest, verdict: str) -> bool:
        return verdict == "matched" and request.proposed_action == "transform"

    def result_content(self, request: EvaluationRequest, verdict: str) -> str:
        return REDACTION if self._redacts(request, verdict) else request.content

    def result_replacement(self, request: EvaluationRequest, verdict: str) -> str | None:
        return REDACTION if self._redacts(request, verdict) else None
