from __future__ import annotations

import base64
import binascii
import re
import unicodedata

from ...runtime.contracts import RiskFinding
from ...safety.taxonomy import taxonomy_for_evaluator
from .contracts import ActionRequest, ActionResult, action_result
from .names import ACTION_INDIRECT_PROMPT_INJECTION


_INDIRECT_SOURCES = frozenset({"retrieved_content", "grounding_source", "tool_output"})
_ZERO_WIDTH = re.compile(r"[\u200b-\u200f\u202a-\u202e\u2060\ufeff]")
_WHITESPACE = re.compile(r"\s+")
_ENCODED = re.compile(r"(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{24,}={0,2}(?![A-Za-z0-9+/=_-])")
_DECODE_CHAR_BUDGET = 32_768
_DECODE_CANDIDATE_BUDGET = 64

_ATTACK_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "instruction_override",
        re.compile(
            r"\b(?:ignore|disregard|forget|override)\s+(?:(?:all|the)\s+)?"
            r"(?:(?:previous|prior|above)(?:\s+(?:system|developer|user))?|"
            r"system|developer|user)\s+"
            r"(?:instructions?|rules?|messages?|prompts?)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "task_override",
        re.compile(
            r"\b(?:ignore|disregard|abandon)\s+(?:(?:the|your|current|original)\s+){1,3}"
            r"(?:task|question|request)\b.{0,100}\b(?:instead|answer|respond|output|print)\b|"
            r"\b(?:answer|respond|output|print)\s+(?:only|exactly)\b.{0,100}"
            r"\binstead of\s+(?:answering|following|completing)\b",
            re.IGNORECASE | re.DOTALL,
        ),
    ),
    (
        "instruction_replacement",
        re.compile(
            r"\b(?:follow|obey|execute|use)\s+(?:only\s+)?(?:these|the following|my)\s+"
            r"(?:instructions?|rules?|commands?)\s+(?:instead|from now on|before continuing)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "prompt_exfiltration",
        re.compile(
            r"\b(?:reveal|show|print|repeat|quote|expose|leak|return)\b.{0,100}\b"
            r"(?:system\s+prompt|developer\s+message|hidden\s+instructions?|secret\s+prompt)\b",
            re.IGNORECASE | re.DOTALL,
        ),
    ),
    (
        "model_boundary_forgery",
        re.compile(
            r"(?:<\|im_start\|>\s*(?:system|developer)|"
            r"\[(?:system|developer)\s*(?:message|instruction)?\]|"
            r"BEGIN\s+(?:SYSTEM|DEVELOPER)\s+(?:PROMPT|INSTRUCTIONS?))",
            re.IGNORECASE,
        ),
    ),
    (
        "tool_coercion",
        re.compile(
            r"\b(?:call|invoke|run|execute)\s+(?:the\s+)?(?:tool|function|command)\b"
            r".{0,100}\b(?:without|bypass|ignore|do not ask|silently)\b",
            re.IGNORECASE | re.DOTALL,
        ),
    ),
    (
        "chinese_instruction_override",
        re.compile(
            r"(?:忽略|无视|覆盖|忘掉).{0,24}(?:之前|以上|系统|开发者|用户).{0,12}"
            r"(?:指令|规则|提示词|消息)|"
            r"(?:不要遵循|停止遵循).{0,24}(?:系统|开发者|原有).{0,12}(?:指令|规则)|"
            r"(?:泄露|显示|输出|复述).{0,24}(?:系统提示词|隐藏指令|开发者消息)",
        ),
    ),
)


class IndirectPromptInjectionActionProvider:
    """Detect instructions embedded in untrusted retrieval and tool content."""

    name = ACTION_INDIRECT_PROMPT_INJECTION
    version = "1.0.0"
    capabilities = frozenset({"indirect_prompt_injection"})
    rails = frozenset({"input"})

    async def execute(self, request: ActionRequest) -> ActionResult:
        if request.target_source not in _INDIRECT_SOURCES:
            return action_result(
                request,
                "not_matched",
                request.content,
                reason="The active block is not retrieval context or a tool result.",
            )

        detected, encoded, complete = detect_instruction(request.content)

        if detected is None:
            return action_result(
                request,
                "not_matched" if complete else "unknown",
                request.content,
                reason=("No supported embedded instruction pattern was detected."
                        if complete else "Encoded content exceeded the bounded inspection budget; coverage is incomplete."),
            )

        source_label = request.target_source.replace("_", " ")
        encoding_label = " after bounded decoding" if encoded else ""
        reason = (
            f"The untrusted {source_label} contains a {detected.replace('_', ' ')}"
            f" pattern{encoding_label}."
        )
        return action_result(
            request,
            "matched",
            request.content,
            findings=(
                RiskFinding(
                    risk=request.capability,
                    taxonomy_id=taxonomy_for_evaluator(request.capability),
                    verdict="matched",
                    confidence=None,  # Pattern matches are not calibrated probabilities.
                    evidence=reason,
                    recommended_action=request.proposed_action,
                ),
            ),
            reason=reason,
        )


def _normalize(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value)
    normalized = _ZERO_WIDTH.sub("", normalized)
    return _WHITESPACE.sub(" ", normalized).strip()


def _detected_pattern(value: str) -> str | None:
    return next(
        (name for name, pattern in _ATTACK_PATTERNS if pattern.search(value)),
        None,
    )


def detect_instruction(value: str) -> tuple[str | None, bool, bool]:
    """Scan all plain text, then bounded decoded data; never label overflow safe."""
    detected = _detected_pattern(_normalize(value))
    if detected:
        return detected, False, True
    candidates, complete = _decoded_candidates(value)
    for candidate in candidates:
        detected = _detected_pattern(_normalize(candidate))
        if detected:
            return detected, True, complete
    return None, False, complete


def _decoded_candidates(value: str) -> tuple[tuple[str, ...], bool]:
    decoded: list[str] = []
    consumed = 0
    normalized = _ZERO_WIDTH.sub("", unicodedata.normalize("NFKC", value))
    for index, match in enumerate(_ENCODED.finditer(normalized)):
        token = match.group(0)
        consumed += len(token)
        if index >= _DECODE_CANDIDATE_BUDGET or consumed > _DECODE_CHAR_BUDGET:
            return tuple(decoded), False
        padded = token + "=" * (-len(token) % 4)
        try:
            raw = base64.b64decode(padded, altchars=b"-_", validate=True)
            text = raw.decode("utf-8")
        except (binascii.Error, UnicodeDecodeError, ValueError):
            continue
        if text and sum(character.isprintable() for character in text) / len(text) >= 0.9:
            decoded.append(text)
    return tuple(decoded), True
