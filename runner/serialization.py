from __future__ import annotations

from datetime import datetime
import re
from typing import Any

from runner.toolkit.runtime.contracts import (
    AutomatedReasoningPolicySnapshot,
    EvaluationTrigger,
    GuardrailPlanModule,
    GuardrailPlanSnapshot,
    GuardrailPlanStep,
    GuardrailPolicyBindingSnapshot,
    NeMoActionBinding,
    NeMoConfigSnapshot,
    PolicyActionReferenceSnapshot,
    PolicyRailBindingSnapshot,
    PolicySourceSnapshot,
    PolicyVersionSnapshot,
)


def plan_from_dict(payload: dict[str, Any]) -> GuardrailPlanSnapshot:
    return GuardrailPlanSnapshot(
        guardrail_id=str(payload["guardrail_id"]),
        guardrail_version=_guardrail_version(payload["guardrail_version"]),
        compiler_version=str(payload.get("compiler_version", "tasklattice-controller-plan-v1")),
        safety_level=str(payload.get("safety_level", "balanced")),
        output_delivery=str(payload.get("output_delivery", "full_buffered")),
        steps=tuple(
            GuardrailPlanStep(
                id=str(item["id"]),
                capability=str(item["capability"]),
                contract_ref=str(item["contract_ref"]),
                phases=tuple(item.get("phases", ("input", "output"))),
                on_unsafe=str(item.get("on_unsafe", "reject")),
                trigger=_evaluation_trigger(item.get("trigger")),
                parameters=_pairs(item.get("parameters", ())),
            )
            for item in payload.get("steps", ())
        ),
        modules=tuple(
            GuardrailPlanModule(
                id=str(item["id"]),
                module=str(item["module"]),
                phase=str(item["phase"]),
                step_ids=tuple(item.get("step_ids", ())),
                depends_on=tuple(item.get("depends_on", ())),
                input_view=str(item.get("input_view", "original")),
                required_for_release=bool(item.get("required_for_release", True)),
                timeout_ms=int(item.get("timeout_ms", 2_000)),
                failure_mode=str(item.get("failure_mode", "fail_closed")),
            )
            for item in payload.get("modules", ())
        ),
        reasoning_policies=tuple(
            AutomatedReasoningPolicySnapshot(**item)
            for item in payload.get("reasoning_policies", ())
        ),
        policy_versions=tuple(_policy_version(item) for item in payload.get("policy_versions", ())),
        policy_bindings=tuple(
            GuardrailPolicyBindingSnapshot(
                policy_id=str(item["policy_id"]),
                policy_version=str(item["policy_version"]),
                action=(str(item["action"]) if item.get("action") else None),
                parameter_values=_pairs(item.get("parameter_values", ())),
                enabled_rule_ids=tuple(item.get("enabled_rule_ids", ())),
                rule_order=tuple(item.get("rule_order", ())),
                rule_actions=_pairs(item.get("rule_actions", ())),
                enabled_rails=tuple(item.get("enabled_rails", ("input", "output"))),
            )
            for item in payload.get("policy_bindings", ())
        ),
    )


def config_from_dict(payload: dict[str, Any]) -> NeMoConfigSnapshot:
    return NeMoConfigSnapshot(
        guardrail_id=str(payload["guardrail_id"]),
        guardrail_version=_guardrail_version(payload["guardrail_version"]),
        compiler_version=str(payload["compiler_version"]),
        output_delivery=str(payload.get("output_delivery", "full_buffered")),
        config_yaml=str(payload["config_yaml"]),
        colang_content=str(payload.get("colang_content", "")),
        prompts_yaml=str(payload.get("prompts_yaml", "")),
        action_bindings=tuple(_action_binding(item) for item in payload.get("action_bindings", ())),
        required_models=tuple(payload.get("required_models", ())),
        required_features=tuple(payload.get("required_features", ())),
        runtime_engine=str(payload.get("runtime_engine", "llmrails")),
        colang_version=str(payload.get("colang_version", "2.x")),
        runtime_profile=str(payload["runtime_profile"]),
        rail_flows=tuple(tuple(item) for item in payload.get("rail_flows", ())),
        dependency_manifest=tuple(tuple(item) for item in payload.get("dependency_manifest", ())),
        estimated_critical_path_ms=int(payload.get("estimated_critical_path_ms", 0)),
    )


