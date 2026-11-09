"""Declared model dependencies cannot hide behind a passing custom-flow branch."""
import pytest

from runner import generated as protocol
from runner.compiler import DefaultRunnerCompiler
from runner.protocol_codec import plan_to_proto, validation_test_to_proto
from runner.validator import DefaultRunnerValidator
from runner.toolkit.compiler.domain import PlanCompilationError
from runner.toolkit.evaluation.contracts import MODEL_SAFETY_CAPABILITY_BY_CONTRACT
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.actions import EvaluationActionProvider, EvaluationRoute, local_action_providers
from tests.control_plane.test_custom_policy_dependencies import custom_plan


@pytest.mark.parametrize("selected", [False, True])
async def test_unselected_model_policy_does_not_block_local_guardrail(selected):
    from copy import deepcopy

    plan = custom_plan('flow check $text\n  await GuardRecordPolicyAction(flow_name="check", safe=True, text=$text)\n',
        ["GuardRecordPolicyAction"])
    remote = deepcopy(plan["policy_versions"][0])
    remote.update(policy_id="optional-remote", evaluation_contracts=["tali.guard.content-safety.v1"])
    plan["policy_versions"].append(remote)
    if selected:
        plan["policy_bindings"].append({"policy_id": "optional-remote", "policy_version": "1", "enabled_rails": ["input"]})
    validator = DefaultRunnerValidator(DefaultRunnerCompiler())
    request = protocol.ValidationRequest(run_id="optional-dependency", guardrail_id=plan["guardrail_id"],
        candidate_version=plan["guardrail_version"], source_draft_revision=1, plan=plan_to_proto(plan), runtime_profile="auto",
        test_cases=[validation_test_to_proto({"id": "benign", "name": "Benign", "phase": "input",
            "content": "ordinary", "expectedDecision": "allow", "required": True})])
    if selected:
        with pytest.raises(PlanCompilationError, match="Declared.*content-safety"):
            await validator.validate(request)
    else:
        status, _, results = await validator.validate(request)
        assert status == "passed", results
        assert results[0]["modelInvocations"] == 0


@pytest.mark.parametrize("phase", ["input", "output"])
@pytest.mark.parametrize("contract", list(MODEL_SAFETY_CAPABILITY_BY_CONTRACT))
@pytest.mark.parametrize("available", [False, True])
async def test_declared_model_dependency_is_required_even_when_test_branch_does_not_call_it(phase, contract, available):
    plan = custom_plan('flow check $text\n  await GuardRecordPolicyAction(flow_name="check", safe=True, text=$text)\n',
        ["GuardRecordPolicyAction"])
    version = plan["policy_versions"][0]
    version["rail_bindings"][0]["rail_type"] = phase
    # The model contract is secondary: checking only the binding's first
    # evaluation contract would still miss it.
    version["evaluation_contracts"] = ["tali.guard.pii.exact.v1", contract]
    plan["policy_bindings"][0]["enabled_rails"] = [phase]
    class UnusedEvaluator:
        id = "declared-test-evaluator"
        capabilities = frozenset({MODEL_SAFETY_CAPABILITY_BY_CONTRACT[contract]})
        contracts = frozenset({contract})
        rails = frozenset({"input", "output"})

        async def evaluate(self, _request):
            raise AssertionError("This branch must not call the evaluator.")

    providers = action_providers(*local_action_providers(), EvaluationActionProvider((
        EvaluationRoute(MODEL_SAFETY_CAPABILITY_BY_CONTRACT[contract], contract, UnusedEvaluator()),
    ))) if available else None
    request = protocol.ValidationRequest(
        run_id="declared-model", guardrail_id=plan["guardrail_id"], candidate_version=plan["guardrail_version"],
        source_draft_revision=1, plan=plan_to_proto(plan), runtime_profile="auto",
        test_cases=[validation_test_to_proto({"id": "benign", "name": "Benign branch", "phase": phase,
            "content": "ordinary", "expectedDecision": "allow", "required": True})])
    validator = DefaultRunnerValidator(DefaultRunnerCompiler(), providers)
    if not available:
        with pytest.raises(PlanCompilationError, match=f"Declared model Evaluator Bindings.*{contract}"):
            await validator.validate(request)
        return
    status, _, results = await validator.validate(request)
    assert status == "passed", results
    assert results[0]["modelInvocations"] == 0


