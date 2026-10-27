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
from runner.toolkit.policy_runtime.domain import PolicyDetectorRef, PolicyImplementationRef, PolicyRuleSpec, PolicySpec
from runner.toolkit.safety.taxonomy import taxonomy_for_evaluator
from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext, RiskFinding


class RecordingSecrets:
    name = ACTION_SECRETS
    version = "1.0.0"
    capabilities = frozenset({"secrets"})
    rails = frozenset({"input", "output"})

    def __init__(self):
        self.calls = []
        self.contexts = []

    async def execute(self, request):
        self.calls.append((request.binding.id, request.content))
        self.contexts.append(request.context_messages)
        # Evaluators reading content blocks must see the same transformed text.
        assert request.content_view.active_block.text == request.content
        parameters = dict(request.parameters)
        if parameters["needle"] not in request.content:
            return action_result(request, "not_matched", request.content)
        return action_result(
            request, "matched",
            request.content.replace(parameters["needle"], parameters["replacement"]),
            findings=(RiskFinding(
                risk="secrets", taxonomy_id=taxonomy_for_evaluator("secrets"), verdict="matched",
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
            "parameters": [["policy_id", identity], ["needle", needle], ["replacement", replacement],
                           ["evaluation_view", "previous_output"], ["precedence", str(index)]],
            "trigger": {"type": "on_result", "step_ref": steps[index - 1][0], "verdicts": ["not_matched", "matched"]}
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
        ("z-first", "alpha", "[A]", "transform"),
        ("a-second", "alpha", "unused", "block"),
        ("m-third", "beta", "[B]", "transform"),
    ], phase=phase, programmable=programmable)
    assert result.decision == "transform"
    assert result.texts == ("[A] [B]",)
    assert calls == [("z-first", "alpha beta"), ("a-second", "[A] beta"), ("m-third", "[A] beta")]


@pytest.mark.parametrize("programmable", [False, True])
@pytest.mark.parametrize("phase", ["input", "output"])
@pytest.mark.parametrize("source", ["conversation", "retrieved_content"])
async def test_transformed_current_message_reaches_later_evaluators_without_original_duplicate(phase, programmable, source):
    from runner.toolkit.runtime.content_views import text_blocks

    role = "user" if phase == "input" else "assistant"
    history = ({"role": role, "content": "alpha beta"},
               {"role": "assistant" if phase == "input" else "user", "content": "Earlier follow-up."},
               {"role": role, "content": "alpha beta"})
    provider = RecordingSecrets()
    previews = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers(provider))
    steps = [("redact", "alpha", "[A]", "transform"), ("inspect", "missing", "unused", "allow")]
    try:
        result = await previews.evaluate(
            ProtectionRequest(phase=phase, texts=("alpha beta",), messages=history,
                content_blocks=text_blocks(phase, ("alpha beta",), source) if source != "conversation" else (),
                context=RequestContext(protocol="playground")),
            preview_id="context-order", guardrail_id="ordered", draft_revision=1,
            candidate_version="20260904-010000.001Z", plan=chain_plan(steps, phase, programmable), runtime_profile="auto",
        )
        assert result.decision == "transform", result.reason
        assert provider.calls[-1] == ("inspect", "[A] beta")
        # A separate retrieved input must not rewrite a coincidentally identical
        # conversation message. Output blocks always represent model output.
        expected = (*history[:-1], {"role": role, "content": "[A] beta"}) if source == "conversation" or phase == "output" else history
        assert provider.contexts[-1] == expected
        assert provider.contexts[0] == history
        assert history[-1]["content"] == "alpha beta"
    finally:
        await previews.shutdown()


@pytest.mark.parametrize("programmable", [False, True])
@pytest.mark.parametrize("phase", ["input", "output"])
async def test_reject_stops_before_any_later_policy_action(phase, programmable):
    result, calls = await run_chain([
        ("reject-first", "alpha", "unused", "block"),
        ("later-redact", "alpha", "[A]", "transform"),
    ], phase=phase, programmable=programmable)
    assert result.decision == "block"
    assert calls == [("reject-first", "alpha beta")]
    assert result.assessments[1].coverage.status == "none"


