from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from runner import generated as protocol
from runner.compiler import DefaultRunnerCompiler
from runner.protocol_codec import action_bindings_from_proto, plan_from_proto, plan_to_proto
from runner.toolkit.nemo.actions.names import ACTION_EVALUATE
from runner.toolkit.evaluation.contracts import CONTRACT_CONTENT_SAFETY


ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize("mode", ["window_buffered", "interruptible"])
@pytest.mark.parametrize("selection", ["input_rail", "input_rule", "output_rule"])
def test_custom_full_response_requirement_applies_only_to_enabled_output(mode, selection):
    from runner.toolkit.compiler.nemo_compiler import PlanCompilationError

    plan = {
        "guardrail_id": "selected-output", "guardrail_version": "20260904-010000.001Z",
        "compiler_version": "test", "safety_level": "balanced", "output_delivery": mode,
        "steps": [], "modules": [],
        "policy_versions": [{
            "policy_id": "custom", "version": "1", "name": "Custom", "source": "custom",
            "colang_version": "2.x", "checksum": "test",
            "sources": [{"path": "main.co", "content": "\n".join(
                f'flow check_{rail} $text\n  $r = await GuardRecordPolicyAction(flow_name="check_{rail}", safe=True, text=$text)\n'
                for rail in ("input", "output"))}],
            "rail_bindings": [{"rail_type": rail, "flow_name": f"check_{rail}",
                "execution_mode": "detect", "on_unsafe": "block"} for rail in ("input", "output")],
            "action_references": [{"name": "GuardRecordPolicyAction", "version": "1.0.0"}],
            "execution_contract": [["output_delivery", "full_buffered"]],
        }],
        "policy_bindings": [{"policy_id": "custom", "policy_version": "1",
            "enabled_rails": ["input"] if selection == "input_rail" else ["input", "output"],
            "enabled_rule_ids": ["flow/input/check_input"] if selection == "input_rule"
                else ["flow/output/check_output"] if selection == "output_rule" else [],
        }],
    }
    request = protocol.CompileRequest(compile_id="selected-output", guardrail_id=plan["guardrail_id"],
        guardrail_version=plan["guardrail_version"], generation=1, plan=plan_to_proto(plan), runtime_profile="auto")
    if selection == "output_rule":
        with pytest.raises(PlanCompilationError, match="requires full-buffered output"):
            DefaultRunnerCompiler().compile(request)
    else:
        artifact = DefaultRunnerCompiler().compile(request)
        assert plan_from_proto(artifact.plan)["output_delivery"] == mode
        assert [binding["phases"] for binding in action_bindings_from_proto(artifact.action_bindings)] == [["input"]]


@pytest.mark.parametrize("safety_level", ["balanced", "strict"])
@pytest.mark.parametrize(
    "output_delivery",
    ["interruptible", "window_buffered", "full_buffered"],
)
def test_control_plane_flags_compile_into_the_signed_artifact_contract(
    safety_level: str,
    output_delivery: str,
) -> None:
    artifact = _compile(
        safety_level=safety_level,
        output_delivery=output_delivery,
        phases=["input", "output"],
        on_unsafe="block",
    )

    plan = plan_from_proto(artifact.plan)
    bindings = action_bindings_from_proto(artifact.action_bindings)
    assert plan["safety_level"] == safety_level
    assert plan["output_delivery"] == output_delivery
    assert plan["steps"][0]["phases"] == ["input", "output"]
    assert artifact.runtime_profile in {
        "iorails_native",
        "llmrails_colang1_standard",
        "llmrails_colang2_programmable",
    }
    assert artifact.config_yaml
    assert artifact.checksum
    assert len(bindings) == 1
    assert bindings[0]["capability"] == "secrets"
    assert bindings[0]["on_unsafe"] == "block"


