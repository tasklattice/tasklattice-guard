"""Semantic PII through Laya's native System One decision questions.

This adapter uses the four questions that were measured to be the best Laya
operating point on the frozen evaluation set *and* to pass the two-sample
control-plane capability probe at the default 0.1 / 0.9 thresholds:

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
from .laya import LAYA_PROFILE, LayaNoulEvaluator
from ...evaluation.contracts import CONTRACT_PII_SEMANTIC

QUESTION_REVISION = "laya-pii-input.v1"
OUTPUT_QUESTION_REVISION = "laya-pii-output.v1"
REDACTION = "[PII_REDACTED]"

# One question per measurable PII concept. Do not add the generic
# "personal information" question: on this checkpoint it degenerates (already
# redacted text scored ~0.99 and ordinary organization names also scored high).
PII_QUESTIONS = {
    "name": "Does this text contain a person's name?",
    "actual_identifier": (
        "Does this text contain an actual personal identifier value such as a social "
        "security number, passport number, email address, phone number or home address?"
    ),
    "address": "Does this text contain a home or personal postal address?",
    "dob": "Does this text contain a specific person's date of birth?",
}


class LayaPiiEvaluator(LayaNoulEvaluator):
    id = "laya-pii"
    scope_label = "input/output Semantic PII"
    display_name = "Laya Semantic PII"
    operation = "pii_classification"
    question_revision = QUESTION_REVISION
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
        return OUTPUT_QUESTION_REVISION if request.rail_type == "output" else QUESTION_REVISION

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
        return {
            key: {"type": "noul", "instructions": instructions}
            for key, instructions in PII_QUESTIONS.items()
        }

    def _redacts(self, request: EvaluationRequest, verdict: str) -> bool:
        return verdict == "matched" and request.proposed_action == "transform"

    def result_content(self, request: EvaluationRequest, verdict: str) -> str:
        return REDACTION if self._redacts(request, verdict) else request.content

    def result_replacement(self, request: EvaluationRequest, verdict: str) -> str | None:
        return REDACTION if self._redacts(request, verdict) else None
