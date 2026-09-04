from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from runner import generated as protocol
from runner.compiler import DefaultRunnerCompiler
from runner.protocol_codec import plan_to_proto, validation_test_to_proto
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.actions import (
    EvaluationActionProvider,
    EvaluationRoute,
    local_action_providers,
)
from runner.toolkit.nemo.actions.names import ACTION_EVALUATE
from runner.toolkit.nemo.evaluators.pii import PiiEvaluator
from runner.toolkit.nemo.evaluators.safety_model import SafetyModelEvaluator
from runner.toolkit.evaluation.contracts import CONTRACT_PII_EXACT, CONTRACT_PII_SEMANTIC
from runner.toolkit.safety.providers import (
    SafetyModelProviderConfig,
    build_safety_model_provider,
)
from runner.validator import DefaultRunnerValidator


@pytest.mark.asyncio
async def test_nemo_pii_flow_short_circuits_local_hits_and_escalates_to_qwen() -> None:
    model_inputs: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(0.015)
        body = json.loads(request.content)
        content = body["messages"][-1]["content"]
        model_inputs.append(content)
        model_output = (
            "Safety: Unsafe\nCategories: PII"
            if "X1234567" in content
            else "Safety: Safe\nCategories: None"
        )
        return httpx.Response(200, json={
            "choices": [{"message": {"content": model_output}}],
            "usage": {"prompt_tokens": 8, "completion_tokens": 3},
        })

    qwen = build_safety_model_provider(
        SafetyModelProviderConfig(
            id="qwen-pii",
            adapter="qwen3guard",
            base_url="http://qwen-pii.mock/v1",
            model="Qwen/Qwen3Guard-Gen-8B",
            timeout_seconds=1,
            priority=10,
            contract_ref=CONTRACT_PII_SEMANTIC,
            profile_ref="tali.qwen3guard.v1",
            runtime_ref="qwen-runtime",
        ),
        transport=httpx.MockTransport(handler),
    )
    local = local_action_providers()
    safety_evaluator = SafetyModelEvaluator((qwen,))
    evaluation = EvaluationActionProvider((
        EvaluationRoute("pii", CONTRACT_PII_EXACT, PiiEvaluator()),
        EvaluationRoute("pii", CONTRACT_PII_SEMANTIC, safety_evaluator),
    ))
    providers = action_providers(*local, evaluation)
    validator = DefaultRunnerValidator(DefaultRunnerCompiler(), providers)

    status, _metrics, results = await validator.validate(
        protocol.ValidationRequest(
            run_id="validation-pii-escalation",
            guardrail_id="guardrail-pii-escalation",
            candidate_version="20260904-010000.001Z",
            source_draft_revision=1,
            plan=plan_to_proto(_plan()),
            runtime_profile="auto",
            test_cases=[
                validation_test_to_proto(_case(
                    "local-hit",
                    "Contact alice@example.com",
                    "intervene",
                )),
                validation_test_to_proto(_case(
                    "model-hit",
                    "Passport identifier X1234567",
                    "intervene",
                )),
                validation_test_to_proto(_case(
                    "model-safe",
                    "A normal sentence.",
                    "allow",
                )),
            ],
        )
    )

    assert status == "passed"
    assert model_inputs == ["Passport identifier X1234567"]
    assert results[0]["outputContent"] == "Contact [PII_REDACTED]"
    assert results[1]["outputContent"] == "[PII_REDACTED]"
    assert results[2]["outputContent"] == "A normal sentence."
    model_action = next(
        item
        for item in results[1]["trace"]
        if item["kind"] == "action"
        and item["contract_ref"] == CONTRACT_PII_SEMANTIC
    )
    assert model_action["action_name"] == ACTION_EVALUATE
    assert model_action["provider_name"] == "qwen-pii"
    assert model_action["model_name"] == "Qwen/Qwen3Guard-Gen-8B"
    assert model_action["evaluator_id"] == "qwen-pii"
    assert model_action["profile_ref"] == "tali.qwen3guard.v1"
    assert model_action["provider_latency_ms"] >= 10

    strict_status, _strict_metrics, strict_results = await validator.validate(
        protocol.ValidationRequest(
            run_id="validation-pii-strict",
            guardrail_id="guardrail-pii-escalation",
            candidate_version="20260904-020000.002Z",
            source_draft_revision=2,
            plan=plan_to_proto(_plan(safety_level="strict")),
            runtime_profile="auto",
            test_cases=[validation_test_to_proto(_case(
                "strict-safe-review", "A normal sentence.", "allow",
            ))],
        )
    )
    assert strict_status == "passed"
    assert model_inputs == ["Passport identifier X1234567", "A normal sentence."]
    assert strict_results[0]["escalated"] is True
    assert strict_results[0]["modelInvocations"] == 1


def _plan(*, safety_level: str = "balanced") -> dict[str, object]:
    return {
        "safety_level": safety_level,
        "output_delivery": "full_buffered",
        "steps": [
            {
                "id": "pii:exact",
                "capability": "pii",
                "contract_ref": CONTRACT_PII_EXACT,
                "phases": ["input"],
                "on_unsafe": "redact",
                "trigger": {"type": "always"},
                "parameters": [],
            },
            {
                "id": "pii:semantic",
                "capability": "pii",
                "contract_ref": CONTRACT_PII_SEMANTIC,
                "phases": ["input"],
                "on_unsafe": "redact",
                "trigger": {
                    "type": "on_result",
                    "step_ref": "pii:exact",
                    "verdicts": (
                        ["safe", "uncertain"]
                        if safety_level == "strict"
                        else ["uncertain"]
                    ),
                },
                "parameters": [],
            },
        ],
        "modules": [{
            "id": "data-protection:input",
            "module": "data_protection",
            "phase": "input",
            "step_ids": ["pii:exact", "pii:semantic"],
            "depends_on": [],
            "input_view": "original",
            "required_for_release": True,
            "timeout_ms": 5_000,
            "failure_mode": "fail_closed",
        }],
        "reasoning_policies": [],
        "policy_versions": [],
        "policy_bindings": [],
    }


def _case(id: str, content: str, expected: str) -> dict[str, object]:
    return {
        "id": id,
        "name": id,
        "policyId": "builtin-pii",
        "phase": "input",
        "content": content,
        "expectedDecision": expected,
        "required": True,
        "coveredRuleIds": [],
        "trustedInstruction": "",
        "targetSource": "user_input",
        "groundingSources": [],
        "caseType": "scenario",
    }
