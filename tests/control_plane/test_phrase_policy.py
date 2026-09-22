from __future__ import annotations

import json

import pytest

from runner.toolkit.nemo.actions.content_filter import BuiltinContentFilter

POLICY = "configured-phrase-filter"
RULE = "configured/phrases"
ENTRIES = [
    {"id": "mask", "phrase": "private", "action": "redact", "replacement": "public"},
    {"id": "block", "phrase": "private", "action": "reject"},
]


def evaluate(text, entries=ENTRIES, phase="input", **kwargs):
    return BuiltinContentFilter().evaluate(text=text, phase=phase, policies=(POLICY,),
        policy_parameters={POLICY: {"phrase_entries": json.dumps(entries)}}, **kwargs)


@pytest.mark.parametrize("phase", ["input", "output"])
def test_phrase_policy_owns_results_and_preserves_order(phase):
    result = evaluate("a private label", phase=phase)
    assert result.content == "a public label"
    assert [(f.policy_id, f.rule_id, f.recommended_action) for f in result.findings] == [(POLICY, RULE, "redact")]
    assert "mask" in result.findings[0].evidence
    blocked = evaluate("a private label", list(reversed(ENTRIES)), phase)
    assert blocked.content == "a private label"
    assert [f.recommended_action for f in blocked.findings] == ["reject"]


@pytest.mark.parametrize("phase", ["input", "output"])
def test_rule_override_records_matches_and_disabled_rules_skip_detection(phase):
    assert evaluate("private", phase=phase, policy_rule_actions={POLICY: {RULE: "reject"}}).findings[0].recommended_action == "reject"
    observed = evaluate("private", phase=phase, policy_rule_actions={POLICY: {RULE: "pass"}})
    assert observed.verdict == "unsafe" and observed.content == "private"
    assert observed.findings
    assert all((f.policy_id, f.rule_id, f.recommended_action) == (POLICY, RULE, "pass") for f in observed.findings)
    skipped = evaluate("private", phase=phase, enabled_rules={POLICY: ()})
    assert skipped.verdict == "safe" and skipped.content == "private"
    assert not skipped.findings


@pytest.mark.parametrize("text", ["ordinary support request", "a privateer", "如何申请账户？"])
def test_normal_text_is_not_overblocked(text):
    assert evaluate(text).verdict == "safe"


@pytest.mark.parametrize("entries", [[], {}, [ENTRIES[0], ENTRIES[0]], [{"id": "bad", "phrase": "", "action": "reject"}], [{"id": "bad", "phrase": "secret", "action": "execute"}], [{"id": "bad", "phrase": "secret", "action": []}], [ENTRIES[0], {**ENTRIES[0], "id": " mask "}]])
def test_invalid_configuration_is_an_error_not_safe(entries):
    assert evaluate("ordinary", entries).verdict == "error"
