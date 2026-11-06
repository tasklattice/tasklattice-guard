from pathlib import Path
import json

from runner.toolkit.policy_library.package import load_package
from tests.control_plane.test_declarative_policies import sources
from runner.toolkit.policy_library.declarative import compile_policy
from tests.control_plane.plan_fixtures import _controller_plans


def test_compiled_policy_rules_have_unique_binding_identities():
    package = load_package(Path("policies/builtin/local-contact-data"))
    compiled = compile_policy(package.definition, sources.registry())
    bindings = [rule["binding_id"] for rule in compiled["rules"]]
    assert len(bindings) == len(set(bindings)) == len(compiled["rules"])
    assert all(binding.startswith("local-contact-data/") for binding in bindings)


def test_plan_carries_binding_identities_with_rule_ids():
    plan = _controller_plans()["grouped"]
    steps = [step for step in plan["steps"] if "binding_ids_json" in dict(step["parameters"])]
    assert steps
    for step in steps:
        params = dict(step["parameters"])
        ids = [item for group in json.loads(params["binding_ids_json"]).values() for item in group]
        assert ids
        assert all(item.startswith(f"{params['policy_id']}/") for item in ids)


async def test_runtime_trace_exposes_binding_identity():
    from runner.compiler import DefaultRunnerCompiler
    from runner.draft_preview import DraftPreviewRuntime
    from runner.toolkit.nemo.action_registry import action_providers
    from runner.toolkit.nemo.actions import local_action_providers
    from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext

    plan = _controller_plans()["grouped"]
    runtime = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers(*local_action_providers()))
    try:
        result = await runtime.evaluate(
            ProtectionRequest(phase="input", texts=("alpha beta",),
                              context=RequestContext(protocol="playground")),
            preview_id="binding-evidence", guardrail_id=plan["guardrail_id"],
            draft_revision=1, candidate_version=plan["guardrail_version"],
            plan=plan, runtime_profile="auto")
    finally:
        await runtime.shutdown()
    assert any(
        step.kind == "action" and "bindingIds=grouped/" in (step.detail or "")
        for step in result.trace
    )


def test_one_rule_can_be_bound_twice_with_distinct_variants():
    from runner.toolkit.policy_library.declarative import compile_policy
    from runner.toolkit.policy_library.package import load_package
    from tests.control_plane.test_declarative_policies import sources

    package = load_package(Path("tests/fixtures/binding-slice"))
    compiled = compile_policy(package.definition, sources.registry())
    rules = {rule["binding_id"]: rule for rule in compiled["rules"]}
    assert set(rules) == {"binding-slice/denylist", "binding-slice/allowlist"}
    assert {rule["rule_id"] for rule in rules.values()} == {"shared/topic-check"}
    assert rules["binding-slice/denylist"]["redaction"] == "[TOPIC_REDACTED]"
    assert rules["binding-slice/allowlist"]["variant_id"] == "allow"
    assert rules["binding-slice/allowlist"]["redaction"] == "[ALLOW_REDACTED]"
    assert rules["binding-slice/denylist"]["keywords"] == [["DENY_TOPIC", "high"]]
    assert rules["binding-slice/allowlist"]["keywords"] == [["ALLOW_TOPIC", "medium"]]
