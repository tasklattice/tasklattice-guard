from __future__ import annotations

import pytest

from runner.toolkit.nemo.actions.content_filter import BuiltinContentFilter
from runner.toolkit.policy_library import policies


CHINA_POLICIES = tuple(
    item
    for item in policies()
    if any(tag.id == "collection:china-mainland" for tag in item.tags)
)
CASES = tuple(
    (item, case)
    for item in CHINA_POLICIES
    for case in item.test_cases
)


def _decision(result) -> str:
    if result.verdict == "safe":
        return "allow"
    if result.verdict == "error":
        return "error"
    if any(finding.recommended_action == "reject" for finding in result.findings):
        return "block"
    return "transform"


def test_china_mainland_collection_is_versioned_and_locally_executable() -> None:
    assert {item.id for item in CHINA_POLICIES} == {
        "china-personal-identifiers",
        "china-organization-identifiers",
        "china-prompt-manipulation",
        "china-banking-assistant-boundaries",
    }
    for item in CHINA_POLICIES:
        assert item.version == "1.0.0"
        assert any(tag.id == "jurisdiction:cn" for tag in item.tags)
        assert all(rule.form != "colang_flow" for rule in item.rules)


@pytest.mark.parametrize(
    "policy,case",
    CASES,
    ids=[f"{item.id}:{case.id}" for item, case in CASES],
)
def test_china_mainland_policy_cases_execute_the_published_rules(policy, case) -> None:
    result = BuiltinContentFilter().evaluate(
        text=case.content,
        phase=case.phase,
        policies=(policy.id,),
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
    result = BuiltinContentFilter().evaluate(
        text=content,
        phase="input",
        policies=("china-personal-identifiers", "china-organization-identifiers"),
    )
    assert result.verdict == "safe"
    assert result.content == content
