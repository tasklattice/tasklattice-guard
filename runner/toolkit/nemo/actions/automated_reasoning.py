from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any, Protocol

import httpx

from ...runtime.contracts import (
    AutomatedReasoningFinding,
    AutomatedReasoningPolicySnapshot,
    AutomatedReasoningResult,
    AutomatedReasoningRuleEvidence,
    AutomatedReasoningScenario,
    AutomatedReasoningTranslation,
    RiskFinding,
)
from ...safety.taxonomy import taxonomy_for_evaluator
from .contracts import ActionRequest, ActionResult, ActionUsage, action_result, action_view
from .model_call import action_usage, observe_model_call
from .names import ACTION_AUTOMATED_REASONING


_RESULT_SEVERITY: dict[AutomatedReasoningResult, int] = {
    "too_complex": 0,
    "translation_ambiguous": 1,
    "impossible": 2,
    "invalid": 3,
    "satisfiable": 4,
    "no_translations": 5,
    "valid": 6,
}


class AutomatedReasoningProvider(Protocol):
    """Provider boundary: return proof findings without product enforcement actions."""

    async def evaluate(
        self,
        *,
        policy: AutomatedReasoningPolicySnapshot,
        query_content: str,
        guard_content: str,
    ) -> tuple[tuple[AutomatedReasoningFinding, ...], ActionUsage]: ...


class HTTPAutomatedReasoningProvider:
    """Call a configured formal-reasoning endpoint using TaskLattice's provider contract."""

    def __init__(
        self,
        *,
        endpoint_url: str,
        api_key_env_var: str | None = None,
        api_key: str | None = None,
        timeout_seconds: float = 20.0,
        transport: httpx.AsyncBaseTransport | None = None,
        skip_tls_verify: bool = False,
    ) -> None:
        self._endpoint_url = endpoint_url
        self._api_key_env_var = api_key_env_var
        self._api_key = api_key
        self._timeout_seconds = timeout_seconds
        self._transport = transport
        self._skip_tls_verify = skip_tls_verify

    async def evaluate(
        self,
        *,
        policy: AutomatedReasoningPolicySnapshot,
        query_content: str,
        guard_content: str,
    ) -> tuple[tuple[AutomatedReasoningFinding, ...], ActionUsage]:
        credential = self._credential()
        if not credential:
            raise RuntimeError("Automated Reasoning provider credential is not configured.")
        raise RuntimeError(
            "HTTPAutomatedReasoningProvider.evaluate requires ActionRequest context."
        )

    async def evaluate_action(
        self,
        request: ActionRequest,
        *,
        policy: AutomatedReasoningPolicySnapshot,
        query_content: str,
        guard_content: str,
    ) -> tuple[tuple[AutomatedReasoningFinding, ...], ActionUsage]:
        credential = self._credential()
        if not credential:
            raise RuntimeError("Automated Reasoning provider credential is not configured.")
        with observe_model_call(
            request,
            provider="automated_reasoning",
            model="formal_reasoning",
            operation="policy_proof",
        ) as call:
            async with httpx.AsyncClient(
                timeout=self._timeout_seconds,
                transport=self._transport,
                verify=not self._skip_tls_verify,
            ) as client:
                response = await client.post(
                    self._endpoint_url,
                    headers={"authorization": f"Bearer {credential}"},
                    json={
                        "policy": {
                            "id": policy.policy_id,
                            "version": policy.policy_version,
                        },
                        "query_content": query_content,
                        "guard_content": guard_content,
                        "confidence_threshold": policy.confidence_threshold,
                    },
                )
                response.raise_for_status()
                payload = response.json()
                findings = parse_reasoning_findings(payload)
                call.complete(payload=payload)
        return findings, action_usage(call, len(query_content) + len(guard_content))

    def _credential(self) -> str:
        return (self._api_key or "").strip() or (
            os.environ.get(self._api_key_env_var, "").strip()
            if self._api_key_env_var
            else ""
        )


