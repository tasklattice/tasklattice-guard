"""Candidate checks are algorithms; Rule configuration supplies business formats."""
from copy import deepcopy
from dataclasses import replace
from pathlib import Path

import pytest

from runner.toolkit.nemo.actions.content_filter import BuiltinContentFilter
from runner.toolkit.policy_library.declarative import PolicyDefinition, compile_policy
from runner.toolkit.policy_library.loader import _policy
from runner.toolkit.policy_library.package import load_package
from runner.toolkit.policy_library.pattern_validation import parse_pattern_validators, valid_pattern_candidate
from runner.toolkit.policy_library.regression import run_packages
from scripts.policy_sources import ASSETS, registry


ROOT = Path(__file__).resolve().parents[2]
CHECKSUM = {"type": "weighted_checksum", "alphabet": "ABC", "weights": [1, 2], "check_characters": "XYZ"}


@pytest.mark.parametrize("value, valid", [("ABZ", True), ("abz", True), ("ABY", False), ("DBZ", False), ("ABZZ", False)])
def test_weighted_checksum_has_no_country_or_identifier_length_assumptions(value, valid):
    assert valid_pattern_candidate(value, parse_pattern_validators([CHECKSUM])) is valid


@pytest.mark.parametrize("value, valid", [("DOC-20240229", True), ("DOC-20230229", False), ("DOC-20240431", False), ("DOC-202402", False)])
def test_date_check_applies_to_configured_candidate_offset(value, valid):
    validators = parse_pattern_validators([{"type": "date", "start": 4}])
    assert valid_pattern_candidate(value, validators) is valid


@pytest.mark.parametrize("value, valid", [("4111-1111 1111-1111", True), ("4111111111111112", False), ("ABC4111111111111111", False), ("４１１１１１１１１１１１１１１１", False), ("", False)])
def test_luhn_check_accepts_formatting_but_rejects_invalid_candidates(value, valid):
    assert valid_pattern_candidate(value, parse_pattern_validators([{"type": "luhn"}])) is valid


@pytest.mark.parametrize("validator", [
    {"type": "cn-resident-id"},
    {"type": "date", "start": -1},
    {"type": "date", "start": True},
    {"type": "date", "format": "MMDDYYYY"},
    {"type": "luhn", "unknown": True},
    {**CHECKSUM, "alphabet": "ABA"},
    {**CHECKSUM, "alphabet": "ab"},
    {**CHECKSUM, "weights": []},
    {**CHECKSUM, "weights": [True]},
    {**CHECKSUM, "weights": [-1]},
    {**CHECKSUM, "check_characters": ""},
])
def test_invalid_validator_configuration_is_rejected_before_execution(validator):
    raw = load_package(ROOT / "policies/examples/customer-information").definition.model_dump(exclude_unset=True)
    raw["rules"][0]["detector"]["parameters"]["validators"] = [validator]
    with pytest.raises(ValueError):
        compile_policy(PolicyDefinition.model_validate(raw), registry())


def _number_rule():
    raw = load_package(ROOT / "policies/examples/customer-information").definition.model_dump(exclude_unset=True)
    raw["rules"][0]["detector"]["parameters"] = {
        "expression": r"\b[0-9]{16}\b", "validators": [{"type": "luhn"}], "allow_word_numbers": True,
    }
    compiled = _policy(compile_policy(PolicyDefinition.model_validate(raw), registry()))
    return replace(compiled, rules=(compiled.rules[0],))


@pytest.mark.parametrize("last_word, verdict", [("one", "unsafe"), ("two", "safe")])
def test_spelled_out_numbers_obey_the_same_candidate_checks(last_word, verdict):
    policy = _number_rule()
    text = "four " + "one " * 14 + last_word
    result = BuiltinContentFilter().evaluate(text=text, phase="output", policies=[policy.id], definitions={policy.id: policy})
    assert result.verdict == verdict
    assert (result.content != text) is (verdict == "unsafe")


def test_all_validators_must_pass_and_invalid_pinned_config_is_not_ignored():
    # A date check and a checksum apply to the same candidate, in declared order.
    validators = parse_pattern_validators([
        {"type": "date"},
        {"type": "weighted_checksum", "alphabet": "0123456789", "weights": [1] * 8, "check_characters": "0123456789"},
    ])
    assert valid_pattern_candidate("202402291", validators)
    assert not valid_pattern_candidate("202402292", validators)
    assert not valid_pattern_candidate("202302290", validators)

    raw = load_package(ROOT / "policies/examples/customer-information").definition.model_dump(exclude_unset=True)
    payload = compile_policy(PolicyDefinition.model_validate(raw), registry())
    payload["rules"][0]["validators"] = [{"type": "missing"}]
    with pytest.raises(ValueError):
        _policy(payload)
    payload["rules"][0]["validators"] = []
    payload["rules"][1]["validators"] = [{"type": "luhn"}]
    with pytest.raises(ValueError, match="require the regex detector"):
        _policy(payload)


@pytest.mark.parametrize("ref", ["privacy/cn-resident-id", "privacy/cn-social-credit", "privacy/luhn"])
def test_business_named_detector_entries_are_removed(ref):
    raw = load_package(ROOT / "policies/examples/customer-information").definition.model_dump(exclude_unset=True)
    raw["rules"][0]["detector"]["ref"] = ref
    with pytest.raises(ValueError, match="detector/version unavailable"):
        compile_policy(PolicyDefinition.model_validate(raw), registry())


async def test_custom_checksum_rule_executes_through_controller_and_nemo(tmp_path):
    import shutil
    import yaml

    path = tmp_path / "policy"
    shutil.copytree(ROOT / "policies/examples/customer-information", path)
    rule = path / "rules/customer-id.yaml"
    raw = yaml.safe_load(rule.read_text())
    raw["detector"]["parameters"] = {"expression": r"\b[ABC]{2}[XYZ]\b", "validators": [deepcopy(CHECKSUM)]}
    rule.write_text(yaml.safe_dump(raw, allow_unicode=True))
    for tests in (path / "tests").glob("*.yaml"):
        cases = yaml.safe_load(tests.read_text())
        for case in cases:
            for field in ("content", "expected_text"):
                if isinstance(case.get(field), str):
                    case[field] = case[field].replace("CUS-123456", "ABZ")
        if tests.name == "acceptance.yaml":
            cases.append({"id": "invalid-checksum", "name": "Keep an invalid candidate", "phase": "output", "content": "ABY",
                          "expected_decision": "allow", "covered_rule_ids": [raw["id"]],
                          "expected_matched_rules": [], "scope": "rule"})
        tests.write_text(yaml.safe_dump(cases, allow_unicode=True))
    report = await run_packages([load_package(path)], registry(), ASSETS)
    assert report["summary"] == {"passed": 5, "failed": 0, "not_run": 0}, report
