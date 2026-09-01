from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, replace
from typing import Any, Literal

import yaml
from nemoguardrails import RailsConfig

from ..policy_library import policy as library_policy
from ..nemo.action_registry import (
    ACTION_CONTENT_FILTER,
    ACTION_EVALUATE,
    ACTION_PROMPT_SECURITY,
    ACTION_RECORD_NATIVE,
    ACTION_RECORD_POLICY,
    ACTION_RESOLVE,
    ACTION_SECRETS,
    ACTION_TOPIC_JUDGE,
    ACTION_TOPIC_RULES,
    action_name_for,
)
from ..nemo.artifacts import config_checksum
from ..runtime.contracts import (
    GuardrailPhase,
    GuardrailPlanModule,
    GuardrailPlanSnapshot,
    NeMoActionBinding,
    NeMoConfigSnapshot,
    NeMoRuntimeProfile,
    flow_rule_id,
)
from .domain import PolicyDraft, PlanCompilationError, RailBinding


NEMO_COMPILER_VERSION = "tasklattice-nemo-config-v11"

ExecutionSurface = Literal["standalone_check", "owned_generation"]

_NATIVE_IORAILS_FLOWS = {
    "content safety check input $model=content_safety",
    "content safety check output $model=content_safety",
    "topic safety check input $model=topic_control",
}

_COLANG1_STANDARD_ACTIONS = {
    ACTION_EVALUATE,
    ACTION_SECRETS,
    ACTION_CONTENT_FILTER,
    ACTION_TOPIC_RULES,
    ACTION_PROMPT_SECURITY,
    ACTION_TOPIC_JUDGE,
}
_COLANG1_COMPLEX_CAPABILITIES = {"contextual_grounding", "automated_reasoning"}
_ALLOWED_RUNTIME_MODEL_TYPES = frozenset({"content_safety", "topic_control"})


