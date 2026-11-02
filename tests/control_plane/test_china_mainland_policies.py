from __future__ import annotations

from tests.policy_snapshots import library_definitions

import pytest

from runner.toolkit.nemo.actions.content_filter import BuiltinContentFilter
from runner.toolkit.policy_library import policies


CHINA_POLICIES = tuple(p for p in policies() if any(r.id.startswith("cn-") for r in p.rules))
CASES = tuple((p,c) for p in CHINA_POLICIES for c in p.test_cases if c.id.startswith("china-"))


def _decision(result) -> str:
    if result.verdict == "not_matched":
        return "allow"
    if result.verdict == "error":
        return "error"
    if any(finding.recommended_action == "block" for finding in result.findings):
        return "block"
    return "transform"


def test_china_rules_belong_to_shared_capabilities() -> None:
    assert {p.id for p in CHINA_POLICIES} == {"local-government-identifiers", "local-contact-data", "local-payment-data", "local-injection-protection", "local-fraud-prevention"}
    for policy in CHINA_POLICIES:
        assert policy.version == "1.0.0"
        assert all(rule.implementation.execution == "local" for rule in policy.rules)


@pytest.mark.parametrize(
    "policy,case",
    CASES,
    ids=[f"{item.id}:{case.id}" for item, case in CASES],
)
def test_china_mainland_policy_cases_execute_the_published_rules(policy, case) -> None:
    result = BuiltinContentFilter().evaluate(definitions=library_definitions((policy.id,)),
        text=case.content,
        phase=case.phase,
        policies=(policy.id,),
        enabled_rules={policy.id: case.covered_rule_ids},
    )
    assert _decision(result) == case.expected_decision, result.reason
    if case.expected_decision == "transform":
        assert result.content != case.content
    if case.kind == "rule_acceptance":
        assert set(case.covered_rule_ids).intersection(
            finding.rule_id for finding in result.findings
        )


@pytest.mark.parametrize(
    "content",
    [
        "身份证号：990000200001010013",  # Invalid MOD 11-2 checksum.
        "身份证号：990000200002300019",  # Invalid calendar date.
        "统一社会信用代码：91999999GUARD00002",  # Invalid GB 32100 checksum.
        "银行卡号：6222000000000008",  # Invalid Luhn checksum.
    ],
)
def test_checksum_validation_does_not_redact_format_only_candidates(content: str) -> None:
    ids = ("local-government-identifiers", "local-payment-data")
    definitions = library_definitions(ids)
    result = BuiltinContentFilter().evaluate(definitions=definitions, text=content, phase="input", policies=ids,
        enabled_rules={pid: tuple(r.id for r in p.rules if r.id.startswith("cn-")) for pid,p in definitions.items()})
    assert result.verdict == "not_matched"
    assert result.content == content
