from __future__ import annotations

from copy import deepcopy
from unittest.mock import AsyncMock

import pytest

from runner.compiler import DefaultRunnerCompiler
from runner.protocol_codec import validation_test_from_proto, validation_test_to_proto
from runner.serialization import plan_from_dict
from runner.toolkit.runtime.contracts import ProtectionDecision, RiskFinding
from runner.validator import DefaultRunnerValidator


@pytest.mark.parametrize("change", ["none", "partial_output", "wrong_rule", "stale", "unreviewed"])
async def test_composition_assertions_require_reviewed_evidence_and_complete_output(change):
    case = {
        "id": "inherited", "name": "Complete ID redaction", "policyId": "pattern",
        "phase": "input", "content": "ID: 784-1990-1234567-1",
        "expectedDecision": "transform", "required": True,
        "sourcePolicyId": "pattern", "sourcePolicyVersion": "1", "sourceCaseId": "id-case",
        "coveredRuleIds": ["later-id"],
        "expectationOverride": {
            "sourcePolicyVersion": "1", "reason": "Earlier Policy fully redacts the same ID.",
            "expectedDecision": "transform", "expectedOutputContent": "ID: [REDACTED]",
            "expectedMatches": [{"policyId": "earlier", "ruleId": "complete-id"}],
        },
    }
    original = deepcopy(case)
    output = "ID: 784-[REDACTED]-1" if change == "partial_output" else "ID: [REDACTED]"
    rule = "wrong" if change == "wrong_rule" else "complete-id"
    if change == "stale":
        case["expectationOverride"]["sourcePolicyVersion"] = "old"
    if change == "unreviewed":
        case["expectationOverride"]["reason"] = ""
    # A mock execution response isolates Validator assertions from compilation
    # and detection. In particular, partial_output has the RIGHT Rule and final
    # decision but still must fail the output-content contract.
    runtime = AsyncMock()
    runtime.evaluate.return_value = ProtectionDecision(
        decision="transform", action="redact", texts=(output,), findings=(RiskFinding(
            risk="pii", taxonomy_id="pii", verdict="unsafe", confidence=1,
            evidence="Synthetic complete-ID detector.", recommended_action="redact",
            policy_id="earlier", rule_id=rule,
        ),),
    )
    plan = plan_from_dict({
        "guardrail_id": "test", "guardrail_version": 1, "compiler_version": "test",
        "safety_level": "balanced", "output_delivery": "full_buffered",
        "steps": [], "modules": [],
    })
    decoded = validation_test_from_proto(validation_test_to_proto(case))
    result = await DefaultRunnerValidator(DefaultRunnerCompiler())._evaluate(runtime, plan, decoded)
    assert result["passed"] is (change == "none")
    assert result["templateExpectedDecision"] == original["expectedDecision"]
    assert result["sourcePolicyId"] == original["sourcePolicyId"]
    assert result["coveredRuleIds"] == original["coveredRuleIds"]
    if change == "partial_output":
        assert any("complete-output" in failure for failure in result["assertionFailures"])
