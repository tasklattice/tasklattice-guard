"""Runtime dependency checks using a frozen config, without compilation."""
from dataclasses import replace

import pytest

from runner.toolkit.compiler.domain import PlanCompilationError
from runner.toolkit.evaluation.contracts import MODEL_SAFETY_CAPABILITY_BY_CONTRACT
from tests.data_plane.test_artifact_execution import _runtime


@pytest.mark.parametrize("contract", [*MODEL_SAFETY_CAPABILITY_BY_CONTRACT,
    "tali.guard.topic-control.semantic.v1", "tali.guard.company-policy.v1",
    "tali.guard.contextual-grounding.v1", "tali.guard.automated-reasoning.v1"])
async def test_runtime_checks_additional_declared_model_contract_without_action_binding(tmp_path, contract):
    store, registry, runtime = _runtime(tmp_path)
    try:
        guardrail_id, version = store.active_plan_keys()[0]
        config = store.nemo_config(guardrail_id, version)
        builder = registry._current.prepared.builder
        builder._validate_bindings(config)
        # This is an isolated manifest validation test, not a claim that a
        # modified unsigned fixture passes artifact signature verification.
        declared = replace(config, dependency_manifest=(
            *config.dependency_manifest, ("evaluation_contract", contract, "required"),
        ))
        with pytest.raises(PlanCompilationError, match=f"Declared.*{contract}"):
            builder._validate_bindings(declared)
        assert registry.readiness()["ready"]
    finally:
        await runtime.shutdown()


@pytest.mark.parametrize("configured_phase,required_phase", [("input", "output"), ("output", "input"), ("input", "input"), ("output", "output")])
async def test_artifact_binding_requires_its_exact_evaluator_direction(tmp_path, configured_phase, required_phase):
    from runner import generated as protocol
    from runner.providers import dynamic_runtime_action_providers

    configuration = protocol.DataPlaneModelConfiguration(
        runtimes=[protocol.ModelRuntime(id="direction-model", model="test-guard", profile_ref="tali.qwen3guard.v1",
            base_url="http://127.0.0.1:1/v1", timeout_seconds=5, max_tokens=128)],
        bindings=[protocol.CapabilityBinding(binding_id=f"content_safety.{configured_phase}", capability_ref="content_safety",
            rail_type=protocol.RAIL_TYPE_INPUT if configured_phase == "input" else protocol.RAIL_TYPE_OUTPUT,
            model_ref="direction-model", profile_ref="tali.qwen3guard.v1", contract_refs=["tali.guard.content-safety.v1"])])
    providers = dynamic_runtime_action_providers(configuration, {})
    store, registry, runtime = _runtime(tmp_path, providers=providers)
    try:
        config = store.nemo_config(*store.active_plan_keys()[0])
        binding = replace(config.action_bindings[0], capability="content_safety", contract_ref="tali.guard.content-safety.v1",
            action_name="GuardEvaluateAction", action_version="1.0.0", phases=(required_phase,))
        required = replace(config, action_bindings=(binding,))
        if configured_phase != required_phase:
            with pytest.raises(PlanCompilationError, match=f"No Evaluator Binding.*{required_phase}"):
                registry._current.prepared.builder._validate_bindings(required)
        else:
            registry._current.prepared.builder._validate_bindings(required)
    finally:
        await runtime.shutdown()
