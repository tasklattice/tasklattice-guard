from __future__ import annotations

import re
import unicodedata

from ...runtime.contracts import RiskFinding
from ...safety.taxonomy import taxonomy_for_evaluator
from .contracts import ActionRequest, ActionResult, action_result
from .names import ACTION_PROMPT_LEAKAGE


_ZERO_WIDTH = re.compile(r"[\u200b-\u200f\u202a-\u202e\u2060\ufeff]")
_WHITESPACE = re.compile(r"\s+")
_SEGMENT = re.compile(r"[^\n.!?。！？;；]+")
_CANARY = re.compile(
    r"\b(?:TL|TASKLATTICE|GUARDRAIL)[-_]?CANARY[-_:]?[A-Za-z0-9_-]{8,}\b",
    re.IGNORECASE,
)
_LEAKAGE_CUE = re.compile(
    r"(?:system\s+prompt|developer\s+message|hidden\s+instructions?|"
    r"系统提示词|开发者消息|隐藏指令)",
    re.IGNORECASE,
)


class PromptLeakageActionProvider:
    """Detect exact canaries and substantial trusted-instruction disclosure."""

    name = ACTION_PROMPT_LEAKAGE
    version = "1.0.0"
    capabilities = frozenset({"system_prompt_leakage"})
    rails = frozenset({"output"})

    async def execute(self, request: ActionRequest) -> ActionResult:
        if request.target_source != "model_output":
            return action_result(
                request,
                "safe",
                request.content,
                reason="The active block is not a model response.",
            )

        trusted_instruction = _trusted_instruction(request)
        if not trusted_instruction:
            return action_result(
                request,
                "error",
                request.content,
                reason=(
                    "System prompt leakage protection requires a pinned trusted "
                    "system or developer instruction."
                ),
            )

        output = _normalize(request.content)
        instruction = _normalize(trusted_instruction)[:8_000]
        detector = _leakage_detector(instruction, output)
        if detector is None:
            return action_result(
                request,
                "safe",
                request.content,
                reason="No trusted-instruction canary or substantial prompt fragment was disclosed.",
            )

        reason = (
            "The model output disclosed protected instruction material "
            f"detected by {detector.replace('_', ' ')}."
        )
        return action_result(
            request,
            "unsafe",
            request.content,
            findings=(
                RiskFinding(
                    risk=request.capability,
                    taxonomy_id=taxonomy_for_evaluator(request.capability),
                    verdict="unsafe",
                    confidence=1.0 if detector == "canary_match" else 0.99,
                    evidence=reason,
                    recommended_action=request.proposed_action,
                ),
            ),
            reason=reason,
        )


def _trusted_instruction(request: ActionRequest) -> str:
    supplied = dict(request.trusted_context).get("trusted_instruction", "").strip()
    if supplied:
        return supplied
    return "\n\n".join(
        str(message.get("content", "")).strip()
        for message in request.context_messages
        if message.get("role") in {"system", "developer"}
        and isinstance(message.get("content"), str)
        and str(message.get("content", "")).strip()
    )


def _normalize(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value)
    normalized = _ZERO_WIDTH.sub("", normalized).casefold()
    return _WHITESPACE.sub(" ", normalized).strip()


def _leakage_detector(instruction: str, output: str) -> str | None:
    canaries = tuple(_normalize(item) for item in _CANARY.findall(instruction))
    if any(canary in output for canary in canaries):
        return "canary_match"

    if len(instruction) >= 32 and instruction in output:
        return "complete_prompt_match"

    substantial_segments = tuple(
        segment.strip()
        for segment in _SEGMENT.findall(instruction)
        if len(segment.strip()) >= 48
    )
    if any(segment in output for segment in substantial_segments):
        return "instruction_segment_match"

    windows = {
        instruction[index : index + 48]
        for index in range(0, max(0, len(instruction) - 47), 24)
    }
    matching_windows = sum(window in output for window in windows)
    if matching_windows >= 2:
        return "prompt_fingerprint_match"
    if matching_windows == 1 and _LEAKAGE_CUE.search(output):
        return "prompt_fingerprint_match"
    return None
