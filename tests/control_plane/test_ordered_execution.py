from __future__ import annotations

from dataclasses import replace

import pytest

from runner.compiler import DefaultRunnerCompiler
from runner.draft_preview import DraftPreviewRuntime
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.actions.contracts import action_result
from runner.toolkit.nemo.actions.names import ACTION_SECRETS
from runner.toolkit.nemo.actions import content_filter
from runner.toolkit.policy_library import policy
from runner.toolkit.safety.taxonomy import taxonomy_for_evaluator
from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext, RiskFinding
from runner.toolkit.runtime.interventions import fallback_content


class RecordingSecrets:
    name = ACTION_SECRETS
    version = "1.0.0"
    capabilities = frozenset({"secrets"})
    rails = frozenset({"input", "output"})

    def __init__(self):
        self.calls = []

    async def execute(self, request):
        self.calls.append((request.binding.id, request.content))
        # Evaluators reading content blocks must see the same transformed text.
        assert request.content_view.active_block.text == request.content
        parameters = dict(request.parameters)
        if parameters["needle"] not in request.content:
            return action_result(request, "safe", request.content)
        return action_result(
            request, "unsafe",
            request.content.replace(parameters["needle"], parameters["replacement"]),
            findings=(RiskFinding(
                risk="secrets", taxonomy_id=taxonomy_for_evaluator("secrets"), verdict="unsafe",
                confidence=1.0, evidence="Synthetic ordered-execution fixture.",
                recommended_action=request.proposed_action,
            ),),
        )


def chain_plan(steps, phase, programmable=False):
    compiled = []
    for index, (identity, needle, replacement, action) in enumerate(steps):
        compiled.append({
            "id": identity, "capability": "secrets",
            "contract_ref": "tali.guard.secrets.exact.v1", "phases": [phase],
            "on_unsafe": action,
            "parameters": [["policy_id", identity], ["needle", needle], ["replacement", replacement]],
            "trigger": {"type": "on_result", "step_ref": steps[index - 1][0], "verdicts": ["safe", "unsafe"]}
            if programmable and index else {"type": "always"},
        })
    return {
        "guardrail_id": "ordered", "guardrail_version": "20260904-010000.001Z",
        "compiler_version": "test-ordered", "safety_level": "balanced",
        "output_delivery": "full_buffered", "steps": compiled,
        "modules": [{
            "id": identity, "module": "data_protection", "phase": phase,
            "step_ids": [identity], "depends_on": [], "input_view": "previous_output",
            "required_for_release": True, "timeout_ms": 500, "failure_mode": "fail_closed",
        } for identity, *_ in steps],
        "policy_bindings": [], "policy_versions": [], "reasoning_policies": [],
    }


async def run_chain(steps, *, phase="input", programmable=False):
    provider = RecordingSecrets()
    previews = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers(provider))
    try:
        result = await previews.evaluate(
            ProtectionRequest(phase=phase, texts=("alpha beta",), context=RequestContext(protocol="playground")),
            preview_id="ordered", guardrail_id="ordered", draft_revision=1, candidate_version="20260904-010000.001Z",
            plan=chain_plan(steps, phase, programmable), runtime_profile="auto",
        )
        assert not result.usage.fail_closed, result.reason
        assert result.usage.runtime_profile == (
            "llmrails_colang2_programmable" if programmable else "llmrails_colang1_standard"
        )
        return result, provider.calls
    finally:
        await previews.shutdown()


@pytest.mark.parametrize("programmable", [False, True])
@pytest.mark.parametrize("phase", ["input", "output"])
async def test_modifications_are_threaded_and_order_is_not_sorted_by_id(phase, programmable):
    result, calls = await run_chain([
        ("z-first", "alpha", "[A]", "redact"),
        ("a-second", "alpha", "unused", "reject"),
        ("m-third", "beta", "[B]", "redact"),
    ], phase=phase, programmable=programmable)
    assert result.decision == "transform"
    assert result.texts == ("[A] [B]",)
    assert calls == [("z-first", "alpha beta"), ("a-second", "[A] beta"), ("m-third", "[A] beta")]


@pytest.mark.parametrize("programmable", [False, True])
@pytest.mark.parametrize("phase", ["input", "output"])
async def test_reject_stops_before_any_later_policy_action(phase, programmable):
    result, calls = await run_chain([
        ("reject-first", "alpha", "unused", "reject"),
        ("later-redact", "alpha", "[A]", "redact"),
    ], phase=phase, programmable=programmable)
    assert result.decision == "block"
    assert calls == [("reject-first", "alpha beta")]
    assert result.assessments[1].coverage.status == "none"


@pytest.mark.parametrize("programmable", [False, True])
async def test_pass_does_not_allow_globally_or_modify_downstream_input(programmable):
    result, calls = await run_chain([
        ("pass-first", "alpha", "[A]", "pass"),
        ("reject-next", "alpha", "unused", "reject"),
    ], programmable=programmable)
    assert result.decision == "block"
    assert calls == [("pass-first", "alpha beta"), ("reject-next", "alpha beta")]


