from pathlib import Path

from runner.toolkit.policy_library.declarative import compile_policy
from runner.toolkit.policy_library.package import load_package
from runner.toolkit.policy_library.rules import RuleRegistry
from scripts.policy_sources import registry


def test_policy_catalog_contains_21_policies_and_all_shared_rules():
    rules = RuleRegistry.load(Path("policies/rules"))
    compiled = []
    for path in sorted(Path("policies/library").glob("*/policy.yaml")):
        package = load_package(path.parent, rules)
        compiled.append(compile_policy(package.definition, registry()))
    assert len(compiled) == 21
    assert sum(len(policy["rules"]) for policy in compiled) == 200
    ids = {policy["id"] for policy in compiled}
    assert "payment-data" in ids
    assert "regional-compliance-sg-pdpa" in ids
    assert "regional-compliance-uae-content-standards" in ids