def _guardrail_version(value: Any) -> str:
    if not isinstance(value, str) or re.fullmatch(r"\d{8}-\d{6}\.\d{3}Z", value) is None:
        raise ValueError("Guardrail Version must be a canonical UTC timestamp.")
    try:
        datetime.strptime(value, "%Y%m%d-%H%M%S.%fZ")
    except ValueError as error:
        raise ValueError("Guardrail Version must be a canonical UTC timestamp.") from error
    return value


def _action_binding(item: dict[str, Any]) -> NeMoActionBinding:
    return NeMoActionBinding(
        id=str(item["id"]),
        capability=str(item["capability"]),
        contract_ref=str(item["contract_ref"]),
        phases=tuple(item["phases"]),
        on_unsafe=str(item["on_unsafe"]),
        trigger=_evaluation_trigger(item.get("trigger")),
        timeout_ms=int(item.get("timeout_ms", 2_000)),
        parameters=_pairs(item.get("parameters", ())),
        policy_id=(str(item["policy_id"]) if item.get("policy_id") else None),
        policy_version=(str(item["policy_version"]) if item.get("policy_version") else None),
        flow_name=(str(item["flow_name"]) if item.get("flow_name") else None),
        action_name=(str(item["action_name"]) if item.get("action_name") else None),
        action_version=(str(item["action_version"]) if item.get("action_version") else None),
        parallel_group=(str(item["parallel_group"]) if item.get("parallel_group") else None),
        execution_mode=str(item.get("execution_mode", "detect")),
        failure_mode=str(item.get("failure_mode", "fail_closed")),
        depends_on=tuple(item.get("depends_on", ())),
        result_var=(str(item["result_var"]) if item.get("result_var") else None),
    )


def _policy_version(item: dict[str, Any]) -> PolicyVersionSnapshot:
    return PolicyVersionSnapshot(
        policy_id=str(item["policy_id"]),
        version=str(item["version"]),
        name=str(item["name"]),
        source=str(item["source"]),
        colang_version=str(item["colang_version"]),
        sources=tuple(PolicySourceSnapshot(**source) for source in item.get("sources", ())),
        parameter_schema=_pairs(item.get("parameter_schema", ())),
        rail_bindings=tuple(PolicyRailBindingSnapshot(**binding) for binding in item.get("rail_bindings", ())),
        action_references=tuple(PolicyActionReferenceSnapshot(**reference) for reference in item.get("action_references", ())),
        evaluation_contracts=tuple(item.get("evaluation_contracts", ())),
        prompt_dependencies=tuple(item.get("prompt_dependencies", ())),
        execution_contract=_pairs(item.get("execution_contract", ())),
        test_cases=_pairs(item.get("test_cases", ())),
        checksum=str(item["checksum"]),
    )


def _pairs(value: Any) -> tuple[tuple[str, str], ...]:
    if isinstance(value, dict):
        return tuple((str(key), str(item)) for key, item in value.items())
    return tuple((str(item[0]), str(item[1])) for item in value)


def _evaluation_trigger(value: Any) -> EvaluationTrigger:
    if value is None:
        return EvaluationTrigger()
    if not isinstance(value, dict):
        raise ValueError("Evaluation trigger must be an object.")
    return EvaluationTrigger(
        type=str(value.get("type", "always")),
        step_ref=(str(value["step_ref"]) if value.get("step_ref") else None),
        verdicts=tuple(str(verdict) for verdict in value.get("verdicts", ())),
    )