@pytest.mark.parametrize(
    ("phases", "on_unsafe"),
    [
        (["input"], "block"),
        (["output"], "transform"),
        (["input", "output"], "transform"),
    ],
)
def test_rail_and_enforcement_flags_survive_compilation(
    phases: list[str],
    on_unsafe: str,
) -> None:
    artifact = _compile(
        safety_level="balanced",
        output_delivery="full_buffered",
        phases=phases,
        on_unsafe=on_unsafe,
    )
    binding = action_bindings_from_proto(artifact.action_bindings)[0]

    assert binding["phases"] == phases
    assert binding["on_unsafe"] == on_unsafe
    assert binding["failure_mode"] == "fail_closed"
    assert binding["timeout_ms"] == 750


def test_checked_in_runner_fixture_is_the_current_compiler_output() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/generate_test_artifacts.py", "--check"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stdout + result.stderr


def test_model_capability_compiles_to_a_provider_agnostic_action_binding() -> None:
    plan = {
        "guardrail_id": "model-contract",
        "guardrail_version": "20260904-010000.001Z",
        "compiler_version": "tasklattice-controller-plan-v3",
        "safety_level": "balanced",
        "output_delivery": "full_buffered",
        "steps": [{
            "id": "content-safety:primary",
            "capability": "content_safety",
            "contract_ref": CONTRACT_CONTENT_SAFETY,
            "phases": ["input"],
            "on_unsafe": "block",
            "trigger": {"type": "always", "verdicts": []},
            "parameters": [],
        }],
        "modules": [{
            "id": "interaction_safety:input",
            "module": "interaction_safety",
            "phase": "input",
            "step_ids": ["content-safety:primary"],
            "depends_on": [],
            "input_view": "original",
            "required_for_release": True,
            "timeout_ms": 30_000,
            "failure_mode": "fail_closed",
        }],
        "reasoning_policies": [],
        "policy_versions": [],
        "policy_bindings": [],
    }
    artifact = DefaultRunnerCompiler().compile(protocol.CompileRequest(
        compile_id="model-provider-agnostic",
        guardrail_id="model-contract",
        guardrail_version="20260904-010000.001Z",
        generation=1,
        plan=plan_to_proto(plan),
        runtime_profile="auto",
    ))
    binding = action_bindings_from_proto(artifact.action_bindings)[0]

    assert binding["action_name"] == ACTION_EVALUATE
    assert binding["timeout_ms"] == 30_000
    assert "Qwen" not in artifact.config_yaml
    assert "Llama" not in artifact.config_yaml


def _compile(
    *,
    safety_level: str,
    output_delivery: str,
    phases: list[str],
    on_unsafe: str,
) -> protocol.Artifact:
    plan = {
        "guardrail_id": "flag-contract",
        "guardrail_version": "20260904-010000.001Z",
        "compiler_version": "tasklattice-controller-plan-v3",
        "safety_level": safety_level,
        "output_delivery": output_delivery,
        "steps": [{
            "id": "secrets:exact",
            "capability": "secrets",
            "contract_ref": "tali.guard.secrets.exact.v1",
            "phases": phases,
            "on_unsafe": on_unsafe,
            "trigger": {"type": "always", "verdicts": []},
            "parameters": [],
        }],
        "modules": [
            {
                "id": f"data_protection:{phase}",
                "module": "data_protection",
                "phase": phase,
                "step_ids": ["secrets:exact"],
                "depends_on": [],
                "input_view": "original",
                "required_for_release": True,
                "timeout_ms": 750,
                "failure_mode": "fail_closed",
            }
            for phase in phases
        ],
        "reasoning_policies": [],
        "policy_versions": [],
        "policy_bindings": [],
    }
    return DefaultRunnerCompiler().compile(protocol.CompileRequest(
        compile_id=f"flags-{safety_level}-{output_delivery}",
        guardrail_id="flag-contract",
        guardrail_version="20260904-010000.001Z",
        generation=1,
        plan=plan_to_proto(plan),
        runtime_profile="auto",
    ))