class NeMoConfigCompiler:
    """Compile a released Guardrail plan into an immutable NeMo configuration."""

    def __init__(
        self,
        *,
        models: tuple[dict[str, Any], ...] = (),
        builtin_prompts_yaml: str = "",
        otel_enabled: bool = False,
        execution_surface: ExecutionSurface = "standalone_check",
    ) -> None:
        self._models = tuple(dict(item) for item in models)
        self._model_types = frozenset(str(item.get("type", "")) for item in models)
        unsupported_model_types = self._model_types - _ALLOWED_RUNTIME_MODEL_TYPES
        if unsupported_model_types:
            raise ValueError(
                "NeMo Runtime only accepts dedicated Guard Models; unsupported model "
                "types: " + ", ".join(sorted(unsupported_model_types)) + "."
            )
        self._builtin_prompts = _prompts(builtin_prompts_yaml)
        self._prompt_tasks = frozenset(
            str(item.get("task", "")) for item in self._builtin_prompts
        )
        self._otel_enabled = otel_enabled
        if execution_surface not in {"standalone_check", "owned_generation"}:
            raise ValueError(f"Unsupported NeMo execution surface {execution_surface!r}.")
        self._execution_surface = execution_surface

    def has_model_dependency(self, name: str) -> bool:
        return name in self._model_types

    def has_prompt_dependency(self, name: str) -> bool:
        return name in self._prompt_tasks

    def compile(self, plan: GuardrailPlanSnapshot) -> NeMoConfigSnapshot:
        flows: dict[GuardrailPhase, list[str]] = {"input": [], "output": []}
        binding_phases: dict[str, list[GuardrailPhase]] = {}
        binding_steps = {}
        required_models: set[str] = set()
        required_features: set[str] = set()

        capabilities = tuple(dict.fromkeys(step.capability for step in plan.steps))
        for phase in ("input", "output"):
            native_detection: list[str] = []
            native_mutation: list[str] = []
            for capability in capabilities:
                steps = tuple(
                    step
                    for step in plan.steps
                    if step.capability == capability and phase in step.phases
                )
                if not steps:
                    continue

                # A NeMo library flow represents one terminal check. Never
                # collapse an evaluation graph into that flow or dependent
                # contracts would silently disappear.
                native = (
                    self._native_flow(capability, phase, steps[0].on_unsafe)
                    if len(steps) == 1
                    else None
                )
                if native is not None:
                    target = native_mutation if native.startswith("mask ") else native_detection
                    target.append(native)
                    if capability == "content_safety":
                        required_models.add("content_safety")
                    elif capability == "topic_control":
                        required_models.add("topic_control")
                    continue

                for step in steps:
                    binding_steps[step.id] = step
                    binding_phases.setdefault(step.id, []).append(phase)

            flows[phase].extend(native_detection)
            flows[phase].extend(native_mutation)

        builtin_bindings = tuple(
            _builtin_action_binding(
                plan,
                step_id,
                binding_steps[step_id],
                tuple(dict.fromkeys(phases)),
            )
            for step_id, phases in binding_phases.items()
        )
        custom_bindings = _custom_action_bindings(plan)
        bindings = builtin_bindings + custom_bindings

        missing = required_models - self._model_types
        if missing:
            raise PlanCompilationError(
                "NeMo model configuration is required for: "
                + ", ".join(sorted(missing))
                + "."
            )

        prompts = self._prompts_for(plan, required_models)
        runtime_profile = _runtime_profile(
            plan,
            flows,
            builtin_bindings,
            custom_bindings,
            required_features,
            execution_surface=self._execution_surface,
        )
        runtime_engine = (
            "iorails" if runtime_profile == "iorails_native" else "llmrails"
        )
        colang_version = (
            "2.x"
            if runtime_profile == "llmrails_colang2_programmable"
            else "1.0"
        )
        if runtime_profile == "llmrails_colang1_standard":
            builtin_bindings = tuple(
                _with_result_var(binding) for binding in builtin_bindings
            )
            bindings = builtin_bindings + custom_bindings
            flows = _colang_v1_flow_lists(flows, builtin_bindings)
        config = self._config(
            flows,
            prompts,
            required_features,
            runtime_profile=runtime_profile,
            colang_version=colang_version,
            include_flow_lists=runtime_profile != "llmrails_colang2_programmable",
        )
        config_yaml = yaml.safe_dump(
            config,
            allow_unicode=True,
            sort_keys=False,
        )
        colang_content = (
            _colang_v1_standard(builtin_bindings)
            if runtime_profile == "llmrails_colang1_standard"
            else ""
            if runtime_profile == "iorails_native"
            else _colang_v2(plan, flows, builtin_bindings, custom_bindings)
        )
        rail_flows = tuple(
            (phase, flow)
            for phase, phase_flows in flows.items()
            for flow in phase_flows
        ) + tuple(
            (binding.phases[0], binding.id) for binding in custom_bindings
        )
        dependency_manifest = _dependency_manifest(
            plan,
            bindings,
            required_models,
            prompts,
            runtime_profile=runtime_profile,
            has_native_flows=any(flows.values()),
        )
        snapshot = NeMoConfigSnapshot(
            guardrail_id=plan.guardrail_id,
            guardrail_version=plan.guardrail_version,
            compiler_version=NEMO_COMPILER_VERSION,
            output_delivery=plan.output_delivery,
            config_yaml=config_yaml,
            colang_content=colang_content,
            prompts_yaml=yaml.safe_dump(
                {"prompts": prompts}, allow_unicode=True, sort_keys=False
            ) if prompts else "",
            action_bindings=bindings,
            required_models=tuple(sorted(required_models)),
            required_features=tuple(sorted(required_features)),
            runtime_engine=runtime_engine,
            colang_version=colang_version,
            runtime_profile=runtime_profile,
            rail_flows=rail_flows,
            dependency_manifest=dependency_manifest,
            estimated_critical_path_ms=_estimated_critical_path_ms(
                plan, custom_bindings
            ),
        )
        self.validate(snapshot)
        return snapshot

    @staticmethod
    def validate_policy(policy_id: str, draft: PolicyDraft) -> None:
        if draft.colang_version != "2.x":
            raise PlanCompilationError(
                f"Custom Policy {policy_id!r} must use Colang 2.x; "
                "the Colang 1 standard lane is generated from versioned Python "
                "Action contracts rather than user-authored Policy source."
            )
        declarations: dict[str, tuple[str, int]] = {}
        for source in draft.sources:
            for match in re.finditer(
                r"(?m)^flow\s+([A-Za-z_][A-Za-z0-9_]*)\b", source.content
            ):
                flow_name = match.group(1)
                line = source.content.count("\n", 0, match.start()) + 1
                if flow_name in declarations:
                    previous_path, previous_line = declarations[flow_name]
                    raise PlanCompilationError(
                        f"Policy {policy_id!r} declares duplicate Flow "
                        f"{flow_name!r} at {source.path}:{line}; first declared at "
                        f"{previous_path}:{previous_line}."
                    )
                declarations[flow_name] = (source.path, line)
        declared = set(declarations)
        if "main" in declared:
            raise PlanCompilationError(
                f"Policy {policy_id!r} must not declare the process-wide main flow."
            )
        missing = tuple(
            binding.flow_name
            for binding in draft.rail_bindings
            if binding.flow_name not in declared
        )
        if missing:
            raise PlanCompilationError(
                f"Policy {policy_id!r} has Rail bindings for undefined flows: "
                + ", ".join(missing)
                + "."
            )
        allowed_imports = {"core"}
        for source in draft.sources:
            for match in re.finditer(r"(?m)^\s*import\s+([^\s#]+)", source.content):
                imported = match.group(1)
                if imported not in allowed_imports:
                    line = source.content.count("\n", 0, match.start()) + 1
                    raise PlanCompilationError(
                        f"Policy {policy_id!r} uses forbidden import {imported!r} "
                        f"at {source.path}:{line}."
                    )
            for match in re.finditer(
                r"\b(?:await|start)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(",
                source.content,
            ):
                called = match.group(1)
                line = source.content.count("\n", 0, match.start()) + 1
                if called[0].islower() and called not in declared:
                    raise PlanCompilationError(
                        f"Policy {policy_id!r} calls undefined Flow {called!r} "
                        f"at {source.path}:{line}."
                    )
        referenced_actions = {item.name for item in draft.action_references}
        for source in draft.sources:
            for match in re.finditer(
                r"\b(?:await|start)\s+([A-Z][A-Za-z0-9_]*Action)\s*\(",
                source.content,
            ):
                action_name = match.group(1)
                if action_name not in referenced_actions:
                    line = source.content.count("\n", 0, match.start()) + 1
                    raise PlanCompilationError(
                        f"Policy {policy_id!r} calls unreferenced Action "
                        f"{action_name!r} at {source.path}:{line}."
                    )
        binding_names = {item.flow_name for item in draft.rail_bindings}
        for binding in draft.rail_bindings:
            missing_dependencies = set(binding.depends_on) - binding_names
            if missing_dependencies:
                raise PlanCompilationError(
                    f"Policy {policy_id!r} Flow {binding.flow_name!r} depends on "
                    "undefined Rail Flows: "
                    + ", ".join(sorted(missing_dependencies))
                    + "."
                )
        _validate_binding_graph(policy_id, draft.rail_bindings)
        colang = "\n".join(
            (
                "import core" if draft.colang_version == "2.x" else "",
                *(source.content for source in draft.sources),
                (
                    "flow main\n  user said something as $message\n  pass"
                    if draft.colang_version == "2.x"
                    else 'define user express greeting\n  "hello"'
                ),
            )
        )
        try:
            RailsConfig.from_content(
                yaml_content=yaml.safe_dump(
                    {"colang_version": draft.colang_version, "models": []}
                ),
                colang_content=colang,
            )
        except Exception as error:
            raise PlanCompilationError(
                f"Policy {policy_id!r} Colang is invalid: "
                f"{type(error).__name__}: {error}"
            ) from error

    @staticmethod
    def checksum(snapshot: NeMoConfigSnapshot) -> str:
        return config_checksum(snapshot)

    @staticmethod
    def validate(snapshot: NeMoConfigSnapshot) -> None:
        try:
            RailsConfig.from_content(
                yaml_content=snapshot.config_yaml,
                colang_content=snapshot.colang_content or None,
            )
        except Exception as error:
            raise PlanCompilationError(
                f"Compiled NeMo configuration is invalid: {type(error).__name__}: {error}"
            ) from error

    def _native_flow(
        self,
        capability: str,
        phase: GuardrailPhase,
        action: str,
    ) -> str | None:
        if (
            capability == "topic_control"
            and action == "reject"
            and phase == "input"
            and "topic_control" in self._model_types
        ):
            return "topic safety check input $model=topic_control"
        return None

    def _prompts_for(
        self,
        plan: GuardrailPlanSnapshot,
        required_models: set[str],
    ) -> list[dict[str, Any]]:
        prompts = [
            dict(item)
            for item in self._builtin_prompts
            if str(item.get("task", "")).startswith("content_safety_check_")
            and "content_safety" in required_models
        ]
        if "topic_control" in required_models:
            topic_step = next(
                step for step in plan.steps if step.capability == "topic_control"
            )
            parameters = dict(topic_step.parameters)
            prompts.append(
                {
                    "task": "topic_safety_check_input $model=topic_control",
                    "content": "\n".join(
                        (
                            "You are the topic policy evaluator for an enterprise assistant.",
                            f"Authorized purpose: {parameters.get('purpose', '')}",
                            "Allowed topics:",
                            parameters.get("allowed_topics", ""),
                            "Restricted topics:",
                            parameters.get("restricted_topics", ""),
                            "Classify the primary requested task, not entities merely mentioned as context.",
                        )
                    ),
                    "max_tokens": 10,
                }
            )
        return prompts

    def _config(
        self,
        flows: dict[GuardrailPhase, list[str]],
        prompts: list[dict[str, Any]],
        required_features: set[str],
        *,
        runtime_profile: NeMoRuntimeProfile,
        colang_version: str,
        include_flow_lists: bool,
    ) -> dict[str, Any]:
        rails: dict[str, Any] = {}
        if include_flow_lists:
            rails.update(
                {
                    phase: {"flows": items, "parallel": True}
                    for phase, items in flows.items()
                    if items
                }
            )
        if "sensitive_data_detection" in required_features:
            rails["config"] = {
                "sensitive_data_detection": {
                    "input": {"entities": ["EMAIL_ADDRESS", "CREDIT_CARD", "US_SSN"]},
                    "output": {"entities": ["EMAIL_ADDRESS", "CREDIT_CARD", "US_SSN"]},
                    "retrieval": {"entities": ["EMAIL_ADDRESS", "CREDIT_CARD", "US_SSN"]},
                }
            }
        tracing_enabled = (
            self._otel_enabled
            and runtime_profile != "llmrails_colang2_programmable"
        )
        tracing: dict[str, Any] = {
            "enabled": tracing_enabled,
            "enable_content_capture": False,
        }
        if runtime_profile == "llmrails_colang1_standard":
            tracing.update(
                {
                    "adapters": [{"name": "OpenTelemetry"}],
                    "span_format": "opentelemetry",
                }
            )
        config: dict[str, Any] = {
            "colang_version": colang_version,
            "enable_rails_exceptions": False,
            "rails": rails,
            "tracing": tracing,
            "metrics": {
                "enabled": (
                    self._otel_enabled and runtime_profile == "iorails_native"
                )
            },
        }
        if self._models:
            config["models"] = [dict(item) for item in self._models]
        if prompts:
            config["prompts"] = prompts
        return config


