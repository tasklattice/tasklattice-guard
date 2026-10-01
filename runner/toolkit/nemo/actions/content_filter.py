from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from types import MappingProxyType
from typing import Any, Iterable, Mapping

from ...policy_library import PolicyRuleSpec, PolicySpec, policy
from ...policy_library.detectors import DetectorInput, LocalDetector
from ...policy_library.rule_expansion import expand_rule
from ...runtime.contracts import (
    EvaluatorVerdict,
    GuardrailPhase,
    RiskFinding,
    RuntimeTraceStep,
)
from ...safety.taxonomy import taxonomy_for_evaluator
from .contracts import ActionRequest, ActionResult, action_result
from .names import ACTION_CONTENT_FILTER


@dataclass(frozen=True, slots=True)
class _Detection:
    policy: str
    kind: str
    rule: str
    action: str
    evidence: str
    spans: tuple[tuple[int, int], ...] = ()
    replacement: str | None = None
    confidence: float | None = None
    risk_severity: str | None = None
    taxonomy_ids: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class _ContentFilterResult:
    verdict: EvaluatorVerdict
    content: str
    findings: tuple[RiskFinding, ...] = ()
    reason: str | None = None
    trace: tuple[RuntimeTraceStep, ...] = ()


class BuiltinContentFilter:
    """Execute local Policy Rules through one NeMo Action."""

    def evaluate(
        self,
        *,
        text: str,
        phase: GuardrailPhase,
        policies: Iterable[str],
        parameters: Mapping[str, str] | None = None,
        policy_parameters: Mapping[str, Mapping[str, str]] | None = None,
        enabled_rules: Mapping[str, Iterable[str]] | None = None,
        rule_order: Mapping[str, Iterable[str]] | None = None,
        rule_actions: Mapping[str, str] | None = None,
        policy_rule_actions: Mapping[str, Mapping[str, str]] | None = None,
        custom_rules: Iterable[Mapping[str, Any]] = (),
        definitions: Mapping[str, PolicySpec] | None = None,
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
        content = text

        try:
            for name in policies:
                definition = definitions.get(name) if definitions is not None else policy(name)
                if definition is None:
                    return _ContentFilterResult(
                        verdict="error",
                        content=text,
                        reason=f"Built-in Policy {name!r} is unavailable.",
                    )
                if phase not in definition.rails:
                    continue
                configured = configured_by_policy.get(name, shared_parameters)
                content, matched = self._apply_policy(
                    definition,
                    content,
                    phase,
                    configured,
                    selected_rules.get(name),
                    flat_actions,
                    actions_by_policy.get(name, {}),
                    tuple((rule_order or {}).get(name, ())),
                )
                detections.extend(matched)
                if any(item.action == "block" for item in matched):
                    break
            else:
                for rule in custom_rules:
                    matched = self._apply_custom_rules((rule,), content, phase)
                    detections.extend(matched)
                    content = self._apply_effect(content, matched)
                    if any(item.action == "block" for item in matched):
                        break
        except (re.error, ValueError) as error:
            return _ContentFilterResult(
                verdict="error",
                content=text,
                reason=f"Content-filter Rule is invalid: {error}.",
            )

        # Findings retain actual execution order. Redaction offsets belong to
        # each Rule's input, never to a shared original-text snapshot.
        # A pass action is observation-only, not a disabled detector. Keep its
        # findings so Security can show the match without changing the content.
        if not detections:
            return _ContentFilterResult(
                verdict="not_matched",
                content=text,
                reason="No built-in content-filter Rule matched.",
            )

        findings = tuple(
            RiskFinding(
                risk="builtin_content_filter",
                taxonomy_id=taxonomy_id,
                verdict="matched",
                confidence=item.confidence,
                evidence=(
                    f"Policy {item.policy} matched "
                    f"{item.kind} Rule {item.rule}: {item.evidence}."
                ),
                recommended_action=item.action,
                replacement=(item.replacement if item.action == "transform" else None),
                policy_id=item.policy,
                rule_id=item.rule,
                risk_severity=item.risk_severity,
            )
            for item in detections
            for taxonomy_id in (item.taxonomy_ids or _taxonomy_ids(item.policy, item.rule, definitions))
        )
        blocked = any(item.action == "block" for item in detections)
        return _ContentFilterResult(
            verdict="matched",
            content=content,
            findings=findings,
            reason=(
                "A built-in content-filter Policy blocked the interaction."
                if blocked
                else "A built-in content-filter Policy transformed the interaction."
                if any(item.action != "allow" for item in detections)
                else "A built-in content-filter Policy recorded a finding without intervening."
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
        rule_order: tuple[str, ...] = (),
    ) -> tuple[str, list[_Detection]]:
        detections: list[_Detection] = []
        by_id = {rule.id: rule for rule in definition.rules}
        if len(set(rule_order)) != len(rule_order) or set(rule_order) - by_id.keys():
            raise ValueError(f"Invalid Rule order for Policy {definition.id}")
        ordered = [by_id[rule_id] for rule_id in rule_order]
        ordered.extend(rule for rule in definition.rules if rule.id not in rule_order)
        for rule in ordered:
            if phase not in rule.rails:
                continue
            if enabled_rules is not None and rule.id not in enabled_rules:
                continue
            action = _configured_action(
                rule.id,
                rule.effect,
                flat_actions,
                policy_actions,
            )
            for concrete in expand_rule(rule, dict(parameters)):
                concrete_action = action if (rule.id in policy_actions or rule.id in flat_actions or not rule.rule_expansion) else concrete.effect
                text, matched = self._apply_rule(
                    definition.id, concrete, text, phase, parameters, concrete_action,
                )
                detections.extend(matched)
                if any(item.action == "block" for item in matched):
                    return text, detections
        return text, detections

    def _apply_rule(
        self, policy_id: str, rule: PolicyRuleSpec, text: str,
        phase: GuardrailPhase, parameters: Mapping[str, str], action: str,
    ) -> tuple[str, list[_Detection]]:
        if rule.implementation.execution != "local":
            raise ValueError(f"Rule {rule.id} cannot execute in the local content filter")
        config = DetectorInput(
            expression=rule.expression, context_expression=rule.context_expression,
            context_max_gap_words=rule.context_max_gap_words, allow_word_numbers=rule.allow_word_numbers,
            validators=rule.validators, keywords=tuple(term for term, _ in rule.keywords), options=rule.detector_options,
        )
        match = LocalDetector().detect(rule.implementation.detector, config, text, phase, parameters)
        matched = [] if match is None else [_Detection(
            policy_id, rule.detector.ref, rule.id, action, match.evidence,
            match.spans, rule.redaction, match.confidence, rule.risk_severity, rule.taxonomy_ids,
        )]
        return self._apply_effect(text, matched), matched

    def _apply_effect(self, text: str, detections: list[_Detection]) -> str:
        transforms = [item for item in detections if item.action == "transform"]
        if any(item.replacement is None for item in transforms):
            raise ValueError("Transform requires explicit replacement content")
        return self._apply_redactions(text, detections)

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
            kind = str(rule.get("detector", "keyword"))
            config = DetectorInput(expression=str(rule.get("expression") or ""),
                                   keywords=tuple(str(term) for term in rule.get("keywords", ())))
            match = LocalDetector().detect(kind, config, text, phase, {})
            if match:
                detections.append(_Detection(
                    "custom", kind, str(rule.get("id", "custom-rule")),
                    _enforcement_action(str(rule.get("action", "block"))),
                    match.evidence, match.spans, rule.get("replacement"), match.confidence,
                ))
        return detections

    @staticmethod
    def _apply_redactions(text: str, detections: Iterable[_Detection]) -> str:
        candidates = [
            (start, end, item.policy, item.rule, item.replacement)
            for item in detections
            if item.action == "transform"
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



class ContentFilterActionProvider:
    """Provide local Policy Library Rules as a versioned NeMo Action."""

    name = ACTION_CONTENT_FILTER
    version = "1.0.0"
    capabilities = frozenset({"builtin_content_filter"})
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
        definitions = None
        if "policy_definitions_json" in parameters:
            definitions = _pinned_definitions(parameters["policy_definitions_json"])
            versions = _json_mapping(parameters.get("policy_versions_json", "{}"))
            selected = {item.strip() for item in parameters.get("policy_ids", "").splitlines() if item.strip()}
            if selected != definitions.keys() or selected != versions.keys() or any(definitions[id].version != versions[id] for id in selected):
                raise ValueError("Pinned Policy definitions do not match the selected Policy versions")
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
            rule_order=_json_mapping(parameters.get("rule_order_json", "{}")),
            policy_rule_actions=policy_actions,
            custom_rules=_json_rules(
                parameters.get("custom_rules_json", "[]")
            ),
            definitions=definitions,
        )
        return action_result(
            request,
            result.verdict,
            result.content,
            findings=result.findings,
            reason=result.reason,
            trace=result.trace,
        )


@lru_cache(maxsize=128)
def _pinned_definitions(value: str) -> Mapping[str, PolicySpec]:
    from ...policy_library.loader import _policy
    from ...policy_library.registry import PolicyLibraryRegistry
    payload = _json_mapping(value)
    definitions = {id: _policy(item) for id, item in payload.items()}
    if any(id != definition.id for id, definition in definitions.items()):
        raise ValueError("Pinned Policy key does not match its definition ID")
    if any(rule.implementation.execution != "local" for definition in definitions.values() for rule in definition.rules):
        raise ValueError("Pinned local Policy definitions cannot contain model-backed Rules")
    PolicyLibraryRegistry(tuple(definitions.values()))
    return MappingProxyType(definitions)


def _taxonomy_ids(policy_id: str, rule_id: str, definitions: Mapping[str, PolicySpec] | None = None) -> tuple[str, ...]:
    # Guardrail-local phrase/regex Rules have no shared catalog entry. Their
    # category is the configured business boundary, not an inferred PII label.
    definition = definitions.get(policy_id) if definitions is not None else policy(policy_id)
    if definition is not None:
        rule = next((item for item in definition.rules if item.id == rule_id), None)
        if rule is not None and rule.taxonomy_ids:
            return rule.taxonomy_ids
    if policy_id == "custom":
        return (taxonomy_for_evaluator("builtin_content_filter"),)
    raise RuntimeError(
        f"Policy {policy_id!r} Rule {rule_id!r} has no TALI Taxonomy category."
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
    if normalized not in {"allow", "block", "transform"}:
        raise ValueError(f"Unknown Rule action: {value}")
    return normalized
