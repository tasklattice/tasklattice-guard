"""Bounded instruction-poisoning checks at application-owned memory boundaries.

No storage side effects and no claim to verify factual accuracy. The caller
submits the actual candidate/record and retains its acquisition query.
"""
from __future__ import annotations

import re

from ...runtime.contracts import RiskFinding
from ...safety.taxonomy import taxonomy_for_evaluator
from .contracts import ActionRequest, ActionResult, action_result
from .indirect_prompt_injection import detect_instruction, _normalize
from .names import ACTION_MEMORY_POISONING

_SOURCES = frozenset({"retrieved_content", "tool_output"})
_FUTURE_DIRECTIVE = re.compile(
    r"\b(?:instruct|tell|make|force)\s+(?:the\s+)?(?:next|future)\s+(?:assistant|agent)\s+to\s+"
    r"(?:reply|answer|respond|ignore|obey)\b|"
    r"(?:让|使|要求|指示)(?:下一个|后续|未来)(?:助手|代理).{0,12}(?:回答|回复|忽略|遵循)", re.I)
_FORCED_ANSWER = re.compile(
    r"\b(?:instruct|tell|make|force)\s+(?:the\s+)?(?:next|future)\s+(?:assistant|agent)\s+to\s+"
    r"(?:reply|answer|respond)(?:\s+with)?(?:\s+exactly)?\s+[\"'`]?([A-D]|true|false|yes|no)\b|"
    r"\breusable\s+note\s+requesting\s+answer\s+([A-D]|true|false|yes|no)\b", re.I)
_ANSWER = re.compile(
    r"^(?:(?:(?:the\s+)?(?:correct\s+|final\s+)?answer\s*(?:is\s+|:\s*))|"
    r"(?:option\s+))?\(?([A-D]|true|false|yes|no)\)?(?=$|[.,:;)\s])", re.I)


def _candidate_answer(value: str) -> str | None:
    text = value.strip().replace("**", "").replace("`", "")
    match = _ANSWER.match(text)
    if not match or re.search(r"\b(?:correction|actually|instead|on second thought)\b", text, re.I):
        return None
    # A leading article and ambiguous alternatives are not an explicit answer.
    tail = text[match.end():]
    token = match[1]
    if token.casefold() in {"yes", "no", "true", "false"} and tail.startswith(" "):
        return None  # E.g. "No problem" is prose, not an explicit false answer.
    if token.upper() in {"A", "B", "C", "D"}:
        if match.start(1) == 0 and tail.startswith(" "):
            return None
        if re.match(r"\s*(?:or|and|/)\s*[A-D]\b", tail, re.I):
            return None
    return {"yes": "true", "no": "false"}.get(token.casefold(), token.casefold())


class MemoryPoisoningActionProvider:
    name = ACTION_MEMORY_POISONING
    version = "1.0.0"
    capabilities = frozenset({"memory_poisoning"})
    rails = frozenset({"input"})

    async def execute(self, request: ActionRequest) -> ActionResult:
        if request.target_source not in _SOURCES:
            return action_result(request, "not_matched", request.content, reason="No retrieved record or write candidate is being checked.")
        normalized = _normalize(request.content)
        pattern, _, complete = detect_instruction(request.content)
        if pattern is None and _FUTURE_DIRECTIVE.search(normalized):
            pattern = "future_assistant_instruction"
        block = request.content_view.active_block if request.content_view else None
        source_query = block.metadata_value("memory.source_query") if block else None
        operation = block.metadata_value("memory.operation") if block else None
        # A query alone is insufficient: match its forced answer against the
        # actual generated/loaded candidate. A corrected answer stays usable.
        if pattern is None and operation in {"read", "write"} and source_query:
            forced = _FORCED_ANSWER.search(_normalize(source_query))
            answer = _candidate_answer(request.content)
            forced_token = next((v.casefold() for v in forced.groups() if v), None) if forced else None
            forced_token = {"yes": "true", "no": "false"}.get(forced_token, forced_token)
            if forced and answer and answer == forced_token:
                pattern = "acquisition_forced_answer"
        if pattern is None:
            return action_result(request, "not_matched" if complete else "unknown", request.content,
                reason=("No supported memory instruction-poisoning pattern was found; factual truth was not evaluated."
                        if complete else "Encoded memory exceeded the inspection budget; coverage is incomplete."))
        reason = f"The memory candidate contains {pattern.replace('_', ' ')} evidence."
        return action_result(request, "matched", request.content, reason=reason, findings=(RiskFinding(
            risk=request.capability, taxonomy_id=taxonomy_for_evaluator(request.capability), verdict="matched",
            confidence=None, evidence=reason, recommended_action=request.proposed_action,
        ),))
