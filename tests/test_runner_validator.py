from __future__ import annotations

import pytest

from runner.compiler import DefaultRunnerCompiler
from runner import generated as protocol
from runner.protocol_codec import plan_to_proto, validation_test_to_proto
from runner.validator import DefaultRunnerValidator


@pytest.mark.asyncio
async def test_default_runner_validates_cases_through_the_real_nemo_runtime() -> None:
    plan = {
        "guardrail_id": "guardrail-1",
        "guardrail_version": 1,
        "compiler_version": "tasklattice-controller-plan-v3",
        "safety_level": "balanced",
        "output_delivery": "full_buffered",
        "steps": [{
            "id": "secrets:exact",
            "capability": "secrets",
            "contract_ref": "tali.guard.secrets.exact.v1",
            "phases": ["input", "output"],
            "on_unsafe": "reject",
            "trigger": {"type": "always", "verdicts": []},
            "parameters": [],
        }],
        "modules": [{
            "id": "data_protection:input",
            "module": "data_protection",
            "phase": "input",
            "step_ids": ["secrets:exact"],
            "depends_on": [],
            "input_view": "original",
            "required_for_release": True,
            "timeout_ms": 750,
            "failure_mode": "fail_closed",
        }, {
            "id": "data_protection:output",
            "module": "data_protection",
            "phase": "output",
            "step_ids": ["secrets:exact"],
            "depends_on": [],
            "input_view": "original",
            "required_for_release": True,
            "timeout_ms": 750,
            "failure_mode": "fail_closed",
        }],
        "reasoning_policies": [],
        "policy_versions": [],
        "policy_bindings": [],
    }
    cases = [{
        "id": "safe",
        "name": "Safe prompt",
        "policyId": "builtin-secrets",
        "phase": "input",
        "content": "Summarize the quarterly report.",
        "expectedDecision": "allow",
        "required": True,
        "coveredRuleIds": [],
    }, {
        "id": "blocked",
        "name": "Credential prompt",
        "policyId": "builtin-secrets",
        "phase": "input",
        "content": "api_key=abcdefghijklmnop",
        "expectedDecision": "block",
        "required": True,
        "coveredRuleIds": [],
    }]

    status, metrics, results = await DefaultRunnerValidator(DefaultRunnerCompiler()).validate(
        protocol.ValidationRequest(
            run_id="validation-1",
            guardrail_id="guardrail-1",
            candidate_version=1,
            source_draft_revision=1,
            plan=plan_to_proto(plan),
            runtime_profile="auto",
            test_cases=[validation_test_to_proto({
                **case,
                "trustedInstruction": "",
                "targetSource": "user_input",
                "groundingSources": [],
                "caseType": "scenario",
            }) for case in cases],
        )
    )

    assert status == "passed"
    assert metrics["total"] == 2
    assert metrics["passed"] == 2
    assert metrics["complianceRate"] == 100
    assert [(item["caseId"], item["actualDecision"], item["passed"]) for item in results] == [
        ("safe", "allow", True),
        ("blocked", "block", True),
    ]
    assert results[1]["findings"][0]["risk"] == "secrets"
