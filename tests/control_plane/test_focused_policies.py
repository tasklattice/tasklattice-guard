from __future__ import annotations

from dataclasses import replace
from pathlib import Path
import subprocess

import pytest

from runner.toolkit.policy_library import policies
from runner.toolkit.nemo.actions.content_filter import BuiltinContentFilter


FOCUSED = tuple(p for p in policies() if any(t.id == "collection:focused-protection" for t in p.tags))
CASES = [(p, case) for p in FOCUSED for case in p.test_cases]
CATALOG = {p.id: p for p in policies()}
EXTENDED_FAMILIES = (
    "local-government-identifiers", "local-passport-formats", "local-regional-contact-formats",
    "local-bank-account-formats", "local-travel-identifiers", "local-network-addresses",
    "local-sensitive-attribute-terms", "local-risk-content-terms",
)
PASSPORT_ALIASES = {
    "pattern/passport_uk": "pattern/passport_us",
    "pattern/passport_australia": "pattern/passport_india",
    "pattern/passport_japan": "pattern/passport_netherlands",
    "pattern/eu_passport_generic": "pattern/passport_france",
}


def test_materialized_focused_policies_are_current() -> None:
    root = Path(__file__).resolve().parents[2]
    subprocess.run(["node", "scripts/build_protection_library.mjs", "--check"], cwd=root, check=True, capture_output=True)
    assert len(FOCUSED) == 22
    assert "mas-ai-risk-management" not in CATALOG
    assert "singapore-financial-conduct" not in CATALOG
    for policy in FOCUSED:
        assert policy.parameters == ()
        assert set(policy.rails) == {"input", "output"}
        assert all(rule.form != "colang_flow" for rule in policy.rules)
        assert any(case.expected_decision == "allow" for case in policy.test_cases)


@pytest.mark.parametrize("policy,case", CASES, ids=[f"{p.id}:{c.id}" for p, c in CASES])
def test_each_focused_policy_runs_its_own_input_and_output_acceptance_cases(policy, case) -> None:
    result = BuiltinContentFilter().evaluate(text=case.content, phase=case.phase, policies=(policy.id,))
    assert result.verdict != "error", result.reason
    decision = "allow" if result.verdict == "safe" else "block" if any(f.recommended_action == "reject" for f in result.findings) else "transform"
    assert decision == case.expected_decision, result.reason
    if decision == "transform":
        assert result.content != case.content
    if case.kind == "rule_acceptance":
        assert set(case.covered_rule_ids).intersection(f.rule_id for f in result.findings)


def test_extended_families_preserve_source_matching_actions_and_acceptance_inputs() -> None:
    """A split cannot silently drop an ID format, change a regex or erase a test."""
    original = CATALOG["pattern-matching"]
    # These belong to the existing starter/contact/payment/credential families,
    # not the extended-family migration under test here.
    existing_families = {f"pattern/{name}" for name in (
        "email", "us_phone", "visa", "mastercard", "amex", "discover", "credit_card",
        "iban", "eu_iban_enhanced", "aws_access_key", "aws_secret_key", "github_token",
        "slack_token", "generic_api_key",
    )}
    original_rules = {rule.id: rule for rule in original.rules}
    owners = {}
    for policy_id in EXTENDED_FAMILIES:
        policy = CATALOG[policy_id]
        for rule in policy.rules:
            assert rule.id not in owners, f"Duplicated detector {rule.id}"
            owners[rule.id] = policy_id
            assert replace(rule, implementation=replace(rule.implementation, binding_id=original.id)) == original_rules[rule.id]
            for phase in ("input", "output"):
                assert any(case.phase == phase and case.kind == "rule_acceptance" and rule.id in case.covered_rule_ids
                           for case in policy.test_cases), (policy_id, rule.id, phase)
    assert set(owners) | set(PASSPORT_ALIASES) == set(original_rules) - existing_families
    for source in original.test_cases:
        if set(source.covered_rule_ids) <= existing_families:
            continue
        target_rule = PASSPORT_ALIASES.get(source.covered_rule_ids[0], source.covered_rule_ids[0])
        policy = CATALOG[owners[target_rule]]
        for phase in ("input", "output"):
            retained = next(case for case in policy.test_cases if case.id == f"{source.id}/{phase}")
            assert retained.content == source.content
            assert retained.expected_decision == source.expected_decision
            assert retained.required and retained.phase == phase
            expected_rule = "pattern/br_phone_mobile" if source.id == "accept/br_phone_landline" else target_rule
            assert retained.covered_rule_ids == (expected_rule,)


def test_spaced_australian_identifiers_keep_the_complete_original_detectors() -> None:
    original = CATALOG["baseline-pii-protection"]
    focused = CATALOG["local-australian-tax-health-identifiers"]
    originals = {rule.id: rule for rule in original.rules if rule.id.startswith("au-pii-tax-identifiers/")}
    assert {rule.id for rule in focused.rules} == set(originals)
    for rule in focused.rules:
        old = originals[rule.id]
        assert replace(rule, rails=old.rails, implementation=replace(rule.implementation, binding_id=old.implementation.binding_id)) == old
    for source in original.test_cases:
        if not set(source.covered_rule_ids) <= set(originals):
            continue
        for phase in ("input", "output"):
            retained = next(case for case in focused.test_cases if case.id == f"{source.id}/{phase}")
            assert (retained.content, retained.covered_rule_ids, retained.expected_decision) == (
                source.content, source.covered_rule_ids, source.expected_decision,
            )


@pytest.mark.parametrize("phase", ["input", "output"])
@pytest.mark.parametrize("policy_id,content,expected", [
    ("local-government-identifiers", "Emirates ID: 784-1990-1234567-1", "Emirates ID: [uae_emirates_id_REDACTED]"),
    ("local-government-identifiers", "BSN: 123456789", "BSN: [nl_bsn_contextual_REDACTED]"),
    ("local-government-identifiers", "Tax file number 111111111.", "Tax file number [au_tfn_REDACTED]."),
    ("local-government-identifiers", "University of Toronto student number 1000000000.", "University of Toronto student number [uoft_student_id_REDACTED]."),
    ("local-passport-formats", "Passport: E12345678", "Passport: [passport_china_REDACTED]"),
    ("local-regional-contact-formats", "Phone: +65 8123 4567", "Phone: [sg_phone_REDACTED]"),
    ("local-regional-contact-formats", "Phone: (11) 2345-6789", "Phone: [br_phone_landline_REDACTED]"),
    ("local-bank-account-formats", "Bank account: 12345-001-1234567", "Bank account: [ca_bank_account_REDACTED]"),
    ("local-travel-identifiers", "Skywards EK 111111111", "Skywards [skywards_number_REDACTED]"),
    ("local-australian-tax-health-identifiers", "TFN: 123 456 789", "TFN: [au_tfn_REDACTED]"),
])
def test_extended_formats_redact_the_entire_identifier(phase, policy_id, content, expected) -> None:
    result = BuiltinContentFilter().evaluate(text=content, phase=phase, policies=(policy_id,))
    assert result.verdict == "unsafe"
    assert result.content == expected


def test_extended_disclosure_filters_declare_local_and_complete_response_requirements() -> None:
    from runner.toolkit.policy_library.protection import policy_protection
    for policy_id in EXTENDED_FAMILIES:
        facts = policy_protection(CATALOG[policy_id])
        assert facts["execution"] == "local"
        assert facts["modelCapabilities"] == []
        assert facts["outputStreaming"] == "complete_response"
