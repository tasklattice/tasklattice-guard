from __future__ import annotations

from tests.policy_snapshots import library_definitions

import json

import pytest

from runner.toolkit.nemo.actions.content_filter import BuiltinContentFilter

POLICY = "configured-phrase-filter"
RULE = "configured/phrases"
ENTRIES = [
    {"id": "mask", "phrase": "private", "action": "transform", "replacement": "public"},
    {"id": "block", "phrase": "private", "action": "block"},
]


def evaluate(text, entries=ENTRIES, phase="input", **kwargs):
    return BuiltinContentFilter().evaluate(definitions=library_definitions((POLICY,)), text=text, phase=phase, policies=(POLICY,),
        policy_parameters={POLICY: {"phrase_entries": json.dumps(entries)}}, **kwargs)


@pytest.mark.parametrize("phase", ["input", "output"])
def test_phrase_policy_owns_results_and_preserves_order(phase):
    result = evaluate("a private label", phase=phase)
    assert result.content == "a public label"
    assert [(f.policy_id, f.rule_id, f.recommended_action) for f in result.findings] == [(POLICY, RULE + "/mask", "transform")]
    assert "mask" in result.findings[0].evidence
    blocked = evaluate("a private label", list(reversed(ENTRIES)), phase)
    assert blocked.content == "a private label"
    assert [f.recommended_action for f in blocked.findings] == ["block"]


@pytest.mark.parametrize("phase", ["input", "output"])
def test_rule_override_records_matches_and_disabled_rules_skip_detection(phase):
    assert evaluate("private", phase=phase, policy_rule_actions={POLICY: {RULE: "block"}}).findings[0].recommended_action == "block"
    observed = evaluate("private", phase=phase, policy_rule_actions={POLICY: {RULE: "allow"}})
    assert observed.verdict == "matched" and observed.content == "private"
    assert observed.findings
    assert [(f.policy_id, f.rule_id, f.recommended_action) for f in observed.findings] == [(POLICY, RULE + "/mask", "allow"), (POLICY, RULE + "/block", "allow")]
    skipped = evaluate("private", phase=phase, enabled_rules={POLICY: ()})
    assert skipped.verdict == "not_matched" and skipped.content == "private"
    assert not skipped.findings


@pytest.mark.parametrize("text", ["ordinary support request", "a privateer", "如何申请账户？"])
def test_normal_text_is_not_overblocked(text):
    assert evaluate(text).verdict == "not_matched"


@pytest.mark.parametrize("entries", [[], {}, [ENTRIES[0], ENTRIES[0]], [{"id": "bad", "phrase": "", "action": "block"}], [{"id": "bad", "phrase": "secret", "action": "execute"}], [{"id": "bad", "phrase": "secret", "action": []}], [ENTRIES[0], {**ENTRIES[0], "id": " mask "}]])
def test_invalid_configuration_is_an_error_not_safe(entries):
    assert evaluate("ordinary", entries).verdict == "error"