class ReasoningActionProvider:
    """Evaluate complete output against one immutable formal policy snapshot."""

    name = ACTION_AUTOMATED_REASONING
    version = "1.0.0"
    rails = frozenset({"output"})
    capabilities = frozenset({"automated_reasoning"})

    def __init__(self, provider: AutomatedReasoningProvider) -> None:
        self._provider = provider

    async def execute(self, request: ActionRequest) -> ActionResult:
        view = action_view(request)
        active = view.active_block
        if "query" in active.qualifiers:
            return action_result(request,
                "safe",
                request.content,
                reason="The active block supplies reasoning context and is not an output target.",
            )
        if active.role != "model_output":
            return action_result(request,
                "safe",
                request.content,
                reason="Automated Reasoning evaluates complete model-output blocks only.",
            )

        snapshot_id = dict(request.parameters).get("policy_snapshot_id")
        if not snapshot_id:
            return action_result(request,
                "error",
                request.content,
                reason="Automated Reasoning plan step has no policy snapshot.",
            )
        try:
            policy = request.plan.reasoning_policy(snapshot_id)
        except KeyError:
            return action_result(request,
                "error",
                request.content,
                reason="Automated Reasoning policy snapshot is unavailable.",
            )

        query_content = "\n".join(
            block.text for block in view.blocks if "query" in block.qualifiers
        )
        try:
            evaluate_action = getattr(self._provider, "evaluate_action", None)
            if evaluate_action is not None:
                findings, usage = await evaluate_action(
                    request,
                    policy=policy,
                    query_content=query_content,
                    guard_content=request.content,
                )
            else:
                findings, usage = await self._provider.evaluate(
                    policy=policy,
                    query_content=query_content,
                    guard_content=request.content,
                )
        except (httpx.HTTPError, KeyError, TypeError, ValueError, RuntimeError) as error:
            return action_result(request,
                "error",
                request.content,
                reason=f"{self.name} evaluator failed: {type(error).__name__}.",
            )

        if not findings:
            return action_result(request,
                "error",
                request.content,
                reason="Automated Reasoning provider returned no findings.",
            )
        ordered = order_reasoning_findings(findings)
        result = aggregate_reasoning_result(ordered)
        detected = result != "valid"
        message = next(
            (item.message for item in ordered if item.result == result and item.message),
            _result_message(result),
        )
        risk_finding = RiskFinding(
            risk=request.capability,
            taxonomy_id=taxonomy_for_evaluator(request.capability),
            verdict="unsafe" if detected else "safe",
            confidence=min(item.confidence for item in ordered),
            evidence=message,
            recommended_action="pass",
            reasoning=ordered,
        )
        return action_result(request,
            "unsafe" if detected else "safe",
            request.content,
            findings=(
                (risk_finding,)
                if detected or request.evidence_scope == "full"
                else ()
            ),
            reason=message,
            usage=usage,
        )


def aggregate_reasoning_result(
    findings: tuple[AutomatedReasoningFinding, ...],
) -> AutomatedReasoningResult:
    if not findings:
        raise ValueError("Automated Reasoning findings cannot be empty.")
    return min(findings, key=lambda item: (_RESULT_SEVERITY[item.result], item.id)).result


def order_reasoning_findings(
    findings: tuple[AutomatedReasoningFinding, ...],
) -> tuple[AutomatedReasoningFinding, ...]:
    return tuple(
        sorted(findings, key=lambda item: (_RESULT_SEVERITY[item.result], item.id))
    )


def parse_reasoning_findings(payload: Any) -> tuple[AutomatedReasoningFinding, ...]:
    if not isinstance(payload, Mapping):
        raise TypeError("Automated Reasoning response must be an object.")
    values = payload.get("findings")
    if not isinstance(values, list) or not 1 <= len(values) <= 100:
        raise TypeError("Automated Reasoning findings must be a bounded non-empty array.")
    findings = tuple(_finding(item, index) for index, item in enumerate(values, start=1))
    ids = tuple(item.id for item in findings)
    if len(set(ids)) != len(ids):
        raise ValueError("Automated Reasoning finding identifiers must be unique.")
    return order_reasoning_findings(findings)