@pytest.mark.parametrize("phase", ["input", "output"])
@pytest.mark.parametrize("reject_at_end", [False, True])
async def test_large_standard_policy_chain_preserves_order_and_short_circuit(phase, reject_at_end):
    # Multiple individually configured input/output rails exhausted upstream
    # Colang 1's 300-event guard before an ordinary 32-Policy Default completed.
    # Exercise a larger chain through real NeMo, without changing that limit.
    middle = [(f"check-{index:02d}", "alpha", "unused", "reject") for index in range(36)]
    steps = [
        ("z-mask-alpha", "alpha", "[A]", "redact"), *middle,
        ("b-mask-beta", "beta", "[B]", "redact"),
        ("end-check", "[B]" if reject_at_end else "missing", "unused", "reject"),
        ("after-end", "missing", "unused", "pass"),
    ]
    result, calls = await run_chain(steps, phase=phase)
    assert result.decision == ("block" if reject_at_end else "transform")
    if not reject_at_end:
        assert result.texts == ("[A] [B]",)
    expected = [("z-mask-alpha", "alpha beta"), *[(identity, "[A] beta") for identity, *_ in middle],
                ("b-mask-beta", "[A] beta"), ("end-check", "[A] [B]")]
    if not reject_at_end:
        expected.append(("after-end", "[A] [B]"))
    assert calls == expected
    assert [step.policy_id for step in result.trace if step.kind == "action"] == [identity for identity, _ in expected]


def test_local_rules_use_current_text_and_stop_on_reject(monkeypatch):
    template = policy("pattern-matching")
    rule = template.rules[0]
    first = replace(rule, id="z-first", expression="alpha", context_expression=None, effect="redact", redaction="[A]")
    second = replace(rule, id="a-second", expression="alpha", context_expression=None, effect="reject")
    third = replace(rule, id="m-third", expression="beta", context_expression=None, effect="redact", redaction="[B]")
    definition = replace(template, id="ordered-rules", rules=(first, second, third))
    monkeypatch.setattr(content_filter, "policy", lambda name: definition)
    engine = content_filter.BuiltinContentFilter()
    result = engine.evaluate(text="alpha beta", phase="input", policies=[definition.id])
    assert result.content == "[A] [B]"
    assert [f.rule_id for f in result.findings] == ["z-first", "m-third"]
    definition = replace(definition, rules=(second, first, third))
    result = engine.evaluate(text="alpha beta", phase="input", policies=[definition.id])
    assert result.content == "alpha beta"
    assert [f.rule_id for f in result.findings] == ["a-second"]
    definition = replace(definition, rules=(replace(first, effect="rewrite"), second))
    result = engine.evaluate(text="alpha beta", phase="input", policies=[definition.id])
    assert result.content == fallback_content("rewrite", "alpha beta")
    assert [f.rule_id for f in result.findings] == ["z-first"]


def test_guardrail_rule_order_is_independent_of_enabled_membership_and_template(monkeypatch):
    template = policy("pattern-matching")
    base = template.rules[0]
    definition = replace(template, id="local-order", rules=(
        replace(base, id="redact", expression="alpha", context_expression=None, effect="redact", redaction="[A]"),
        replace(base, id="reject", expression="alpha", context_expression=None, effect="reject"),
        replace(base, id="tail", expression="beta", context_expression=None, effect="redact", redaction="[B]"),
    ))
    monkeypatch.setattr(content_filter, "policy", lambda name: definition)
    engine = content_filter.BuiltinContentFilter()
    args = dict(text="alpha beta", phase="input", policies=[definition.id], enabled_rules={definition.id: ["reject", "redact", "tail"]})
    assert engine.evaluate(**args).content == "[A] [B]"
    result = engine.evaluate(**args, rule_order={definition.id: ["reject"]})
    assert [f.rule_id for f in result.findings] == ["reject"]
    assert [r.id for r in definition.rules] == ["redact", "reject", "tail"]
    for order in (["missing"], ["redact", "redact"]):
        assert engine.evaluate(**args, rule_order={definition.id: order}).verdict == "error"


