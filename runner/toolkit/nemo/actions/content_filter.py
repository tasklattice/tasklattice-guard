from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Iterable, Mapping

from ...policy_library import PolicyRuleSpec, PolicySpec, policy
from ...policy_library.matching import keyword_expression, severity_applies
from ...runtime.contracts import (
    EvaluatorVerdict,
    GuardrailPhase,
    RiskFinding,
    RuntimeTraceStep,
)
from .contracts import ActionRequest, ActionResult, action_result
from .names import ACTION_CONTENT_FILTER


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
_NO_EXECUTION_PHRASES = (
    "don't run",
    "do not run",
    "don't execute",
    "do not execute",
    "no execution",
    "without running",
    "just reason",
    "what would happen if",
    "what would this output",
    "explain what this code",
    "explain what this script",
    "can you explain this code",
    "refactor this code",
    "convert this code",
    "spot any security issues",
    "write pseudocode",
)
_EXECUTION_PHRASES = (
    "run this ",
    "run these ",
    "execute this ",
    "please run ",
    "can you run ",
    "run `",
    "execute `",
    "run code",
    "run the snippet",
    "execute the command",
    "just run it",
    "compile and run",
    "run the program",
    "run the tests",
    "check if tests pass",
    "read /",
    "list the files",
    "create a file",
    "run curl",
    "make an http request",
    "connect to postgres",
    "paste the output",
    "tell me the result",
)
_ZERO_WIDTH = re.compile(r"[\u200b-\u200d\u2060\ufeff]")
_LEET_TRANSLATION = str.maketrans(
    {"@": "a", "4": "a", "0": "o", "3": "e", "1": "i", "5": "s", "7": "t"}
)
_COMPETITOR_SUFFIX = re.compile(
    r"\s+(?:airlines?|airways?|air|bank|banks|group|company|corp(?:oration)?|inc)$",
    re.IGNORECASE,
)
_COMPETITOR_COMPARISON = (
    "better",
    "best",
    "worse",
    " vs ",
    "versus",
    "compare",
    "comparison",
    "alternative",
    "recommend",
    "choose",
    "switch",
    "ranked",
    "number one",
)
_COMPETITOR_DOMAIN = (
    "airline",
    "airlines",
    "airways",
    "carrier",
    "carriers",
    "business class",
    "customer satisfaction",
    "lounges",
)
_COMPETITOR_OPERATIONAL = (
    "baggage allowance",
    "lounge access",
    "check in",
    "check-in",
    "refund policy",
)
_COMPETITOR_DESTINATION = re.compile(
    r"\b(?:fly|flight|travel|transit|layover|visit|going)\b.{0,16}"
    r"\b(?:to|from|via|in|through)\b|"
    r"\b(?:visa|airport|weather|documents?|entry|connection time)\b",
    re.IGNORECASE,
)


@dataclass(frozen=True, slots=True)
class _Detection:
    policy: str
    kind: str
    rule: str
    action: str
    evidence: str
    spans: tuple[tuple[int, int], ...] = ()
    replacement: str = "[REDACTED]"
    confidence: float = 0.99


@dataclass(frozen=True, slots=True)
class _ContentFilterResult:
    verdict: EvaluatorVerdict
    content: str
    findings: tuple[RiskFinding, ...] = ()
    reason: str | None = None
    trace: tuple[RuntimeTraceStep, ...] = ()