def _finding(value: Any, index: int) -> AutomatedReasoningFinding:
    if not isinstance(value, Mapping):
        raise TypeError("Each Automated Reasoning finding must be an object.")
    result = str(value.get("result", "")).strip().casefold()
    if result not in _RESULT_SEVERITY:
        raise ValueError("Automated Reasoning finding result is invalid.")
    confidence = _confidence(value.get("confidence"))
    return AutomatedReasoningFinding(
        id=_required_text(value.get("id"), f"finding {index} id"),
        result=result,
        confidence=confidence,
        translation=_translation(value.get("translation")),
        supporting_rules=_rules(value.get("supporting_rules", [])),
        contradicting_rules=_rules(value.get("contradicting_rules", [])),
        claims_true_scenario=_scenario(value.get("claims_true_scenario")),
        claims_false_scenario=_scenario(value.get("claims_false_scenario")),
        message=_optional_text(value.get("message")),
    )


def _translation(value: Any) -> AutomatedReasoningTranslation | None:
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise TypeError("Automated Reasoning translation must be an object.")
    return AutomatedReasoningTranslation(
        premises=_text_array(value.get("premises", []), "translation premises"),
        claims=_text_array(value.get("claims", []), "translation claims"),
        untranslated=_text_array(value.get("untranslated", []), "untranslated text"),
    )


def _rules(value: Any) -> tuple[AutomatedReasoningRuleEvidence, ...]:
    if not isinstance(value, list) or len(value) > 1_500:
        raise TypeError("Automated Reasoning rules must be a bounded array.")
    if not all(isinstance(item, Mapping) for item in value):
        raise TypeError("Each Automated Reasoning rule must be an object.")
    return tuple(
        AutomatedReasoningRuleEvidence(
            id=_required_text(item.get("id"), "rule id"),
            expression=_required_text(item.get("expression"), "rule expression"),
            description=_optional_text(item.get("description")),
        )
        for item in value
    )


def _scenario(value: Any) -> AutomatedReasoningScenario | None:
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise TypeError("Automated Reasoning scenario must be an object.")
    variable_values = value.get("variable_values", {})
    if not isinstance(variable_values, Mapping) or len(variable_values) > 600:
        raise TypeError("Automated Reasoning scenario variable_values must be an object.")
    return AutomatedReasoningScenario(
        variable_values=tuple(
            sorted(
                (
                    _required_text(key, "scenario variable"),
                    _required_text(item, "scenario value"),
                )
                for key, item in variable_values.items()
            )
        )
    )


def _text_array(value: Any, name: str) -> tuple[str, ...]:
    if not isinstance(value, list) or len(value) > 600:
        raise TypeError(f"Automated Reasoning {name} must be a bounded array.")
    return tuple(_required_text(item, name) for item in value)


def _required_text(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise TypeError(f"Automated Reasoning {name} must be non-empty text.")
    return value.strip()


def _optional_text(value: Any) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise TypeError("Automated Reasoning message fields must be text.")
    return value.strip()


def _confidence(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError("Automated Reasoning confidence must be numeric.")
    confidence = float(value)
    if not 0 <= confidence <= 1:
        raise ValueError("Automated Reasoning confidence must be between 0 and 1.")
    return confidence


def _result_message(result: AutomatedReasoningResult) -> str:
    return {
        "valid": "The response is logically valid under the deployed policy.",
        "invalid": "The response contradicts the deployed policy.",
        "satisfiable": "The response requires additional assumptions to establish validity.",
        "impossible": "The translated premises or policy rules are contradictory.",
        "translation_ambiguous": "The response has multiple plausible logical translations.",
        "too_complex": "The response exceeded the reasoning provider's processing capacity.",
        "no_translations": "No policy-relevant logical statements were extracted.",
    }[result]