@pytest.mark.parametrize("programmable", [False, True])
async def test_pass_does_not_allow_globally_or_modify_downstream_input(programmable):
    result, calls = await run_chain([
        ("pass-first", "alpha", "[A]", "allow"),
        ("reject-next", "alpha", "unused", "block"),
    ], programmable=programmable)
    assert result.decision == "block"
    assert calls == [("pass-first", "alpha beta"), ("reject-next", "alpha beta")]


@pytest.mark.parametrize("programmable", [False, True])
async def test_combined_rail_attributes_each_action_to_its_own_policy(programmable):
    result, _ = await run_chain([
        ("safe-first", "missing", "unused", "block"),
        ("redact-next", "alpha", "[A]", "transform"),
        ("reject-last", "beta", "unused", "block"),
    ], programmable=programmable)
    trace = {step.id: step for step in result.trace}
    policies = {step.policy_id: step for step in result.trace if step.kind == "policy"}
    assert {key: step.status for key, step in policies.items()} == {
        "safe-first": "passed", "redact-next": "modified", "reject-last": "blocked"}
    for step in result.trace:
        if step.kind == "action":
            assert trace[step.parent_id].policy_id == step.policy_id
    assert result.assessments[0].status == "allow"


@pytest.mark.parametrize("phase", ["input", "output"])
@pytest.mark.parametrize("reject_at_end", [False, True])
async def test_large_standard_policy_chain_preserves_order_and_short_circuit(phase, reject_at_end):
    # Multiple individually configured input/output rails exhausted upstream
    # Colang 1's 300-event guard before an ordinary 32-Policy Default completed.
    # Exercise a larger chain through real NeMo, without changing that limit.
    middle = [(f"check-{index:02d}", "alpha", "unused", "block") for index in range(36)]
    steps = [
        ("z-mask-alpha", "alpha", "[A]", "transform"), *middle,
        ("b-mask-beta", "beta", "[B]", "transform"),
        ("end-check", "[B]" if reject_at_end else "missing", "unused", "block"),
        ("after-end", "missing", "unused", "allow"),
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


def ordering_policy():
    """A synthetic regex contract must not inherit evolving PII detector options."""
    return PolicySpec(id="ordering-fixture", name="Ordering", description="Synthetic ordering fixture",
        source="custom", version="1", tags=(), parameters=(), test_cases=(), rules=(PolicyRuleSpec(
            id="base", name="Base", description="", detector=PolicyDetectorRef("text/regex", "1.0.0"),
            effect="transform", rails=("input", "output"),
            implementation=PolicyImplementationRef("nemo-guardrails", "local", "ordering-fixture", "base", detector="regex"),
            taxonomy_ids=("TALI-BUSINESS-POLICY",), risk_severity="low", expression="alpha", redaction="[A]"),))


def test_local_rules_use_current_text_and_stop_on_reject():
    template = ordering_policy()
    rule = template.rules[0]
    first = replace(rule, id="z-first", expression="alpha", context_expression=None, effect="transform", redaction="[A]")
    second = replace(rule, id="a-second", expression="alpha", context_expression=None, effect="block")
    third = replace(rule, id="m-third", expression="beta", context_expression=None, effect="transform", redaction="[B]")
    definition = replace(template, id="ordered-rules", rules=(first, second, third))
    engine = content_filter.BuiltinContentFilter()
    result = engine.evaluate(definitions={definition.id: definition}, text="alpha beta", phase="input", policies=[definition.id])
    assert result.content == "[A] [B]"
    assert [f.rule_id for f in result.findings] == ["z-first", "m-third"]
    definition = replace(definition, rules=(second, first, third))
    result = engine.evaluate(definitions={definition.id: definition}, text="alpha beta", phase="input", policies=[definition.id])
    assert result.content == "alpha beta"
    assert [f.rule_id for f in result.findings] == ["a-second"]
    definition = replace(definition, rules=(replace(first, effect="transform"), second))
    result = engine.evaluate(definitions={definition.id: definition}, text="alpha beta", phase="input", policies=[definition.id])
    assert result.content == "[A] beta"
    assert [f.rule_id for f in result.findings] == ["z-first"]


def test_guardrail_rule_order_is_independent_of_enabled_membership_and_template():
    template = ordering_policy()
    base = template.rules[0]
    definition = replace(template, id="local-order", rules=(
        replace(base, id="transform", expression="alpha", context_expression=None, effect="transform", redaction="[A]"),
        replace(base, id="block", expression="alpha", context_expression=None, effect="block"),
        replace(base, id="tail", expression="beta", context_expression=None, effect="transform", redaction="[B]"),
    ))
    engine = content_filter.BuiltinContentFilter()
    args = dict(definitions={definition.id: definition}, text="alpha beta", phase="input", policies=[definition.id], enabled_rules={definition.id: ["block", "transform", "tail"]})
    assert engine.evaluate(**args).content == "[A] [B]"
    result = engine.evaluate(**args, rule_order={definition.id: ["block"]})
    assert [f.rule_id for f in result.findings] == ["block"]
    assert [r.id for r in definition.rules] == ["transform", "block", "tail"]
    for order in (["missing"], ["transform", "transform"]):
        assert engine.evaluate(**args, rule_order={definition.id: order}).verdict == "error"


@pytest.mark.parametrize("reject_custom", [False, True])
@pytest.mark.parametrize("local_order", [False, True])
async def test_custom_rules_interleave_with_builtin_policies_without_priority_sorting(reject_custom, local_order):
    provider = RecordingSecrets()
    plan = chain_plan([
        ("before", "alpha", "[A]", "transform"),
        ("after", "missing", "unused", "allow"),
    ], "input")
    plan["policy_bindings"] = [{
        "policy_id": identity, "policy_version": "1", "enabled_rails": ["input"],
        "enabled_rule_ids": ["flow/input/z_first", "flow/input/a_second"] if identity == "custom" else [],
        "rule_actions": [["flow/input/z_first", "block"]] if reject_custom and identity == "custom" else [],
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
            "on_unsafe": "transform", "priority": priority, "timeout_ms": 500,
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
@pytest.mark.parametrize("scope", ["interventions", "full"])
async def test_split_topic_rules_short_circuit_and_trace_their_own_identity(enabled, denied, expected, calls, scope):
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
            return action_result(request, "matched" if unsafe else "not_matched", request.content,
                findings=(RiskFinding(risk="topic_control", taxonomy_id=taxonomy_for_evaluator("topic_control"),
                    verdict="matched", confidence=1.0, evidence="Synthetic topic test", recommended_action="block"),) if unsafe else ())

    plan = chain_plan([(rule, "", "", "block") for rule in enabled], "input")
    for index, step in enumerate(plan["steps"]):
        step.update(capability="topic_control", contract_ref="tali.guard.topic-control.semantic.v1",
            parameters=[["evaluation_view", "original"], ["precedence", str(index)], ["policy_id", "builtin-topic-safety"], ["policy_version", "2.0.0"], ["rule_id", step["id"]]])
    plan["policy_bindings"] = [{"policy_id": "builtin-topic-safety", "policy_version": "2.0.0",
        "enabled_rule_ids": enabled, "enabled_rails": ["input"], "parameter_values": [], "rule_actions": []}]
    provider = RecordingTopic()
    previews = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers(provider))
    try:
        result = await previews.evaluate(
            ProtectionRequest(phase="input", texts=("Order support and fraud",), evidence_scope=scope, context=RequestContext(protocol="playground")),
            preview_id="split", guardrail_id="ordered", draft_revision=1, candidate_version="20260904-010000.001Z",
            plan=plan, runtime_profile="auto")
        assert not result.usage.fail_closed, result.reason
        assert result.decision == expected
        executed = enabled if scope == "full" else calls
        assert provider.calls == executed
        assert [step.id.removeprefix("nemo:action:") for step in result.trace if step.kind == "action"] == executed
        if denied and "topic/denylist" in enabled:
            assert any(finding.rule_id == "topic/denylist" for finding in result.findings)
            assert [item.fragment_id for item in result.interventions if item.kind == "block"] == ["nemo:topic/denylist:block"]
    finally:
        await previews.shutdown()


@pytest.mark.parametrize("programmable", [False, True])
async def test_transform_missing_result_fails_closed_in_real_nemo(programmable):
    provider = RecordingSecrets()
    previews = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers(provider))
    try:
        outcome = await previews.evaluate(
            ProtectionRequest(phase="input", texts=("alpha beta",), context=RequestContext(protocol="playground")),
            preview_id="missing-transform", guardrail_id="ordered", draft_revision=1,
            candidate_version="20260904-010000.001Z",
            plan=chain_plan([("missing-output", "alpha", "alpha", "transform")], "input", programmable), runtime_profile="auto")
        assert outcome.decision == outcome.action == "block"
        assert outcome.usage.fail_closed
        assert not outcome.texts
        assert any(step.status == "error" for step in outcome.trace)
    finally:
        await previews.shutdown()


@pytest.mark.parametrize("views", [[], [["evaluation_view", "unknown"]],
                                  [["evaluation_view", "original"], ["evaluation_view", "previous_output"]]])
def test_compilation_and_execution_reject_missing_or_ambiguous_views(views):
    from runner.serialization import plan_from_dict
    from runner.toolkit.compiler.nemo_compiler import NeMoConfigCompiler
    from runner.toolkit.compiler.domain import PlanCompilationError
    from runner.toolkit.nemo.runtime import NeMoActionBridge
    from runner.toolkit.runtime.contracts import NeMoActionBinding

    plan = chain_plan([("target", "alpha", "unused", "block")], "input")
    plan["steps"][0]["parameters"] = views
    with pytest.raises(PlanCompilationError, match="exactly one valid evaluation_view"):
        NeMoConfigCompiler().compile(plan_from_dict(plan))
    binding = NeMoActionBinding(id="target", capability="secrets", contract_ref="test",
                                phases=("input",), on_unsafe="block", parameters=tuple(map(tuple, views)))
    with pytest.raises(ValueError, match="exactly one valid evaluation_view"):
        NeMoActionBridge._declared_view(binding)


@pytest.mark.parametrize("positions", [[], ["-1"], ["1.5"], ["NaN"], [""], [" 1"], ["+1"], ["01"], ["１"], ["0", "1"]])
def test_compiler_rejects_missing_or_invalid_precedence(positions):
    from runner.serialization import plan_from_dict
    from runner.toolkit.compiler.nemo_compiler import NeMoConfigCompiler
    from runner.toolkit.compiler.domain import PlanCompilationError

    plan = chain_plan([("target", "alpha", "unused", "block")], "input")
    parameters = plan["steps"][0]["parameters"]
    plan["steps"][0]["parameters"] = [entry for entry in parameters if entry[0] != "precedence"] + [
        ["precedence", value] for value in positions]
    with pytest.raises(PlanCompilationError, match="exactly one non-negative integer precedence"):
        NeMoConfigCompiler().compile(plan_from_dict(plan))


def test_precedence_is_unique_but_not_derived_from_execution_order():
    from runner.serialization import plan_from_dict
    from runner.toolkit.compiler.nemo_compiler import NeMoConfigCompiler
    from runner.toolkit.compiler.domain import PlanCompilationError

    plan = chain_plan([("first", "alpha", "unused", "block"), ("second", "beta", "unused", "allow")], "input")
    for step, position in zip(plan["steps"], ["7", "3"]):
        step["parameters"] = [entry for entry in step["parameters"] if entry[0] != "precedence"] + [["precedence", position]]
    snapshot = NeMoConfigCompiler().compile(plan_from_dict(plan))
    assert [dict(item.parameters)["precedence"] for item in snapshot.action_bindings] == ["7", "3"]
    plan["steps"][1]["parameters"][-1][1] = "7"
    with pytest.raises(PlanCompilationError, match="precedence values must be unique"):
        NeMoConfigCompiler().compile(plan_from_dict(plan))