@pytest.mark.parametrize("contract,capability,action,phase", [
    ("tali.guard.topic-control.semantic.v1", "topic_control", "GuardTopicJudgeAction", "input"),
    ("tali.guard.topic-control.semantic.v1", "topic_control", "GuardTopicJudgeAction", "output"),
    ("tali.guard.contextual-grounding.v1", "contextual_grounding", "GuardGroundingAction", "output"),
    ("tali.guard.automated-reasoning.v1", "automated_reasoning", "GuardReasoningAction", "output"),
])
@pytest.mark.parametrize("provider_state", ["missing", "ready", "wrong-capability", "wrong-version"])
async def test_declared_dedicated_model_dependency(contract, capability, action, phase, provider_state):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    plan = custom_plan('flow check $text\n  await GuardRecordPolicyAction(flow_name="check", safe=True, text=$text)\n',
        ["GuardRecordPolicyAction"])
    plan["policy_versions"][0]["rail_bindings"][0]["rail_type"] = phase
    plan["policy_versions"][0]["evaluation_contracts"] = ["tali.guard.pii.exact.v1", contract]
    plan["policy_bindings"][0]["enabled_rails"] = [phase]
    execute = AsyncMock(side_effect=AssertionError("Unrelated branch must not execute a model"))
    provider = SimpleNamespace(name=action, version="2.0.0" if provider_state == "wrong-version" else "1.0.0",
        capabilities=frozenset({"unrelated" if provider_state == "wrong-capability" else capability}),
        rails=frozenset({phase}), execute=execute)
    providers = action_providers(*local_action_providers(), provider) if provider_state != "missing" else None
    validator = DefaultRunnerValidator(DefaultRunnerCompiler(), providers)
    request = protocol.ValidationRequest(run_id="declared-dedicated", guardrail_id=plan["guardrail_id"],
        candidate_version=plan["guardrail_version"], source_draft_revision=1, plan=plan_to_proto(plan), runtime_profile="auto",
        test_cases=[validation_test_to_proto({"id": "benign", "name": "Benign", "phase": phase,
            "content": "ordinary", "expectedDecision": "allow", "required": True})])
    if provider_state != "ready":
        with pytest.raises(PlanCompilationError, match=f"Declared.*{contract}"):
            await validator.validate(request)
    else:
        status, _, results = await validator.validate(request)
        assert status == "passed", results
        assert results[0]["modelInvocations"] == 0
        execute.assert_not_called()


@pytest.mark.parametrize("configured_phase,policy_phase", [("input", "output"), ("output", "input"), ("input", "input"), ("output", "output")])
@pytest.mark.parametrize("other_policy", [False, True])
async def test_declared_model_dependency_uses_the_assigned_rail(configured_phase, policy_phase, other_policy):
    from copy import deepcopy
    import httpx
    from runner.providers import dynamic_runtime_action_providers
    from tests.control_plane.test_capability_validation import candidate

    plan = custom_plan('flow check $text\n  await GuardRecordPolicyAction(flow_name="check", safe=True, text=$text)\n',
        ["GuardRecordPolicyAction"])
    plan["policy_versions"][0]["evaluation_contracts"] = ["tali.guard.content-safety.v1"]
    plan["policy_versions"][0]["rail_bindings"][0]["rail_type"] = policy_phase
    plan["policy_bindings"][0]["enabled_rails"] = [policy_phase]
    if other_policy:
        # An unrelated local Policy on the opposite rail must not acquire this
        # Policy's model dependency through a global union of active phases.
        opposite = "output" if policy_phase == "input" else "input"
        local = deepcopy(plan["policy_versions"][0])
        local.update(policy_id="local-other-rail", evaluation_contracts=[])
        local["rail_bindings"][0]["rail_type"] = opposite
        plan["policy_versions"].append(local)
        plan["policy_bindings"].append({"policy_id": local["policy_id"], "policy_version": "1", "enabled_rails": [opposite]})

    def no_call(_request):
        raise AssertionError("Dependency prewarm must not call a model")

    providers = action_providers(*dynamic_runtime_action_providers(candidate(configured_phase).configuration,
        {"provider-1": "test-only"}, transport=httpx.MockTransport(no_call)))
    validator = DefaultRunnerValidator(DefaultRunnerCompiler(), providers)
    request = protocol.ValidationRequest(run_id="declared-direction", guardrail_id=plan["guardrail_id"],
        candidate_version=plan["guardrail_version"], source_draft_revision=1, plan=plan_to_proto(plan), runtime_profile="auto",
        test_cases=[validation_test_to_proto({"id": "benign", "name": "Benign", "phase": policy_phase,
            "content": "ordinary", "expectedDecision": "allow", "required": True})])
    if configured_phase != policy_phase:
        with pytest.raises(PlanCompilationError, match=f"Declared.*content-safety.*{policy_phase}"):
            await validator.validate(request)
    else:
        status, _, results = await validator.validate(request)
        assert status == "passed", results
        assert results[0]["modelInvocations"] == 0
