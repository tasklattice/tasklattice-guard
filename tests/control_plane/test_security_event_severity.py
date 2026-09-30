"""Risk snapshots cross the wire without depending on action or confidence."""
from dataclasses import replace, asdict
import pytest
from runner.serialization import plan_from_dict
from runner.protocol_codec import plan_from_proto, plan_to_proto, validation_case_result_to_proto
from runner.toolkit.nemo.runtime import _snapshot_finding_risks
from runner.toolkit.runtime.contracts import ProtectionDecision, RiskFinding
from runner.api import _telemetry_metadata


def plan_payload(level=None):
    return dict(guardrail_id="guard", guardrail_version="20260929-000000.000Z", safety_level="balanced", output_delivery="full_buffered", policy_bindings=[dict(policy_id="credentials", policy_version="7", enabled_rule_ids=["key"], enabled_rails=["input"], rule_severities=[] if level is None else [["key", level]])])


@pytest.mark.parametrize("level", ["critical", "high", "medium", "low", "informational", None])
def test_frozen_rule_risk_survives_wire_and_telemetry(level):
    payload = plan_payload(level)
    plan = plan_from_dict(plan_from_proto(plan_to_proto(payload)))
    payload["policy_bindings"][0]["rule_severities"] = [["key", "low"]]
    for action in ("allow", "block", "transform", "transform", "block", "block", "block", "block"):
        finding = RiskFinding("secrets", "TALI-PRIVACY-CREDENTIAL", "matched", .1, "synthetic", action, policy_id="credentials", rule_id="key", risk_severity="critical")
        stamped = _snapshot_finding_risks(plan, [finding])[0]
        assert stamped.risk_severity == level
        assert stamped.policy_version == "7"
        decision = ProtectionDecision(decision="allow", action=action, findings=(stamped,))
        metadata = _telemetry_metadata(decision)
        assert metadata["findings"][0]["riskSeverity"] == level
        assert metadata["findings"][0]["policyVersion"] == "7"
        wire = validation_case_result_to_proto({"findings": [asdict(stamped)]})
        assert (wire.findings[0].risk_severity or None) == level
        failed = _snapshot_finding_risks(plan, [replace(finding, verdict="error")])[0]
        assert failed.risk_severity is None
        assert _telemetry_metadata(replace(decision, findings=(failed,)))["executionStatus"] == "error"


def test_invalid_rule_risk_cannot_enter_a_plan():
    with pytest.raises(ValueError, match="risk level"):
        plan_from_dict(plan_payload("block"))
