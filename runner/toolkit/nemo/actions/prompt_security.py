from __future__ import annotations

import re

from ...runtime.contracts import RiskFinding
from ...safety.taxonomy import taxonomy_for_evaluator
from .contracts import ActionRequest, ActionResult, action_result
from .names import ACTION_PROMPT_SECURITY


_OVERRIDE = re.compile(
    r"(?:ignore|disregard|forget|override)\s+(?:all\s+)?"
    r"(?:previous|prior|above|system|developer)\s+"
    r"(?:instructions?|rules?|messages?)",
    re.IGNORECASE,
)
_EXFILTRATE = re.compile(
    r"(?:reveal|show|print|repeat|quote|expose|leak)\b.{0,80}\b"
    r"(?:system\s+prompt|developer\s+message|hidden\s+instructions?)",
    re.IGNORECASE | re.DOTALL,
)
_JAILBREAK = re.compile(
    r"(?:developer\s+mode|jailbreak|bypass|disable|evade)\b.{0,80}\b"
    r"(?:safety|guardrails?|restrictions?|policy|policies?)",
    re.IGNORECASE | re.DOTALL,
)
_CHINESE_ATTACK = re.compile(
    r"(?:忽略|无视|覆盖|绕过).{0,30}"
    r"(?:之前|系统|开发者|安全|限制|指令|规则)|"
    r"(?:泄露|显示|输出).{0,30}(?:系统提示词|隐藏指令)",
)
_SECURITY_MENTION = re.compile(
    r"prompt\s+injection|system\s+prompt|developer\s+message|jailbreak|"
    r"提示注入|系统提示词|越狱",
    re.IGNORECASE,
)


class PromptSecurityActionProvider:
    """Detect prompt injection and jailbreak patterns for the NeMo Action."""

    name = ACTION_PROMPT_SECURITY
    version = "1.0.0"
    capabilities = frozenset({"prompt_injection"})
    rails = frozenset({"input"})

    async def execute(self, request: ActionRequest) -> ActionResult:
        text = request.content.strip()
        prompt_attack = bool(
            _OVERRIDE.search(text)
            or _EXFILTRATE.search(text)
            or _CHINESE_ATTACK.search(text)
        )
        jailbreak = bool(_JAILBREAK.search(text))
        if prompt_attack or jailbreak:
            detected_risk = (
                "jailbreak" if jailbreak and not prompt_attack else "prompt_injection"
            )
            reason = (
                f"The untrusted {request.target_source.replace('_', ' ')} attempts to "
                + (
                    "bypass trusted safety policies."
                    if detected_risk == "jailbreak"
                    else "override or extract trusted instructions."
                )
            )
            return action_result(
                request,
                "unsafe",
                request.content,
                findings=(
                    RiskFinding(
                        risk=request.capability,
                        taxonomy_id=taxonomy_for_evaluator(detected_risk),
                        verdict="unsafe",
                        confidence=0.99,
                        evidence=reason,
                        recommended_action=request.proposed_action,
                    ),
                ),
                reason=reason,
            )
        if _SECURITY_MENTION.search(text):
            reason = (
                "The target discusses protected instructions or prompt security; "
                "intent requires contextual review."
            )
            return action_result(
                request,
                "uncertain",
                request.content,
                findings=(
                    RiskFinding(
                        risk=request.capability,
                        taxonomy_id=taxonomy_for_evaluator(request.capability),
                        verdict="uncertain",
                        confidence=0.5,
                        evidence=reason,
                        recommended_action=request.proposed_action,
                    ),
                ),
                reason=reason,
            )
        return action_result(
            request,
            "safe",
            request.content,
            reason=(
                "No instruction override, prompt extraction, or safety-bypass "
                "intent was detected."
            ),
        )