@pytest.mark.parametrize("reject_custom", [False, True])
@pytest.mark.parametrize("local_order", [False, True])
async def test_custom_rules_interleave_with_builtin_policies_without_priority_sorting(reject_custom, local_order):
    provider = RecordingSecrets()
    plan = chain_plan([
        ("before", "alpha", "[A]", "redact"),
        ("after", "missing", "unused", "pass"),
    ], "input")
    plan["policy_bindings"] = [{
        "policy_id": identity, "policy_version": "1", "enabled_rails": ["input"],
        "enabled_rule_ids": ["flow/input/z_first", "flow/input/a_second"] if identity == "custom" else [],
        "rule_actions": [["flow/input/z_first", "reject"]] if reject_custom and identity == "custom" else [],
    } for identity in ("before", "custom", "after")]
    plan["policy_versions"] = [{
        "policy_id": "custom", "version": "1", "name": "Ordered custom", "source": "custom",
        "colang_version": "2.x", "checksum": "test-custom",
        "sources": [{"path": "main.co", "content": '''flow z_first $text
  if $text == "[A] beta"
    $r = await GuardRecordPolicyAction(flow_name="z_first", safe=False, text=$text, replacement="CUSTOM beta")
  else
    $r = await GuardRecordPolicyAction(flow_name="z_first", safe=False, text=$text, replacement="WRONG ORDER")

flow a_second $text
  if $text == "CUSTOM beta"
    $r = await GuardRecordPolicyAction(flow_name="a_second", safe=False, text=$text, replacement="CUSTOM [B]")
  else
    $r = await GuardRecordPolicyAction(flow_name="a_second", safe=False, text=$text, replacement="WRONG ORDER")
'''}],
        "rail_bindings": [{
            "rail_type": "input", "flow_name": name, "execution_mode": "mutate",
            "on_unsafe": "redact", "priority": priority, "timeout_ms": 500,
            "failure_mode": "fail_closed", "required": True, "depends_on": [],
        } for name, priority in (("z_first", 100), ("a_second", 1))],
        "action_references": [{"name": "GuardRecordPolicyAction", "version": "1.0.0"}],
    }]
    if local_order:
        # The Guardrail overlay reverses an independently authored template.
        # Membership order is deliberately different from execution order.
        plan["policy_versions"][0]["rail_bindings"].reverse()
        selected = plan["policy_bindings"][1]
        selected["enabled_rule_ids"].reverse()
        selected["rule_order"] = ["flow/input/z_first", "flow/input/a_second"]
    previews = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers(provider))
    try:
        result = await previews.evaluate(
            ProtectionRequest(phase="input", texts=("alpha beta",), context=RequestContext(protocol="playground")),
            preview_id="custom", guardrail_id="ordered", draft_revision=1, candidate_version="20260904-010000.001Z",
            plan=plan, runtime_profile="auto",
        )
        assert not result.usage.fail_closed, result.reason
        if reject_custom:
            assert result.decision == "block"
            assert provider.calls == [("before", "alpha beta")]
            assert "flow/input/a_second" not in {finding.rule_id for finding in result.findings}
        else:
            assert result.decision == "transform"
            assert result.texts == ("CUSTOM [B]",)
            assert provider.calls == [("before", "alpha beta"), ("after", "CUSTOM [B]")]
    finally:
        await previews.shutdown()


@pytest.mark.parametrize("enabled,denied,expected,calls", [
    (["topic/denylist", "topic/allowlist"], True, "block", ["topic/denylist"]),
    (["topic/denylist", "topic/allowlist"], False, "allow", ["topic/denylist", "topic/allowlist"]),
    (["topic/allowlist"], True, "allow", ["topic/allowlist"]),
    (["topic/denylist"], False, "allow", ["topic/denylist"]),
])
async def test_split_topic_rules_short_circuit_and_trace_their_own_identity(enabled, denied, expected, calls):
    from runner.toolkit.nemo.actions.names import ACTION_TOPIC_JUDGE

    class RecordingTopic:
        name = ACTION_TOPIC_JUDGE
        version = "1.0.0"
        capabilities = frozenset({"topic_control"})
        rails = frozenset({"input"})

        def __init__(self):
            self.calls = []

        async def execute(self, request):
            rule = dict(request.parameters)["rule_id"]
            self.calls.append(rule)
            unsafe = denied and rule == "topic/denylist"
            return action_result(request, "unsafe" if unsafe else "safe", request.content,
                findings=(RiskFinding(risk="topic_control", taxonomy_id=taxonomy_for_evaluator("topic_control"),
                    verdict="unsafe", confidence=1.0, evidence="Synthetic topic test", recommended_action="reject"),) if unsafe else ())

    plan = chain_plan([(rule, "", "", "reject") for rule in enabled], "input")
    for step in plan["steps"]:
        step.update(capability="topic_control", contract_ref="tali.guard.topic-control.semantic.v1",
            parameters=[["policy_id", "builtin-topic-safety"], ["policy_version", "2.0.0"], ["rule_id", step["id"]]])
    plan["policy_bindings"] = [{"policy_id": "builtin-topic-safety", "policy_version": "2.0.0",
        "enabled_rule_ids": enabled, "enabled_rails": ["input"], "parameter_values": [], "rule_actions": []}]
    provider = RecordingTopic()
    previews = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers(provider))
    try:
        result = await previews.evaluate(
            ProtectionRequest(phase="input", texts=("Order support and fraud",), context=RequestContext(protocol="playground")),
            preview_id="split", guardrail_id="ordered", draft_revision=1, candidate_version="20260904-010000.001Z",
            plan=plan, runtime_profile="auto")
        assert not result.usage.fail_closed, result.reason
        assert result.decision == expected
        assert provider.calls == calls
        assert [step.id.removeprefix("nemo:action:") for step in result.trace if step.kind == "action"] == calls
        if denied and "topic/denylist" in enabled:
            assert any(finding.rule_id == "topic/denylist" for finding in result.findings)
    finally:
        await previews.shutdown()