def _prompts(raw: str) -> tuple[dict[str, Any], ...]:
    if not raw.strip():
        return ()
    payload = yaml.safe_load(raw) or {}
    return tuple(dict(item) for item in payload.get("prompts", ()))


def _runtime_profile(
    plan: GuardrailPlanSnapshot,
    native_flows: dict[GuardrailPhase, list[str]],
    builtin_bindings: tuple[NeMoActionBinding, ...],
    custom_bindings: tuple[NeMoActionBinding, ...],
    required_features: set[str],
    *,
    execution_surface: ExecutionSurface,
) -> NeMoRuntimeProfile:
    """Select the smallest NeMo runtime that proves the plan's semantics.

    IORails owns full generation, but this service normally performs standalone
    pre/post checks.  The latter therefore remains on LLMRails even when every
    configured library flow is IORails-compatible.
    """
    configured_native = tuple(
        flow for items in native_flows.values() for flow in items
    )
    iorails_compatible = (
        execution_surface == "owned_generation"
        and not builtin_bindings
        and not custom_bindings
        and "sensitive_data_detection" not in required_features
        and bool(configured_native)
        and all(flow in _NATIVE_IORAILS_FLOWS for flow in configured_native)
    )
    if iorails_compatible:
        return "iorails_native"
    if _is_colang1_standard_compatible(
        plan, configured_native, builtin_bindings, custom_bindings
    ):
        return "llmrails_colang1_standard"
    return "llmrails_colang2_programmable"


