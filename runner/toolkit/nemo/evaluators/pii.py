from __future__ import annotations

import re

from ...runtime.contracts import RiskFinding
from ...safety.taxonomy import taxonomy_for_evaluator
from .contracts import (
    EvaluationRequest,
    EvaluationResult,
    evaluation_result,
)
from ...evaluation.contracts import CONTRACT_PII_EXACT


PII_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (
        re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE),
        "email address",
    ),
    (re.compile(r"\b\d{3}-\d{2}-\d{4}\b"), "US social security number"),
    (re.compile(r"\b(?:\d[ -]*?){13,19}\b"), "payment card-like number"),
    (
        re.compile(
            r"身份证号(?:码)?|护照号|社会安全号码|银行卡号",
            re.IGNORECASE,
        ),
        "personal-data label",
    ),
)

_PII_CANDIDATE = re.compile(
    r"\b(?:passport|identity|identifier|id\s*(?:number|no\.?|#)|ssn|"
    r"social\s+security|phone|telephone|address|date\s+of\s+birth|"
    r"driver'?s?\s+licen[cs]e)\b|身份证|护照|社会安全|手机号|电话|住址|出生日期",
    re.IGNORECASE,
)
_LONG_IDENTIFIER = re.compile(
    r"\b(?=[A-Z0-9-]{7,}\b)(?=[A-Z0-9-]*\d)[A-Z0-9-]+\b",
    re.IGNORECASE,
)


class PiiEvaluator:
    """Fast local PII evaluator with exact span-level redaction."""

    id = "local-pii"
    version = "1.0.0"
    capabilities = frozenset({"pii"})
    contracts = frozenset({CONTRACT_PII_EXACT})
    rails = frozenset({"input", "output"})

    async def evaluate(self, request: EvaluationRequest) -> EvaluationResult:
        matches: list[re.Match[str]] = []
        evidence: list[str] = []
        for pattern, label in PII_PATTERNS:
            found = list(pattern.finditer(request.content))
            if found:
                matches.extend(found)
                evidence.append(label)
        if not matches:
            escalation = _semantic_escalation(request)
            if escalation == "always" or (
                escalation == "on_uncertain" and _looks_like_pii_candidate(request.content)
            ):
                return evaluation_result(
                    request,
                    "uncertain",
                    request.content,
                    reason=(
                        "No exact PII pattern matched, but candidate identity "
                        "signals require the semantic PII evaluator."
                    ),
                )
            return evaluation_result(
                request,
                "safe",
                request.content,
                reason="No PII pattern matched.",
            )
        return evaluation_result(
            request,
            "unsafe",
            _redact(request.content, matches, "[PII_REDACTED]"),
            findings=(
                RiskFinding(
                    risk="pii",
                    taxonomy_id=taxonomy_for_evaluator("pii"),
                    verdict="unsafe",
                    confidence=0.97,
                    evidence=f"Detected {', '.join(sorted(set(evidence)))}.",
                    recommended_action=request.proposed_action,
                    replacement="[PII_REDACTED]",
                ),
            ),
            reason="A high-confidence PII pattern was detected.",
        )


def _semantic_escalation(request: EvaluationRequest) -> str | None:
    triggers = tuple(
        step.trigger
        for step in request.plan.steps
        if step.capability == request.capability
        and step.id != request.binding.id
        and request.rail_type in step.phases
        and step.trigger.step_ref == request.binding.id
    )
    if any(trigger.type == "always" for trigger in triggers):
        return "always"
    if any("uncertain" in trigger.verdicts for trigger in triggers):
        return "on_uncertain"
    return None


def _looks_like_pii_candidate(content: str) -> bool:
    return bool(_PII_CANDIDATE.search(content) or _LONG_IDENTIFIER.search(content))


def _redact(
    content: str,
    matches: list[re.Match[str]],
    replacement: str,
) -> str:
    output = content
    for match in sorted(matches, key=lambda item: item.start(), reverse=True):
        output = output[: match.start()] + replacement + output[match.end() :]
    return output