class BuiltinContentFilter:
    """Execute local Policy Rules through one deterministic NeMo Action."""

    def evaluate(
        self,
        *,
        text: str,
        phase: GuardrailPhase,
        policies: Iterable[str],
        parameters: Mapping[str, str] | None = None,
        policy_parameters: Mapping[str, Mapping[str, str]] | None = None,
        enabled_rules: Mapping[str, Iterable[str]] | None = None,
        rule_actions: Mapping[str, str] | None = None,
        policy_rule_actions: Mapping[str, Mapping[str, str]] | None = None,
        custom_rules: Iterable[Mapping[str, Any]] = (),
    ) -> _ContentFilterResult:
        shared_parameters = parameters or {}
        configured_by_policy = policy_parameters or {}
        selected_rules = {
            name: frozenset(rule_ids)
            for name, rule_ids in (enabled_rules or {}).items()
        }
        flat_actions = rule_actions or {}
        actions_by_policy = policy_rule_actions or {}
        detections: list[_Detection] = []

        try:
            for name in policies:
                definition = policy(name)
                if definition is None:
                    return _ContentFilterResult(
                        verdict="error",
                        content=text,
                        reason=f"Built-in Policy {name!r} is unavailable.",
                    )
                if phase not in definition.stages:
                    continue
                configured = configured_by_policy.get(name, shared_parameters)
                detections.extend(
                    self._apply_policy(
                        definition,
                        text,
                        phase,
                        configured,
                        selected_rules.get(name),
                        flat_actions,
                        actions_by_policy.get(name, {}),
                    )
                )
            detections.extend(
                self._apply_custom_rules(tuple(custom_rules), text, phase)
            )
        except (re.error, ValueError) as error:
            return _ContentFilterResult(
                verdict="error",
                content=text,
                reason=f"Content-filter Rule is invalid: {error}.",
            )

        detections = sorted(
            (item for item in detections if item.action != "pass"),
            key=lambda item: (
                item.policy,
                item.rule,
                item.kind,
                item.evidence,
            ),
        )
        if not detections:
            return _ContentFilterResult(
                verdict="safe",
                content=text,
                reason="No built-in content-filter Rule matched.",
            )

        content = self._apply_redactions(text, detections)
        findings = tuple(
            RiskFinding(
                risk="builtin_content_filter",
                verdict="unsafe",
                confidence=item.confidence,
                evidence=(
                    f"Policy {item.policy} matched "
                    f"{item.kind} Rule {item.rule}: {item.evidence}."
                ),
                recommended_action=item.action,
                replacement=(item.replacement if item.action in {"redact", "rewrite"} else None),
                policy_id=item.policy,
                rule_id=item.rule,
            )
            for item in detections
        )
        blocked = any(item.action == "reject" for item in detections)
        return _ContentFilterResult(
            verdict="unsafe",
            content=content,
            findings=findings,
            reason=(
                "A built-in content-filter Policy blocked the interaction."
                if blocked
                else "A built-in content-filter Policy transformed the interaction."
            ),
        )

    def _apply_policy(
        self,
        definition: PolicySpec,
        text: str,
        phase: GuardrailPhase,
        parameters: Mapping[str, str],
        enabled_rules: frozenset[str] | None,
        flat_actions: Mapping[str, str],
        policy_actions: Mapping[str, str],
    ) -> list[_Detection]:
        detections: list[_Detection] = []
        for rule in definition.rules:
            if phase not in rule.stages:
                continue
            if enabled_rules is not None and rule.id not in enabled_rules:
                continue
            action = _configured_action(
                rule.id,
                rule.effect,
                flat_actions,
                policy_actions,
            )
            if action == "pass":
                continue
            if rule.form == "category":
                match = self._category_match(rule, text)
                if match is not None:
                    evidence, spans = match
                    detections.append(
                        _Detection(
                            definition.id,
                            "category",
                            rule.id,
                            action,
                            evidence,
                            spans,
                        )
                    )
            elif rule.form == "regex":
                spans = self._pattern_spans(rule, text, parameters)
                if spans:
                    detections.append(
                        _Detection(
                            definition.id,
                            "pattern",
                            rule.id,
                            action,
                            text[spans[0][0] : spans[0][1]],
                            spans,
                            rule.redaction or "[REDACTED]",
                        )
                    )
            elif rule.form == "keyword":
                for keyword in self._resolved_keywords(rule, parameters):
                    rendered = self._render(keyword, parameters).strip()
                    if not rendered:
                        continue
                    matches = tuple(
                        (match.start(), match.end())
                        for match in _keyword_regex(rendered).finditer(text)
                    )
                    if not matches:
                        continue
                    detections.append(
                        _Detection(
                            definition.id,
                            "keyword",
                            rule.id,
                            action,
                            rendered,
                            matches,
                            rule.redaction or "[KEYWORD_REDACTED]",
                        )
                    )
                    break
            elif rule.form == "code_block":
                detection = self._code_block_detection(
                    definition.id,
                    rule,
                    text,
                    phase,
                    parameters,
                    action,
                )
                if detection is not None:
                    detections.append(detection)
            elif rule.form == "competitor_intent":
                detection = self._competitor_detection(
                    definition.id,
                    rule,
                    text,
                    parameters,
                    action,
                )
                if detection is not None:
                    detections.append(detection)
        return detections

    def _apply_custom_rules(
        self,
        rules: tuple[Mapping[str, Any], ...],
        text: str,
        phase: GuardrailPhase,
    ) -> list[_Detection]:
        detections: list[_Detection] = []
        for rule in rules:
            if phase not in tuple(rule.get("phases", ())):
                continue
            rule_id = str(rule.get("id", "custom-rule"))
            action = _enforcement_action(str(rule.get("action", "reject")))
            detector = str(rule.get("detector", "keyword"))
            if detector == "regex":
                expression = str(rule.get("expression") or "")
                matches = tuple(
                    (match.start(), match.end())
                    for match in _compiled_regex(expression).finditer(text)
                )
                if matches:
                    detections.append(
                        _Detection(
                            "custom",
                            "pattern",
                            rule_id,
                            action,
                            text[matches[0][0] : matches[0][1]],
                            matches,
                            str(rule.get("replacement") or "[REDACTED]"),
                        )
                    )
                continue
            if detector == "keyword":
                for keyword in tuple(rule.get("keywords", ())):
                    rendered = str(keyword).strip()
                    if not rendered:
                        continue
                    matches = tuple(
                        (match.start(), match.end())
                        for match in _keyword_regex(rendered).finditer(text)
                    )
                    if matches:
                        detections.append(
                            _Detection(
                                "custom",
                                "keyword",
                                rule_id,
                                action,
                                rendered,
                                matches,
                                str(rule.get("replacement") or "[REDACTED]"),
                            )
                        )
                        break
        return detections

    def _category_match(
        self,
        rule: PolicyRuleSpec,
        text: str,
    ) -> tuple[str, tuple[tuple[int, int], ...]] | None:
        lowered = text.lower()
        if any(exception.lower() in lowered for exception in rule.exceptions):
            return None
        for expression in rule.phrase_patterns:
            match = re.search(expression, text, re.IGNORECASE)
            if match:
                return match.group(0), ((match.start(), match.end()),)
        if rule.identifiers and rule.conditions:
            for sentence in re.finditer(r"[^.!?]+", text):
                sentence_text = sentence.group(0)
                identifier = next(
                    (
                        value
                        for value in rule.identifiers
                        if value.lower() in sentence_text.lower()
                    ),
                    None,
                )
                if identifier is None:
                    continue
                conditional = next(
                    (
                        value
                        for value in rule.conditions
                        if self._keyword_matches(value, sentence_text)
                    ),
                    None,
                )
                if conditional:
                    return f"{identifier} + {conditional}", ()
        for keyword, _severity in rule.always_block:
            match = _keyword_regex(keyword).search(text)
            if match:
                return keyword, ((match.start(), match.end()),)
        for keyword, severity in rule.keywords:
            if not severity_applies(
                severity,
                rule.severity_threshold or "medium",
            ):
                continue
            match = _keyword_regex(keyword).search(text)
            if match:
                return keyword, ((match.start(), match.end()),)
        return None

    def _pattern_spans(
        self,
        rule: PolicyRuleSpec,
        text: str,
        parameters: Mapping[str, str],
    ) -> tuple[tuple[int, int], ...]:
        expression = self._render(rule.expression or "", parameters)
        regex = _compiled_regex(expression)
        context_matches: tuple[re.Match[str], ...] | None = None
        if rule.context_expression:
            context = _compiled_regex(
                self._render(rule.context_expression, parameters)
            )
            context_matches = tuple(context.finditer(text))
            if not context_matches:
                return ()

        spans = [
            (match.start(), match.end())
            for match in regex.finditer(text)
            if context_matches is None
            or rule.context_max_gap_words is None
            or self._near_context(
                match.start(),
                match.end(),
                context_matches,
                text,
                rule.context_max_gap_words,
            )
        ]
        if rule.allow_word_numbers:
            for match in _WORD_NUMBER_SEQUENCE.finditer(text):
                digits = "".join(
                    _WORD_NUMBER_MAP[token.lower()]
                    for token in _WORD_NUMBER_FINDER.findall(match.group(0))
                )
                if not regex.fullmatch(digits):
                    continue
                if (
                    context_matches is not None
                    and rule.context_max_gap_words is not None
                    and not self._near_context(
                        match.start(),
                        match.end(),
                        context_matches,
                        text,
                        rule.context_max_gap_words,
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
        policy_id: str,
        rule: PolicyRuleSpec,
        text: str,
        phase: GuardrailPhase,
        parameters: Mapping[str, str],
        action: str,
    ) -> _Detection | None:
        normalized_text = self._normalize_escaped_newlines(text)
        blocked_languages = {
            self._normalize_language(item)
            for item in re.split(
                r"[,\n]",
                parameters.get("blocked_languages", ""),
            )
            if item.strip()
        }
        block_all = not blocked_languages
        threshold = _float_parameter(
            parameters.get("confidence_threshold"),
            default=0.5,
        )
        detect_intent = _boolean_parameter(
            parameters.get("detect_execution_intent"),
            default=True,
        )
        lowered = normalized_text.lower()
        has_no_intent = any(item in lowered for item in _NO_EXECUTION_PHRASES)
        has_intent = any(item in lowered for item in _EXECUTION_PHRASES)
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
            language_blocked = block_all or language in blocked_languages
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
            return _Detection(
                policy_id,
                "code block",
                rule.id,
                action,
                ", ".join(evidence),
                tuple(spans),
                rule.redaction or "[CODE_BLOCK_REDACTED]",
                confidence,
            )
        if not is_output and detect_intent and has_intent and action == "reject":
            return _Detection(
                policy_id,
                "execution request",
                rule.id,
                action,
                "explicit execution intent",
                confidence=1.0,
            )
        return None

    def _competitor_detection(
        self,
        policy_id: str,
        rule: PolicyRuleSpec,
        text: str,
        parameters: Mapping[str, str],
        action: str,
    ) -> _Detection | None:
        competitors = tuple(
            item.strip()
            for item in parameters.get("competitors", "").splitlines()
            if item.strip()
        )
        if not competitors:
            return None
        normalized = self._normalize_competitor(text)
        normalized_competitors = tuple(
            (item, self._normalize_competitor(item)) for item in competitors
        )
        full_match = next(
            (
                original
                for original, candidate in normalized_competitors
                if self._word_boundary_match(normalized, candidate)
            ),
            None,
        )
        aliases = {
            self._normalize_competitor(_COMPETITOR_SUFFIX.sub("", original)): original
            for original in competitors
        }
        alias_match = next(
            (
                alias
                for alias in aliases
                if alias
                and alias != self._normalize_competitor(aliases[alias])
                and self._word_boundary_match(normalized, alias)
            ),
            None,
        )
        comparison = any(signal in f" {normalized} " for signal in _COMPETITOR_COMPARISON)
        domain = any(signal in normalized for signal in _COMPETITOR_DOMAIN)
        operational = any(signal in normalized for signal in _COMPETITOR_OPERATIONAL)
        destination = bool(_COMPETITOR_DESTINATION.search(normalized))

        evidence: str | None = None
        confidence = 0.0
        if full_match is not None:
            evidence = full_match
            confidence = 0.85 if comparison else 0.75
        elif alias_match is not None:
            if (destination or operational) and not comparison:
                return None
            if comparison or domain:
                evidence = aliases[alias_match]
                confidence = 0.8
        elif comparison and domain:
            evidence = "comparison + domain"
            confidence = 0.65
        if evidence is None:
            return None
        return _Detection(
            policy_id,
            "competitor intent",
            rule.id,
            action,
            evidence,
            ((0, len(text)),) if action == "redact" else (),
            rule.redaction or "[COMPETITOR_CONTENT_REDACTED]",
            confidence,
        )

    @staticmethod
    def _resolved_keywords(
        rule: PolicyRuleSpec,
        parameters: Mapping[str, str],
    ) -> tuple[str, ...]:
        if len(rule.keywords) != 1:
            return tuple(value for value, _severity in rule.keywords)
        configured = rule.keywords[0][0]
        if not (configured.startswith("{{") and configured.endswith("}}")):
            return (configured,)
        competitors = tuple(
            item.strip()
            for item in parameters.get("competitors", "").splitlines()
            if item.strip()
        )
        brand = parameters.get("brand_name", "").strip()
        if configured == "{{competitors_blocked_words}}":
            return competitors
        if configured == "{{competitor_recommendation_words}}":
            return tuple(
                phrase
                for competitor in competitors
                for phrase in (
                    f"recommend {competitor}",
                    f"try {competitor}",
                    f"switch to {competitor}",
                )
            )
        if configured == "{{competitor_comparison_words}}":
            return tuple(
                phrase
                for competitor in competitors
                for phrase in (
                    f"{competitor} is better",
                    f"{competitor} vs {brand}" if brand else f"{competitor} vs",
                    f"better than {brand}" if brand else f"better than {competitor}",
                )
            )
        parameter_name = configured[2:-2].strip()
        return tuple(
            item.strip()
            for item in re.split(r"[\n,]", parameters.get(parameter_name, ""))
            if item.strip()
        )

    @staticmethod
    def _apply_redactions(text: str, detections: Iterable[_Detection]) -> str:
        candidates = [
            (start, end, item.policy, item.rule, item.replacement)
            for item in detections
            if item.action in {"redact", "rewrite"}
            for start, end in (item.spans or ((0, len(text)),))
        ]
        selected: list[tuple[int, int, str]] = []
        previous_end = -1
        for start, end, _policy, _rule, replacement in sorted(
            candidates,
            key=lambda item: (item[0], -(item[1] - item[0]), item[2], item[3]),
        ):
            if start < previous_end:
                continue
            selected.append((start, end, replacement))
            previous_end = end
        content = text
        for start, end, replacement in reversed(selected):
            content = content[:start] + replacement + content[end:]
        return content

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

    @staticmethod
    def _normalize_competitor(text: str) -> str:
        value = _ZERO_WIDTH.sub("", text)
        value = unicodedata.normalize("NFKC", value).lower().translate(_LEET_TRANSLATION)
        return re.sub(r"\s+", " ", value).strip()

    @staticmethod
    def _word_boundary_match(text: str, token: str) -> bool:
        return bool(re.search(r"\b" + re.escape(token) + r"\b", text))


class ContentFilterActionProvider:
    """Provide local Policy Library Rules as a versioned NeMo Action."""

    name = ACTION_CONTENT_FILTER
    version = "1.0.0"
    risks = frozenset({"builtin_content_filter"})
    rails = frozenset({"input", "output"})

    def __init__(self, content_filter: BuiltinContentFilter | None = None) -> None:
        self._content_filter = content_filter or BuiltinContentFilter()

    async def execute(self, request: ActionRequest) -> ActionResult:
        parameters = dict(request.parameters)
        legacy_parameters = {
            key.removeprefix("parameter."): value
            for key, value in request.parameters
            if key.startswith("parameter.")
        }
        decoded_actions = _json_mapping(
            parameters.get("rule_actions_json", "{}")
        )
        policy_actions = {
            key: value
            for key, value in decoded_actions.items()
            if isinstance(value, dict)
        }
        flat_actions = {
            key: str(value)
            for key, value in decoded_actions.items()
            if isinstance(value, str)
        }
        result = self._content_filter.evaluate(
            text=request.content,
            phase=request.rail_type,
            policies=tuple(
                item.strip()
                for item in parameters.get("policy_ids", "").splitlines()
                if item.strip()
            ),
            parameters=legacy_parameters,
            policy_parameters=_json_nested_mapping(
                parameters.get("policy_parameters_json", "{}")
            ),
            enabled_rules=_json_mapping(
                parameters.get("enabled_rules_json", "{}")
            ),
            rule_actions=flat_actions,
            policy_rule_actions=policy_actions,
            custom_rules=_json_rules(
                parameters.get("custom_rules_json", "[]")
            ),
        )
        return action_result(
            request,
            result.verdict,
            result.content,
            findings=result.findings,
            reason=result.reason,
            trace=result.trace,
        )


def _json_mapping(value: str) -> dict[str, Any]:
    decoded = json.loads(value)
    if not isinstance(decoded, dict):
        raise ValueError("Content-filter mapping parameters must be JSON objects.")
    return decoded


def _json_nested_mapping(value: str) -> dict[str, dict[str, str]]:
    decoded = _json_mapping(value)
    if not all(
        isinstance(item, dict)
        and all(isinstance(key, str) and isinstance(entry, str) for key, entry in item.items())
        for item in decoded.values()
    ):
        raise ValueError("Content-filter Policy parameters must be nested string mappings.")
    return decoded


def _json_rules(value: str) -> tuple[dict[str, Any], ...]:
    decoded = json.loads(value)
    if not isinstance(decoded, list) or not all(
        isinstance(item, dict) for item in decoded
    ):
        raise ValueError("Custom content-filter Rules must be a JSON array of objects.")
    return tuple(decoded)


def _configured_action(
    rule_id: str,
    default: str,
    flat_actions: Mapping[str, str],
    policy_actions: Mapping[str, str],
) -> str:
    return _enforcement_action(
        policy_actions.get(rule_id, flat_actions.get(rule_id, default))
    )


def _enforcement_action(value: str) -> str:
    normalized = value.strip().lower()
    return {
        "allow": "pass",
        "block": "reject",
        "mask": "redact",
        "transform": "rewrite",
    }.get(normalized, normalized)


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