def _is_colang1_standard_compatible(
    plan: GuardrailPlanSnapshot,
    native_flows: tuple[str, ...],
    builtin_bindings: tuple[NeMoActionBinding, ...],
    custom_bindings: tuple[NeMoActionBinding, ...],
) -> bool:
    if any(
        not any(
            module.phase == phase and step.id in module.step_ids
            for module in plan.modules
        )
        for step in plan.steps
        for phase in step.phases
    ):
        # Fall through to the programmable compiler, whose graph validation
        # reports the missing Policy module before a runtime can be built.
        return False
    if custom_bindings:
        # User-authored Policies are validated and namespaced as Colang 2.x.
        return False
    if any(step.capability in _COLANG1_COMPLEX_CAPABILITIES for step in plan.steps):
        return False
    if any(module.depends_on for module in plan.modules):
        return False
    if any(
        module.input_view not in {"original", "complete_output"}
        for module in plan.modules
    ):
        return False

    steps_by_capability_phase: dict[tuple[str, GuardrailPhase], list[object]] = {}
    for step in plan.steps:
        for phase in step.phases:
            steps_by_capability_phase.setdefault((step.capability, phase), []).append(step)
    if any(len(items) != 1 for items in steps_by_capability_phase.values()):
        # Contract dependency graphs need ordered, result-aware routing.
        return False
    if any(
        binding.action_name not in _COLANG1_STANDARD_ACTIONS
        or binding.depends_on
        or binding.execution_mode != "detect"
        for binding in builtin_bindings
    ):
        return False

    # Native library flows and custom Actions do not expose one common result
    # contract.  Keep mixed plans programmable until native adapters produce
    # explicit per-binding results.
    if native_flows and builtin_bindings:
        return False

    modifiers_by_phase = {
        phase: sum(
            1
            for binding in builtin_bindings
            if phase in binding.phases and _binding_can_modify(binding)
        )
        for phase in ("input", "output")
    }
    return all(count <= 1 for count in modifiers_by_phase.values())


def _binding_can_modify(binding: NeMoActionBinding) -> bool:
    if binding.on_unsafe not in {"reject", "pass"}:
        return True
    if binding.action_name in {
        ACTION_TOPIC_RULES,
        ACTION_PROMPT_SECURITY,
        ACTION_TOPIC_JUDGE,
    }:
        # These Actions can return ``uncertain``.  The standard lane maps that
        # outcome to a clarification, which is a content modification even when
        # the configured unsafe action itself is reject.
        return True
    if binding.capability != "builtin_content_filter":
        return False

    # A Policy can contain a mix of reject and redact Rules even though its
    # Guardrail-level fallback action is reject. Inspect the immutable Rule
    # selection rather than classifying every Policy as a modifier; this lets
    # reject-only Policies safely share the C1 parallel
    # lane with one real modifier (for example PII redaction).
    parameters = dict(binding.parameters)
    try:
        enabled = json.loads(parameters.get("enabled_rules_json", "{}"))
        overrides = json.loads(parameters.get("rule_actions_json", "{}"))
        custom_rules = json.loads(parameters.get("custom_rules_json", "[]"))
    except (TypeError, ValueError):
        return True

    if any(
        _is_modifying_rule_action(str(item.get("action", "")))
        for item in custom_rules
        if isinstance(item, dict)
    ):
        return True

    for policy_id in parameters.get("policy_ids", "").splitlines():
        policy_id = policy_id.strip()
        if not policy_id:
            continue
        definition = library_policy(policy_id)
        if definition is None:
            return True
        selected = enabled.get(policy_id)
        selected_ids = set(selected) if isinstance(selected, list) else None
        policy_overrides = overrides.get(policy_id, {})
        if not isinstance(policy_overrides, dict):
            policy_overrides = {}
        for rule in definition.rules:
            if selected_ids is not None and rule.id not in selected_ids:
                continue
            # Flat overrides are accepted for already-compiled snapshots; new
            # plans namespace Rule actions by Policy ID.
            action = policy_overrides.get(rule.id, overrides.get(rule.id, rule.effect))
            if _is_modifying_rule_action(str(action)):
                return True
    return False


def _is_modifying_rule_action(action: str) -> bool:
    return action.strip().casefold() in {"mask", "redact", "rewrite"}


def _with_result_var(binding: NeMoActionBinding) -> NeMoActionBinding:
    return replace(
        binding,
        result_var=(
            f"tasklattice_result_{_flow_identifier(binding.id)}_"
            f"{_binding_suffix(binding)}"
        ),
    )


def _colang_v1_flow_lists(
    native_flows: dict[GuardrailPhase, list[str]],
    bindings: tuple[NeMoActionBinding, ...],
) -> dict[GuardrailPhase, list[str]]:
    return {
        phase: [
            *native_flows[phase],
            *(
                _colang_v1_flow_name(binding, phase)
                for binding in bindings
                if phase in binding.phases
            ),
        ]
        for phase in ("input", "output")
    }


def _colang_v1_standard(
    bindings: tuple[NeMoActionBinding, ...],
) -> str:
    lines = [
        "define bot tasklattice refuse",
        '  "The interaction was blocked by the active Guardrail."',
        "",
    ]
    for binding in bindings:
        if not binding.action_name or not binding.result_var:
            raise PlanCompilationError(
                f"Colang 1 Action binding {binding.id!r} is incomplete."
            )
        for phase in binding.phases:
            message_var = "$user_message" if phase == "input" else "$bot_message"
            lines.extend(
                (
                    f"define subflow {_colang_v1_flow_name(binding, phase)}",
                    (
                        f"  ${binding.result_var} = execute {binding.action_name}("
                        f'text={message_var}, binding_id="{binding.id}")'
                    ),
                    f'  if ${binding.result_var}["blocked"]',
                    "    bot tasklattice refuse",
                    "    stop",
                    f'  else if ${binding.result_var}["modified"]',
                    f'    {message_var} = ${binding.result_var}["content"]',
                    "",
                )
            )
    return "\n".join(lines).rstrip() + "\n"


