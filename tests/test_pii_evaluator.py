from __future__ import annotations

import time

import pytest

from runner.toolkit.evaluation.contracts import CONTRACT_PII_EXACT, CONTRACT_PII_SEMANTIC
from runner.toolkit.nemo.evaluators.contracts import EvaluationRequest
from runner.toolkit.nemo.evaluators.pii import PiiEvaluator
from runner.toolkit.runtime.contracts import (
    GuardrailPlanSnapshot,
    GuardrailPlanStep,
    EvaluationTrigger,
    NeMoActionBinding,
)


@pytest.mark.asyncio
async def test_local_pii_is_safe_without_a_dependent_contract() -> None:
    result = await PiiEvaluator().evaluate(_request("A normal sentence."))

    assert result.verdict == "safe"
    assert result.usage.model_invocations == 0


@pytest.mark.asyncio
async def test_local_pii_returns_uncertain_when_semantic_contract_is_triggered() -> None:
    result = await PiiEvaluator().evaluate(
        _request("Passport identifier X1234567", semantic=True)
    )

    assert result.verdict == "uncertain"
    assert "semantic PII evaluator" in (result.reason or "")
    assert result.usage.model_invocations == 0

    ordinary = await PiiEvaluator().evaluate(
        _request("A normal sentence.", semantic=True)
    )
    assert ordinary.verdict == "safe"


@pytest.mark.asyncio
async def test_exact_local_pii_hit_short_circuits_with_span_redaction() -> None:
    result = await PiiEvaluator().evaluate(
        _request("Email alice@example.com for help.", semantic=True)
    )

    assert result.verdict == "unsafe"
    assert result.content == "Email [PII_REDACTED] for help."
    assert result.findings[0].taxonomy_id == "TALI-PRIVACY-PII"
    assert result.usage.model_invocations == 0


def _request(content: str, *, semantic: bool = False) -> EvaluationRequest:
    exact = GuardrailPlanStep(
        id="pii:exact",
        capability="pii",
        contract_ref=CONTRACT_PII_EXACT,
        phases=("input",),
        on_unsafe="redact",
    )
    steps = (exact,)
    if semantic:
        steps += (
            GuardrailPlanStep(
                id="pii:semantic",
                capability="pii",
                contract_ref=CONTRACT_PII_SEMANTIC,
                phases=("input",),
                on_unsafe="redact",
                trigger=EvaluationTrigger(
                    type="on_result",
                    step_ref=exact.id,
                    verdicts=("uncertain",),
                ),
            ),
        )
    plan = GuardrailPlanSnapshot(
        guardrail_id="guardrail-pii",
        guardrail_version="20260904-010000.001Z",
        compiler_version="test",
        safety_level="balanced",
        output_delivery="full_buffered",
        steps=steps,
    )
    binding = NeMoActionBinding(
        id=exact.id,
        capability=exact.capability,
        contract_ref=exact.contract_ref,
        phases=exact.phases,
        on_unsafe=exact.on_unsafe,
    )
    return EvaluationRequest(
        content=content,
        rail_type="input",
        guardrail_id=plan.guardrail_id,
        guardrail_version=plan.guardrail_version,
        policy_id=None,
        policy_version=None,
        trusted_context=(),
        content_blocks=(),
        deadline=time.monotonic() + 5,
        parameters=(),
        capability="pii",
        proposed_action="redact",
        plan=plan,
        binding=binding,
    )
