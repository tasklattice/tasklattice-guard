"""Transformation results must be concrete, never fabricated fallback messages."""
from types import SimpleNamespace

import pytest

from runner.toolkit.nemo.runtime import _PatchConflict, _resolved_content
from runner.toolkit.nemo.actions.content_filter import BuiltinContentFilter


def result(content, replacement=None):
    findings = () if replacement is None else (SimpleNamespace(recommended_action="transform", replacement=replacement),)
    return SimpleNamespace(result=SimpleNamespace(content=content, findings=findings))


def test_transform_without_output_fails_closed():
    with pytest.raises(_PatchConflict, match="explicit replacement"):
        _resolved_content("secret", "transform", (result("secret"),))


def test_whole_content_replacement_is_explicit():
    assert _resolved_content("secret", "transform", (result("secret", "safe reply"),)) == "safe reply"


def test_conflicting_transforms_fail_closed():
    with pytest.raises(_PatchConflict, match="Conflicting"):
        _resolved_content("secret", "transform", (result("masked"), result("hidden")))


@pytest.mark.parametrize("replacement", ["public", ""])
def test_custom_rule_transform_applies_exact_replacement(replacement):
    outcome = BuiltinContentFilter().evaluate(text="secret", phase="input", policies=(), custom_rules=(
        {"id": "sensitive", "phases": ["input"], "detector": "keyword", "keywords": ["secret"],
         "action": "transform", "replacement": replacement},))
    assert outcome.verdict == "matched"
    assert outcome.content == replacement


def test_custom_rule_without_replacement_is_an_execution_error():
    outcome = BuiltinContentFilter().evaluate(text="secret", phase="input", policies=(), custom_rules=(
        {"id": "sensitive", "phases": ["input"], "detector": "keyword", "keywords": ["secret"],
         "action": "transform"},))
    assert outcome.verdict == "error"


def test_phrase_observation_preserves_text_and_evidence():
    import json
    outcome = BuiltinContentFilter().evaluate(text="secret", phase="input", policies=["configured-phrase-filter"],
        policy_parameters={"configured-phrase-filter": {"phrase_entries": json.dumps([
            {"id": "observe", "phrase": "secret", "action": "allow"}])}})
    assert outcome.verdict == "matched"
    assert outcome.content == "secret"
    assert outcome.findings[0].recommended_action == "allow"
