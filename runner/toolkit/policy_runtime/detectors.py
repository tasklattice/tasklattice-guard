"""Business-independent local detectors. No actions, risk levels or Policy IDs."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Iterable, Mapping

from .matching import keyword_expression
from .pattern_validation import valid_pattern_candidate


@dataclass(frozen=True, slots=True)
class DetectionMatch:
    evidence: str
    spans: tuple[tuple[int, int], ...] = ()
    confidence: float | None = None


@dataclass(frozen=True, slots=True)
class DetectorInput:
    expression: str | None = None
    context_expression: str | None = None
    context_max_gap_words: int | None = None
    allow_word_numbers: bool = False
    validators: tuple[dict[str, Any], ...] = ()
    keywords: tuple[str, ...] = ()
    options: dict[str, Any] = field(default_factory=dict)


_WORD_NUMBER_MAP = {
    "zero": "0",
    "oh": "0",
    "one": "1",
    "two": "2",
    "three": "3",
    "four": "4",
    "five": "5",
    "six": "6",
    "seven": "7",
    "eight": "8",
    "nine": "9",
}
_WORD_NUMBER_TOKEN = "|".join(_WORD_NUMBER_MAP)
_WORD_NUMBER_SEQUENCE = re.compile(
    rf"(?<![A-Za-z])(?:{_WORD_NUMBER_TOKEN})"
    rf"(?:[\s\-]+(?:{_WORD_NUMBER_TOKEN}))+(?![A-Za-z])",
    re.IGNORECASE,
)
_WORD_NUMBER_FINDER = re.compile(_WORD_NUMBER_TOKEN, re.IGNORECASE)
_GAP_WORD = re.compile(r"\b\w+\b")
_FENCED_CODE_BLOCK = re.compile(r"```(\w*)\n(.*?)```", re.DOTALL)
_LANGUAGE_ALIASES = {
    "js": "javascript",
    "py": "python",
    "sh": "bash",
    "ts": "typescript",
}
_NON_EXECUTABLE_TAGS = frozenset(
    {"text", "plaintext", "plain", "markdown", "md", "output", "result"}
)


class LocalDetector:
    def detect(self, kind: str, config: DetectorInput, text: str, phase: str,
               parameters: Mapping[str, str]) -> DetectionMatch | None:
        if kind == "regex":
            spans = self._pattern_spans(config, text, parameters)
            return DetectionMatch(text[spans[0][0]:spans[0][1]], spans) if spans else None
        if kind == "keyword":
            from .conditions import resolve_terms
            terms = (tuple(config.options["terms"]) if config.options.get("literal") else
                     resolve_terms(config.options.get("terms", list(config.keywords)), parameters))
            for term in terms:
                spans = tuple((m.start(), m.end()) for m in _keyword_regex(term).finditer(text))
                if spans:
                    return DetectionMatch(term, spans)
            return None
        if kind == "conditions":
            from .conditions import evaluate_conditions
            return evaluate_conditions(config.options, text, parameters)
        if kind == "code_block":
            configured = {**parameters}
            for key in ("languages", "minimum_score", "require_context"):
                if key in config.options:
                    value = str(config.options[key])
                    reference = re.fullmatch(r"\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}", value)
                    configured[key] = parameters.get(reference[1], "") if reference else self._render(value, parameters)
            return self._code_block_detection(config, text, phase, configured)
        raise ValueError(f"Unsupported local detector {kind!r}")

    def _pattern_spans(
        self,
        config: DetectorInput,
        text: str,
        parameters: Mapping[str, str],
    ) -> tuple[tuple[int, int], ...]:
        expression = self._render(config.expression or "", parameters)
        regex = _compiled_regex(expression)
        context_matches: tuple[re.Match[str], ...] | None = None
        if config.context_expression:
            context = _compiled_regex(
                self._render(config.context_expression, parameters)
            )
            context_matches = tuple(context.finditer(text))
            if not context_matches:
                return ()

        spans = [
            (match.start(), match.end())
            for match in regex.finditer(text)
            if valid_pattern_candidate(match.group(0), config.validators)
            and (
                context_matches is None
                or config.context_max_gap_words is None
                or self._near_context(
                    match.start(),
                    match.end(),
                    context_matches,
                    text,
                    config.context_max_gap_words,
                )
            )
        ]
        if config.allow_word_numbers:
            for match in _WORD_NUMBER_SEQUENCE.finditer(text):
                digits = "".join(
                    _WORD_NUMBER_MAP[token.lower()]
                    for token in _WORD_NUMBER_FINDER.findall(match.group(0))
                )
                if not regex.fullmatch(digits) or not valid_pattern_candidate(digits, config.validators):
                    continue
                if (
                    context_matches is not None
                    and config.context_max_gap_words is not None
                    and not self._near_context(
                        match.start(),
                        match.end(),
                        context_matches,
                        text,
                        config.context_max_gap_words,
                    )
                ):
                    continue
                spans.append((match.start(), match.end()))
        return self._merge_spans(spans)

    @staticmethod
    def _near_context(
        value_start: int,
        value_end: int,
        contexts: tuple[re.Match[str], ...],
        text: str,
        max_gap_words: int,
    ) -> bool:
        for context in contexts:
            if value_start >= context.end():
                gap = text[context.end() : value_start]
            elif context.start() >= value_end:
                gap = text[value_end : context.start()]
            else:
                return True
            if any(character.isdigit() for character in gap):
                continue
            if len(_GAP_WORD.findall(gap)) <= max_gap_words:
                return True
        return False

    def _code_block_detection(
        self,
        config: DetectorInput,
        text: str,
        phase: str,
        parameters: Mapping[str, str],
    ) -> DetectionMatch | None:
        normalized_text = self._normalize_escaped_newlines(text)
        languages = {
            self._normalize_language(item)
            for item in re.split(
                r"[,\n]",
                parameters.get("languages", ""),
            )
            if item.strip()
        }
        block_all = not languages
        threshold = _float_parameter(
            parameters.get("minimum_score"),
            default=0.5,
        )
        detect_intent = _boolean_parameter(
            parameters.get("require_context"),
            default=True,
        )
        lowered = normalized_text.lower()
        has_no_intent = any(item in lowered for item in config.options.get("exclude_terms", ()))
        has_intent = any(item in lowered for item in config.options.get("require_terms", ()))
        is_output = phase == "output"
        if (
            not is_output
            and detect_intent
            and has_no_intent
            and not has_intent
        ):
            return None

        spans: list[tuple[int, int]] = []
        evidence: list[str] = []
        confidence = 0.0
        for match in _FENCED_CODE_BLOCK.finditer(normalized_text):
            language = self._normalize_language(match.group(1))
            language_blocked = block_all or language in languages
            if not language_blocked:
                continue
            item_confidence = (
                0.5 if block_all and language in _NON_EXECUTABLE_TAGS else 1.0
            )
            if item_confidence < threshold:
                continue
            if not is_output and detect_intent and not has_intent:
                continue
            spans.append((match.start(), match.end()))
            evidence.append(language or "untagged")
            confidence = max(confidence, item_confidence)

        if spans:
            return DetectionMatch(
                evidence=", ".join(evidence), spans=tuple(spans), confidence=confidence,
            )
        return None

    @staticmethod
    def _merge_spans(
        spans: Iterable[tuple[int, int]],
    ) -> tuple[tuple[int, int], ...]:
        merged: list[tuple[int, int]] = []
        for start, end in sorted(spans):
            if merged and start <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
            else:
                merged.append((start, end))
        return tuple(merged)

    @staticmethod
    def _keyword_matches(keyword: str, text: str) -> bool:
        return bool(_keyword_regex(keyword).search(text))

    @staticmethod
    def _render(value: str, parameters: Mapping[str, str]) -> str:
        rendered = value
        for key, replacement in parameters.items():
            rendered = rendered.replace(f"{{{{{key}}}}}", replacement)
        return rendered

    @staticmethod
    def _normalize_language(tag: str) -> str:
        normalized = tag.strip().lower()
        return _LANGUAGE_ALIASES.get(normalized, normalized)

    @staticmethod
    def _normalize_escaped_newlines(text: str) -> str:
        if ("\\n" not in text and "\\r" not in text) or "\n" in text or "\r" in text:
            return text
        return text.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\\r", "\n")



def _boolean_parameter(value: str | None, *, default: bool) -> bool:
    if value is None or not value.strip():
        return default
    normalized = value.strip().lower()
    if normalized in {"true", "1", "yes", "on"}:
        return True
    if normalized in {"false", "0", "no", "off"}:
        return False
    raise ValueError(f"Expected a boolean value, got {value!r}")


def _float_parameter(value: str | None, *, default: float) -> float:
    if value is None or not value.strip():
        return default
    parsed = float(value)
    if not 0 <= parsed <= 1:
        raise ValueError("Confidence threshold must be between 0 and 1")
    return parsed


@lru_cache(maxsize=16_384)
def _keyword_regex(keyword: str) -> re.Pattern[str]:
    return re.compile(keyword_expression(keyword), re.IGNORECASE)


@lru_cache(maxsize=4_096)
def _compiled_regex(expression: str) -> re.Pattern[str]:
    return re.compile(expression, re.IGNORECASE)