def _colang_v1_flow_name(
    binding: NeMoActionBinding,
    phase: GuardrailPhase,
) -> str:
    return (
        "tasklattice check "
        f"{phase} {_flow_identifier(binding.id).replace('_', ' ')} "
        f"{_binding_suffix(binding)}"
    )


def _binding_suffix(binding: NeMoActionBinding) -> str:
    return hashlib.sha256(binding.id.encode()).hexdigest()[:8]


def _timeout_for(
    plan: GuardrailPlanSnapshot,
    step_id: str,
    phase: GuardrailPhase,
) -> int:
    module = next(
        (
            item
            for item in plan.modules
            if item.phase == phase and step_id in item.step_ids
        ),
        None,
    )
    if module is None:
        return 2_000
    step = next(item for item in plan.steps if item.id == step_id)
    serial_steps = tuple(
        candidate
        for candidate_id in module.step_ids
        if (
            (candidate := next(
                (item for item in plan.steps if item.id == candidate_id),
                None,
            ))
            is not None
            and candidate.capability == step.capability
            and phase in candidate.phases
        )
    )
    if len(serial_steps) <= 1:
        return module.timeout_ms

    # Independent capabilities run concurrently. Within one capability, a
    # contract that gates another contract receives a small bounded budget;
    # terminal evaluators receive the remaining declared module deadline.
    prerequisites = tuple(
        candidate
        for candidate in serial_steps
        if any(item.trigger.step_ref == candidate.id for item in serial_steps)
    )
    terminals = tuple(candidate for candidate in serial_steps if candidate not in prerequisites)
    prerequisite_budget = min(
        750,
        max(1, module.timeout_ms // len(serial_steps)),
    )
    if step in prerequisites:
        return prerequisite_budget
    remaining = max(
        1,
        module.timeout_ms - prerequisite_budget * len(prerequisites),
    )
    return max(1, remaining // max(1, len(terminals)))


def _colang_v2(
    plan: GuardrailPlanSnapshot,
    native_flows: dict[GuardrailPhase, list[str]],
    bindings: tuple[NeMoActionBinding, ...],
    custom_bindings: tuple[NeMoActionBinding, ...],
) -> str:
    """Compile the policy graph into Colang 2.x so NeMo owns orchestration."""
    imports = {"import core"}
    configured_native = {
        flow for flows in native_flows.values() for flow in flows
    }
    if any(flow.startswith("content safety check") for flow in configured_native):
        imports.add("import nemoguardrails.library.content_safety")
    if any(flow.startswith("topic safety check") for flow in configured_native):
        imports.add("import nemoguardrails.library.topic_safety")
    lines = [
        *sorted(imports),
        "",
        "flow main",
        "  user said something as $message",
        "  global $tasklattice_phase",
        '  if $tasklattice_phase == "output"',
        "    await tasklattice output rails $message.transcript",
        "  else",
        "    await tasklattice input rails $message.transcript",
        "",
    ]

    custom_sources = _compiled_policy_sources(plan)
    if custom_sources:
        lines.extend((custom_sources, ""))

    for phase in ("input", "output"):
        phase_bindings = tuple(item for item in bindings if phase in item.phases)
        phase_custom = tuple(
            item for item in custom_bindings if phase in item.phases
        )
        capabilities = tuple(dict.fromkeys(
            tuple(_native_capability(flow) for flow in native_flows[phase])
            + tuple(item.capability for item in phase_bindings)
        ))
        capabilities = tuple(item for item in capabilities if item)
        if not capabilities and not phase_custom:
            continue

        lines.extend((f"flow tasklattice {phase} rails $text",))
        message_var = "$user_message" if phase == "input" else "$bot_message"
        lines.extend((f"  global {message_var}", f"  {message_var} = $text"))

        modules = _phase_modules(plan, phase, capabilities) if capabilities else ()
        detection_custom = tuple(
            item for item in phase_custom if item.execution_mode == "detect"
        )
        mutation_custom = tuple(
            sorted(
                (item for item in phase_custom if item.execution_mode == "mutate"),
                key=lambda item: int(item.parameter("priority") or 0),
            )
        )
        module_waves = _module_waves(modules) if modules else ()
        policy_waves = _custom_binding_waves(detection_custom)
        for index in range(max(len(module_waves), len(policy_waves))):
            flow_names = tuple(
                _module_flow_name(phase, module.id)
                for module in (module_waves[index] if index < len(module_waves) else ())
            ) + tuple(
                _compiled_flow_name(item)
                for item in (
                    policy_waves[index] if index < len(policy_waves) else ()
                )
            )
            lines.extend(_await_parallel(flow_names, "$text", indent="  "))
        for binding in mutation_custom:
            lines.append(
                f"  await {_compiled_flow_name(binding)}(text=$text)"
            )
        lines.extend((f"  $decision = await {ACTION_RESOLVE}(text=$text)", ""))

        capability_to_native = {
            _native_capability(flow): flow for flow in native_flows[phase]
        }
        for module in modules:
            module_capabilities = tuple(
                capability
                for capability in capabilities
                if _module_for_capability(plan, phase, capability) == module.id
            )
            lines.append(f"flow {_module_flow_name(phase, module.id)} $text")
            lines.extend(
                _await_parallel(
                    tuple(
                        _capability_flow_name(phase, capability)
                        for capability in module_capabilities
                    ),
                    "$text",
                    indent="  ",
                )
            )
            lines.append("")

            for capability in module_capabilities:
                flow_name = _capability_flow_name(phase, capability)
                native = capability_to_native.get(capability)
                selected = tuple(
                    item for item in phase_bindings
                    if item.capability == capability
                )
                lines.append(f"flow {flow_name} $text")
                if native:
                    lines.extend(_native_flow_lines(native, phase))
                else:
                    lines.extend(_binding_flow_lines(selected))
                lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def _binding_flow_lines(bindings: tuple[NeMoActionBinding, ...]) -> list[str]:
    lines: list[str] = []
    by_id = {binding.id: binding for binding in bindings}
    result_vars = {
        binding.id: f"$tl_result_{_flow_identifier(binding.id)}_{_binding_suffix(binding)}"
        for binding in bindings
    }
    for binding in bindings:
        if not binding.action_name:
            raise PlanCompilationError(
                f"NeMo Action binding {binding.id!r} has no fixed Action name."
            )
        result_var = result_vars[binding.id]
        call = (
            f"{result_var} = await {binding.action_name}("
            f'text=$text, binding_id="{binding.id}")'
        )
        if binding.trigger.type == "always":
            lines.append(f"  {call}")
            continue
        source_id = binding.trigger.step_ref
        if source_id not in by_id or source_id not in result_vars:
            raise PlanCompilationError(
                f"Evaluation binding {binding.id!r} references unavailable "
                f"trigger step {source_id!r}."
            )
        source = result_vars[source_id]
        condition = " or ".join(
            f'{source}["verdict"] == "{verdict}"'
            for verdict in binding.trigger.verdicts
        )
        lines.extend((f"  if {condition}", f"    {call}"))
    return lines


def _native_flow_lines(flow: str, phase: GuardrailPhase) -> list[str]:
    if flow.startswith("content safety check"):
        action = (
            "ContentSafetyCheckInputAction"
            if phase == "input"
            else "ContentSafetyCheckOutputAction"
        )
        return [
            f'  $response = await {action}(model_name="content_safety")',
            f"  $recorded = await {ACTION_RECORD_NATIVE}("
            'risk="content_safety", safe=$response["allowed"], text=$text, '
            'details=$response["policy_violations"])',
        ]
    if flow.startswith("topic safety check"):
        return [
            '  $response = await TopicSafetyCheckInputAction(model_name="topic_control")',
            f"  $recorded = await {ACTION_RECORD_NATIVE}("
            'risk="topic_control", safe=$response["on_topic"], text=$text)',
        ]
    if "sensitive data" in flow:
        action = (
            "MaskSensitiveDataAction"
            if flow.startswith("mask ")
            else "DetectSensitiveDataAction"
        )
        return [
            f'  $pii_result = await {action}(source="{phase}", text=$text)'
        ]
    raise PlanCompilationError(f"Unsupported NeMo native flow {flow!r}.")


def _await_parallel(
    flow_names: tuple[str, ...],
    argument: str,
    *,
    indent: str,
) -> list[str]:
    if not flow_names:
        return [f"{indent}pass"]
    if len(flow_names) == 1:
        return [f"{indent}await {flow_names[0]}(text={argument})"]
    refs = tuple(f"$parallel_{index}" for index in range(len(flow_names)))
    lines = [
        f"{indent}start {name}(text={argument}) as {ref}"
        for name, ref in zip(flow_names, refs, strict=True)
    ]
    joined = " and ".join(f"{ref}.Finished()" for ref in refs)
    lines.append(f"{indent}match {joined}")
    return lines


def _phase_modules(
    plan: GuardrailPlanSnapshot,
    phase: GuardrailPhase,
    capabilities: tuple[str, ...],
) -> tuple[GuardrailPlanModule, ...]:
    modules = list(plan.modules_for(phase))
    unassigned = tuple(
        capability
        for capability in capabilities
        if not any(
            _module_contains_capability(plan, item.id, capability)
            for item in modules
        )
    )
    if unassigned:
        raise PlanCompilationError(
            "NeMo capabilities must belong to a Policy module: "
            + ", ".join(unassigned)
            + "."
        )
    return tuple(modules)


def _module_waves(
    modules: tuple[GuardrailPlanModule, ...],
) -> tuple[tuple[GuardrailPlanModule, ...], ...]:
    pending = list(modules)
    completed: set[str] = set()
    waves = []
    while pending:
        wave = tuple(item for item in pending if set(item.depends_on) <= completed)
        if not wave:
            raise PlanCompilationError("NeMo module dependencies contain a cycle.")
        waves.append(wave)
        completed.update(item.id for item in wave)
        pending = [item for item in pending if item not in wave]
    return tuple(waves)


def _module_for_capability(
    plan: GuardrailPlanSnapshot,
    phase: GuardrailPhase,
    capability: str,
) -> str:
    try:
        return next(
            module.id
            for module in plan.modules_for(phase)
            if _module_contains_capability(plan, module.id, capability)
        )
    except StopIteration as error:
        raise PlanCompilationError(
            f"NeMo capability {capability!r} has no {phase} Policy module."
        ) from error


def _module_contains_capability(
    plan: GuardrailPlanSnapshot,
    module_id: str,
    capability: str,
) -> bool:
    module = next((item for item in plan.modules if item.id == module_id), None)
    if module is None:
        return False
    steps = {step.id: step for step in plan.steps}
    return any(
        step_id in steps and steps[step_id].capability == capability
        for step_id in module.step_ids
    )


def _module_flow_name(phase: GuardrailPhase, module_id: str) -> str:
    return f"tasklattice_module_{phase}_{_flow_identifier(module_id)}"


def _capability_flow_name(phase: GuardrailPhase, capability: str) -> str:
    return f"tasklattice_capability_{phase}_{_flow_identifier(capability)}"


def _flow_identifier(value: str) -> str:
    return "_".join(re.sub(r"[^a-zA-Z0-9]+", " ", value).split()).lower()


def _native_capability(flow: str) -> str | None:
    if flow.startswith("content safety check"):
        return "content_safety"
    if flow.startswith("topic safety check"):
        return "topic_control"
    if "sensitive data" in flow:
        return "pii"
    return None


def _builtin_action_binding(
    plan: GuardrailPlanSnapshot,
    step_id: str,
    step,
    phases: tuple[GuardrailPhase, ...],
) -> NeMoActionBinding:
    policy_id = None
    policy_version = None
    versions = {
        (item.policy_id, item.version): item for item in plan.policy_versions
    }
    for selected in plan.policy_bindings:
        version = versions.get((selected.policy_id, selected.policy_version))
        if (
            version is not None
            and version.source == "built-in"
            and dict(version.execution_contract).get("native_risk") == step.capability
        ):
            policy_id = selected.policy_id
            policy_version = selected.policy_version
            break
    return NeMoActionBinding(
        id=step_id,
        capability=step.capability,
        contract_ref=step.contract_ref,
        phases=phases,
        on_unsafe=step.on_unsafe,
        trigger=step.trigger,
        timeout_ms=max(_timeout_for(plan, step_id, phase) for phase in phases),
        parameters=step.parameters,
        policy_id=policy_id,
        policy_version=policy_version,
        action_name=action_name_for(step.capability, step.contract_ref),
        action_version="1.0.0",
    )


def _custom_action_bindings(
    plan: GuardrailPlanSnapshot,
) -> tuple[NeMoActionBinding, ...]:
    versions = {
        (item.policy_id, item.version): item for item in plan.policy_versions
    }
    bindings: list[NeMoActionBinding] = []
    for selected in plan.policy_bindings:
        version = versions.get((selected.policy_id, selected.policy_version))
        if version is None:
            # Declarative Policies are compiled into the built-in content-filter
            # Action and therefore have no standalone Colang version snapshot.
            continue
        if version.source == "built-in":
            continue
        if version.colang_version != "2.x":
            raise PlanCompilationError(
                f"Custom Policy {version.policy_id}@{version.version} must use "
                "Colang 2.x in an LLMRails Guardrail."
            )
        delivery = dict(version.execution_contract).get("output_delivery")
        if delivery == "full_buffered" and plan.output_delivery != "full_buffered":
            raise PlanCompilationError(
                f"Policy {version.policy_id}@{version.version} requires "
                "full-buffered output delivery."
            )
        action = next(
            (
                item
                for item in version.action_references
                if item.name != ACTION_RECORD_POLICY
            ),
            None,
        )
        enabled_rules = set(selected.enabled_rule_ids)
        rule_actions = dict(selected.rule_actions)
        for rail in version.rail_bindings:
            if rail.rail_type not in selected.enabled_rails:
                continue
            if rail.rail_type not in {"input", "output"}:
                raise PlanCompilationError(
                    f"R1 does not execute {rail.rail_type!r} Rail bindings yet."
                )
            rule_id = flow_rule_id(rail.rail_type, rail.flow_name)
            if enabled_rules and rule_id not in enabled_rules:
                continue
            binding_id = (
                f"tl.{version.policy_id}.v{version.version}.{rail.flow_name}"
            )
            bindings.append(
                NeMoActionBinding(
                    id=binding_id,
                    capability=version.policy_id,
                    contract_ref=(
                        version.evaluation_contracts[0]
                        if version.evaluation_contracts
                        else f"tali.policy.{version.policy_id}.v{version.version}"
                    ),
                    phases=(rail.rail_type,),
                    on_unsafe=(
                        rule_actions.get(rule_id)
                        or selected.action
                        or rail.on_unsafe
                    ),
                    timeout_ms=rail.timeout_ms,
                    parameters=(
                        *selected.parameter_values,
                        ("priority", str(rail.priority or 0)),
                    ),
                    policy_id=version.policy_id,
                    policy_version=version.version,
                    flow_name=rail.flow_name,
                    action_name=action.name if action else None,
                    action_version=action.version if action else None,
                    parallel_group=rail.parallel_group,
                    execution_mode=rail.execution_mode,
                    failure_mode=rail.failure_mode,
                    depends_on=rail.depends_on,
                )
            )
    return tuple(bindings)


def _compiled_policy_sources(plan: GuardrailPlanSnapshot) -> str:
    selected = {
        (item.policy_id, item.policy_version): item
        for item in plan.policy_bindings
    }
    output: list[str] = []
    for version in plan.policy_versions:
        binding = selected.get((version.policy_id, version.version))
        if binding is None:
            continue
        if version.source == "built-in":
            continue
        declared = tuple(
            dict.fromkeys(
                match.group(1)
                for source in version.sources
                for match in re.finditer(
                    r"(?m)^flow\s+([A-Za-z_][A-Za-z0-9_]*)\b",
                    source.content,
                )
            )
        )
        replacements = {
            name: _namespaced_flow_name(version.policy_id, version.version, name)
            for name in declared
        }
        parameters = dict(binding.parameter_values)
        for source in version.sources:
            content = re.sub(r"(?m)^\s*import\s+core\s*$", "", source.content)
            for name, replacement in replacements.items():
                content = re.sub(rf"\b{re.escape(name)}\b", replacement, content)
            for name, value in parameters.items():
                content = content.replace("${" + name + "}", value)
            output.append(
                f"# Policy {version.policy_id}@{version.version}: {source.path}\n"
                + content.strip()
            )
    return "\n\n".join(output)


def _compiled_flow_name(binding: NeMoActionBinding) -> str:
    if binding.policy_id is None or binding.policy_version is None or not binding.flow_name:
        raise PlanCompilationError(
            f"Custom Action binding {binding.id!r} is missing Policy metadata."
        )
    return _namespaced_flow_name(
        binding.policy_id, binding.policy_version, binding.flow_name
    )


def _namespaced_flow_name(policy_id: str, version: int, flow_name: str) -> str:
    # Colang 2.x does not accept dots in flow identifiers. The immutable
    # artifact retains the canonical dotted binding ID while executable Colang
    # uses the equivalent collision-free underscore form.
    return "_".join(
        (
            "tl",
            _flow_identifier(policy_id),
            f"v{version}",
            _flow_identifier(flow_name),
        )
    )


def _validate_binding_graph(
    policy_id: str,
    bindings: tuple[RailBinding, ...],
) -> None:
    by_name = {item.flow_name: item for item in bindings}
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(flow_name: str) -> None:
        if flow_name in visiting:
            raise PlanCompilationError(
                f"Policy {policy_id!r} Rail Flow dependencies contain a cycle "
                f"at {flow_name!r}."
            )
        if flow_name in visited:
            return
        visiting.add(flow_name)
        for dependency in by_name[flow_name].depends_on:
            visit(dependency)
        visiting.remove(flow_name)
        visited.add(flow_name)

    for name in by_name:
        visit(name)
    for binding in bindings:
        for dependency_name in binding.depends_on:
            dependency = by_name[dependency_name]
            if binding.execution_mode == "detect" and dependency.execution_mode == "mutate":
                raise PlanCompilationError(
                    f"Policy {policy_id!r} detection Flow {binding.flow_name!r} "
                    f"cannot depend on mutating Flow {dependency_name!r}."
                )
            if (
                binding.execution_mode == "mutate"
                and dependency.execution_mode == "mutate"
                and int(binding.priority or 0) <= int(dependency.priority or 0)
            ):
                raise PlanCompilationError(
                    f"Policy {policy_id!r} mutation Flow {binding.flow_name!r} "
                    f"must have a higher priority than dependency {dependency_name!r}."
                )


def _custom_binding_waves(
    bindings: tuple[NeMoActionBinding, ...],
) -> tuple[tuple[NeMoActionBinding, ...], ...]:
    pending = list(bindings)
    completed: set[tuple[str, int, str]] = set()
    waves: list[tuple[NeMoActionBinding, ...]] = []

    def key(item: NeMoActionBinding, flow_name: str | None = None):
        return (
            item.policy_id or "",
            item.policy_version or 0,
            flow_name or item.flow_name or "",
        )

    while pending:
        wave = tuple(
            item
            for item in pending
            if all(key(item, dependency) in completed for dependency in item.depends_on)
        )
        if not wave:
            raise PlanCompilationError(
                "Custom Policy detection dependencies contain a cycle or "
                "reference a non-detection Flow."
            )
        waves.append(wave)
        completed.update(key(item) for item in wave)
        pending = [item for item in pending if item not in wave]
    return tuple(waves)


def _dependency_manifest(
    plan: GuardrailPlanSnapshot,
    bindings: tuple[NeMoActionBinding, ...],
    required_models: set[str],
    prompts: list[dict[str, Any]],
    *,
    runtime_profile: NeMoRuntimeProfile,
    has_native_flows: bool,
) -> tuple[tuple[str, str, str], ...]:
    entries: set[tuple[str, str, str]] = set()
    for version in plan.policy_versions:
        entries.add(("policy", version.policy_id, f"v{version.version}:{version.checksum}"))
        for source in version.sources:
            digest = hashlib.sha256(source.content.encode()).hexdigest()
            entries.add(("source", f"{version.policy_id}/{source.path}", digest))
        if version.source != "built-in":
            # Custom Colang source may call more than the primary Action stored
            # on its rail binding, so every declared reference is a runtime
            # dependency. Built-in Policy definitions list all possible Action
            # implementations; only the plan-selected binding is required.
            for action in version.action_references:
                entries.add(("action", action.name, action.version))
        entries.update(
            ("evaluation_contract", item, "required")
            for item in version.evaluation_contracts
        )
        entries.update(("prompt", item, "pinned") for item in version.prompt_dependencies)
    for binding in bindings:
        if binding.action_name and binding.action_version:
            entries.add(("action", binding.action_name, binding.action_version))
    if runtime_profile == "llmrails_colang2_programmable":
        entries.add(("action", ACTION_RESOLVE, "1.0.0"))
        if has_native_flows:
            entries.add(("action", ACTION_RECORD_NATIVE, "1.0.0"))
        if any(item.policy_id is not None for item in bindings):
            entries.add(("action", ACTION_RECORD_POLICY, "1.0.0"))
    entries.update(("model", item, "profile") for item in required_models)
    for prompt in prompts:
        task = str(prompt.get("task", ""))
        digest = hashlib.sha256(
            json.dumps(prompt, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        entries.add(("prompt", task, digest))
    return tuple(sorted(entries))


def _estimated_critical_path_ms(
    plan: GuardrailPlanSnapshot,
    custom_bindings: tuple[NeMoActionBinding, ...],
) -> int:
    estimates: list[int] = []
    for phase in ("input", "output"):
        module_waves = _module_waves(plan.modules_for(phase)) if plan.modules_for(phase) else ()
        module_total = sum(max(item.timeout_ms for item in wave) for wave in module_waves)
        detections = tuple(
            item
            for item in custom_bindings
            if phase in item.phases and item.execution_mode == "detect"
        )
        detection_total = sum(
            max(item.timeout_ms for item in wave)
            for wave in _custom_binding_waves(detections)
        ) if detections else 0
        mutation_total = sum(
            item.timeout_ms
            for item in custom_bindings
            if phase in item.phases and item.execution_mode == "mutate"
        )
        estimates.append(max(module_total, detection_total) + mutation_total)
    return max(estimates, default=0)
