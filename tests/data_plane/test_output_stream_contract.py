"""Delivery is derived from enabled, version-pinned execution, not library metadata.

These pure data-plane contract checks neither compile nor mock a model verdict.
Actual NeMo/stream release tests live in test_output_streaming.py.
"""
from dataclasses import replace

import pytest

from runner.toolkit.runtime.contracts import (
    GuardrailPlanSnapshot, GuardrailPlanStep, GuardrailPolicyBindingSnapshot,
    PolicyRailBindingSnapshot, PolicyVersionSnapshot,
)
from runner.toolkit.runtime.streaming import output_stream_contract


def version(source="built-in", number="1", execution_contract=()):
    return PolicyVersionSnapshot(
        policy_id="policy-safety", version=number, name="Safety", source=source,
        colang_version="2.x", sources=(), parameter_schema=(),
        rail_bindings=tuple(PolicyRailBindingSnapshot(
            rail_type=rail, flow_name=f"check_{rail}", execution_mode="detect", on_unsafe="block",
        ) for rail in ("input", "output")),
        action_references=(), evaluation_contracts=(), prompt_dependencies=(),
        execution_contract=execution_contract, test_cases=(), checksum=f"checksum-{number}",
    )


def plan(mode="window_buffered", source="built-in"):
    return GuardrailPlanSnapshot(
        guardrail_id="stream-contract", guardrail_version="1", compiler_version="test",
        safety_level="balanced", output_delivery=mode,
        steps=(GuardrailPlanStep(id="safety", capability="content_safety",
            contract_ref="tali.guard.content_safety.nvidia.v1", phases=("output",), on_unsafe="block"),),
        policy_versions=(version(source),),
        policy_bindings=(GuardrailPolicyBindingSnapshot(policy_id="policy-safety", policy_version="1",
            enabled_rails=("input", "output")),),
    )


@pytest.mark.parametrize("mode", ["window_buffered", "interruptible", "full_buffered"])
@pytest.mark.parametrize("action", ["block", "report", "allow"])
def test_native_safety_policy_snapshot_does_not_invent_a_custom_output_flow(mode, action):
    candidate = plan(mode)
    candidate = replace(candidate, steps=(replace(candidate.steps[0], on_unsafe=action),))
    result = output_stream_contract(candidate)
    assert result.requested_mode == mode
    assert result.effective_mode == ("full_buffered" if mode == "full_buffered" else "window_buffered")


@pytest.mark.parametrize("mode", ["window_buffered", "interruptible"])
@pytest.mark.parametrize("selection", ["all", "output_rule"])
def test_active_custom_output_always_requires_complete_response(mode, selection):
    candidate = plan(mode, "custom")
    if selection == "output_rule":
        candidate = replace(candidate, policy_bindings=(replace(candidate.policy_bindings[0],
            enabled_rule_ids=("flow/output/check_output",)),))
    assert output_stream_contract(candidate).effective_mode == "full_buffered"


@pytest.mark.parametrize("mode", ["window_buffered", "interruptible"])
@pytest.mark.parametrize("selection", ["input_only", "input_rule_only", "unselected_version", "unselected_policy"])
def test_unused_custom_output_does_not_override_the_selected_execution(mode, selection):
    candidate = plan(mode, "custom")
    selected = candidate.policy_bindings[0]
    if selection == "input_only":
        candidate = replace(candidate, policy_bindings=(replace(selected, enabled_rails=("input",)),))
    elif selection == "input_rule_only":
        candidate = replace(candidate, policy_bindings=(replace(selected,
            enabled_rule_ids=("flow/input/check_input",)),))
    elif selection == "unselected_version":
        candidate = replace(candidate, policy_versions=(version("built-in"), version("custom", "2")))
    else:
        candidate = replace(candidate, policy_bindings=())
    assert output_stream_contract(candidate).effective_mode == ("full_buffered" if mode == "full_buffered" else "window_buffered")


@pytest.mark.parametrize("mode", ["window_buffered", "interruptible"])
@pytest.mark.parametrize("capability,action", [
    ("pii", "transform"), ("content_filter", "block"), ("grounding", "block"),
    ("content_safety", "transform"), ("unknown_future_detector", "block"),
])
def test_complete_response_and_unknown_steps_cannot_use_incremental_delivery(mode, capability, action):
    candidate = plan(mode)
    candidate = replace(candidate, steps=(replace(candidate.steps[0], capability=capability, on_unsafe=action),))
    assert output_stream_contract(candidate).effective_mode == "full_buffered"


@pytest.mark.parametrize("mode", ["window_buffered", "interruptible"])
def test_explicit_selected_policy_complete_response_requirement_is_preserved(mode):
    candidate = replace(plan(mode), policy_versions=(version(execution_contract=(("output_delivery", "full_buffered"),)),))
    assert output_stream_contract(candidate).effective_mode == "full_buffered"


@pytest.mark.parametrize("mode", ["window_buffered", "interruptible"])
def test_input_only_complete_response_metadata_does_not_constrain_output(mode):
    candidate = plan(mode)
    candidate = replace(candidate,
        policy_versions=(version(execution_contract=(("output_delivery", "full_buffered"),)),),
        policy_bindings=(replace(candidate.policy_bindings[0], enabled_rails=("input",)),))
    assert output_stream_contract(candidate).effective_mode == ("full_buffered" if mode == "full_buffered" else "window_buffered")
