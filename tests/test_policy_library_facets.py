from dataclasses import replace
from typing import cast

import pytest

from runner.toolkit.policy_library import PolicyTag, PolicyTagNamespace, policies
from runner.toolkit.policy_library.registry import PolicyLibraryRegistry
from runner.toolkit.nemo.actions.content_filter import BuiltinContentFilter


def test_policy_library_uses_reviewed_facets_and_nemo_rail_terms() -> None:
    tags = [tag for policy in policies() for tag in policy.tags]
    namespaces = {tag.namespace for tag in tags}

    assert "scope" not in namespaces
    assert "stage" not in namespaces
    assert "capability" not in namespaces
    assert "guardrail_category" in namespaces
    assert "rail" in namespaces
    assert ("rail:input", "Input rail") in {(tag.id, tag.label) for tag in tags}
    assert ("rail:output", "Output rail") in {(tag.id, tag.label) for tag in tags}


@pytest.mark.parametrize("namespace", ["scope", "stage"])
def test_policy_library_rejects_retired_facets(namespace: str) -> None:
    policy = policies()[0]
    retired_tag = PolicyTag(
        namespace=cast(PolicyTagNamespace, namespace),
        value="retired",
        label="Retired",
    )

    with pytest.raises(ValueError, match="unsupported tag namespace"):
        PolicyLibraryRegistry((replace(policy, tags=(retired_tag,)),))


def test_policy_library_rejects_unknown_guardrail_categories() -> None:
    policy = policies()[0]
    tag = PolicyTag(
        namespace="guardrail_category",
        value="generic_safety",
        label="Generic safety",
    )

    with pytest.raises(ValueError, match="unknown Guardrail category"):
        PolicyLibraryRegistry((replace(policy, tags=(tag,)),))


def test_local_content_filter_executes_policy_rails_without_a_model() -> None:
    result = BuiltinContentFilter().evaluate(
        text="The phrase internal-only is prohibited.",
        phase="input",
        policies=("keyword-blocking",),
        policy_parameters={"keyword-blocking": {"blocked_words": "internal-only"}},
        enabled_rules={"keyword-blocking": ("keyword/blocked-words",)},
    )

    assert result.verdict == "unsafe"
    assert result.findings[0].rule_id == "keyword/blocked-words"
    assert result.findings[0].recommended_action == "reject"
