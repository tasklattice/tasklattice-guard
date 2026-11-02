from __future__ import annotations

from tests.policy_snapshots import library_definitions

from dataclasses import replace
from pathlib import Path
import json
import subprocess

import pytest

from runner.toolkit.policy_library import policies
from runner.toolkit.nemo.actions.content_filter import BuiltinContentFilter
from runner.toolkit.policy_runtime.codec import policy_from_payload


FOCUSED = tuple(p for p in policies() if p.id.startswith("local-"))
CASES = [(p, case) for p in FOCUSED for case in p.test_cases]
CATALOG = {p.id: p for p in policies()}
EXTENDED_FAMILIES = ("local-government-identifiers", "local-passports", "local-contact-data", "local-payment-data", "local-network-addresses", "local-sensitive-attribute-terms", "local-risk-content-terms")


def test_materialized_capability_policies_are_current() -> None:
    root = Path(__file__).resolve().parents[2]
    subprocess.run(["node", "scripts/build_protection_library.mjs", "--check"], cwd=root, check=True, capture_output=True)
    assert len(FOCUSED) == 14
    assert all(p.parameters == () for p in FOCUSED)
    assert all(r.implementation.execution == "local" for p in FOCUSED for r in p.rules)


@pytest.mark.parametrize("policy,case", CASES, ids=[f"{p.id}:{c.id}" for p, c in CASES])
def test_capability_cases_execute_the_selected_rules(policy, case) -> None:
    result = BuiltinContentFilter().evaluate(definitions={policy.id: policy}, text=case.content, phase=case.phase, policies=(policy.id,), enabled_rules={policy.id: case.covered_rule_ids})
    assert result.verdict != "error", result.reason
    decision = "allow" if result.verdict == "not_matched" else "block" if any(f.recommended_action == "block" for f in result.findings) else "transform"
    assert decision == case.expected_decision, result.reason
    if decision == "transform": assert result.content != case.content
    if case.kind == "rule_acceptance": assert set(case.covered_rule_ids).intersection(f.rule_id for f in result.findings)


@pytest.mark.parametrize("phase", ["input", "output"])
@pytest.mark.parametrize("policy_id,content,expected", [
    ("local-government-identifiers", "Emirates ID: 784-1990-1234567-1", "Emirates ID: [uae_emirates_id_REDACTED]"),
    ("local-government-identifiers", "BSN: 123456789", "BSN: [nl_bsn_contextual_REDACTED]"),
    ("local-government-identifiers", "Tax file number 111111111.", "Tax file number [au_tfn_REDACTED]."),
    ("local-government-identifiers", "University of Toronto student number 1000000000.", "University of Toronto student number [au_medicare_REDACTED]."),
    ("local-passports", "Passport: E12345678", "Passport: [passport_china_REDACTED]"),
    ("local-contact-data", "Phone: +65 8123 4567", "Phone: [international_phone_REDACTED]"),
    ("local-contact-data", "Phone: (11) 2345-6789", "Phone: [br_phone_landline_REDACTED]"),
    ("local-payment-data", "Bank account: 12345-001-1234567", "Bank account: [ca_bank_account_REDACTED]"),
    ("local-government-identifiers", "TFN: 123 456 789", "TFN: [au_tfn_REDACTED]"),
])
def test_extended_formats_redact_the_entire_identifier(phase, policy_id, content, expected) -> None:
    result = BuiltinContentFilter().evaluate(definitions=library_definitions((policy_id,)), text=content, phase=phase, policies=(policy_id,))
    assert result.verdict == "matched"
    assert result.content == expected


def test_extended_disclosure_filters_declare_local_and_complete_response_requirements() -> None:
    from runner.toolkit.policy_library.protection import policy_protection
    for policy_id in EXTENDED_FAMILIES:
        facts = policy_protection(CATALOG[policy_id])
        assert facts["execution"] == "local"
        assert facts["modelCapabilities"] == []
        assert facts["outputStreaming"] == "complete_response"
