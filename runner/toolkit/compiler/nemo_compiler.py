from __future__ import annotations

import hashlib
import json
import re
from dataclasses import replace
from typing import Any, Literal

import yaml
from nemoguardrails import RailsConfig

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
    GuardrailPlanSnapshot,
    NeMoActionBinding,
    NeMoConfigSnapshot,
    NeMoRuntimeProfile,
    flow_rule_id,
)
from .domain import PolicyDraft, PlanCompilationError, RailBinding


NEMO_COMPILER_VERSION = "tasklattice-nemo-config-v13-rule-order"

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
        _validate_execution_order(plan)
        flows: dict[GuardrailPhase, list[str]] = {"input": [], "output": []}
        binding_phases: dict[str, list[GuardrailPhase]] = {}
        binding_steps = {}
        required_models: set[str] = set()
        required_features: set[str] = set()

        for phase in ("input", "output"):
            for step in plan.steps:
                if phase not in step.phases:
                    continue
                capability = step.capability
                native = (
                    self._native_flow(capability, phase, step.on_unsafe)
                    if sum(capability == item.capability and phase in item.phases for item in plan.steps) == 1
                    else None
                )
                if native is not None:
                    flows[phase].append(native)
                    if capability == "content_safety":
                        required_models.add("content_safety")
                    elif capability == "topic_control":
                        required_models.add("topic_control")
                    continue

                binding_steps[step.id] = step
                binding_phases.setdefault(step.id, []).append(phase)

        builtin_bindings = tuple(
            _builtin_action_binding(
                plan,
                step_id,
                binding_steps[step_id],
                tuple(dict.fromkeys(phases)),
            )
            for step_id in (step.id for step in plan.steps if step.id in binding_phases)
            for phases in (binding_phases[step_id],)
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
                    phase: {"flows": items, "parallel": False}
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
    if any(step.trigger.type != "always" for step in plan.steps):
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

    # Sequential NeMo subflows thread user_message/bot_message, so any number
    # of modifiers is safe. No capability regrouping or mutation-priority sort.
    return True




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

    # Within one Policy's serial evaluation chain, a prerequisite receives a
    # small bounded budget;
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
        lines.extend((f"flow tasklattice {phase} rails $text",))
        message_var = "$user_message" if phase == "input" else "$bot_message"
        lines.extend((f"  global {message_var}", f"  {message_var} = $text", "  $blocked = False"))
        native_by_capability = {
            _native_capability(flow): flow for flow in native_flows[phase]
        }
        binding_by_id = {item.id: item for item in phase_bindings}
        policy_order = {item.policy_id: index for index, item in enumerate(plan.policy_bindings)}
        entries = []
        for index, step in enumerate(plan.steps):
            if phase not in step.phases:
                continue
            binding = binding_by_id.get(step.id)
            policy_id = dict(step.parameters).get("policy_id") or (binding.policy_id if binding else None)
            rank = policy_order.get(policy_id, index)
            if binding is not None:
                entries.append((rank, index, "action", binding))
            elif step.capability in native_by_capability:
                entries.append((rank, index, "native", native_by_capability[step.capability]))
        for index, binding in enumerate(phase_custom):
            entries.append((policy_order.get(binding.policy_id, len(plan.steps) + index), index, "custom", binding))
        entries.sort(key=lambda item: item[:2])
        result_vars = {item.id: f"$tl_result_{_binding_suffix(item)}" for item in phase_bindings}
        for result_var in result_vars.values():
            lines.append(f'  {result_var} = {{"verdict": "skipped"}}')
        for _, _, kind, entry in entries:
            lines.append("  if not $blocked")
            if kind == "native":
                lines.extend("  " + line for line in _native_flow_lines(entry, phase))
            elif kind == "custom":
                lines.append(f"    await {_compiled_flow_name(entry)}(text=$text)")
            else:
                result_var = result_vars[entry.id]
                indent = "    "
                if entry.trigger.type != "always":
                    source = result_vars.get(entry.trigger.step_ref)
                    if source is None:
                        raise PlanCompilationError(f"Unavailable trigger step {entry.trigger.step_ref!r}.")
                    condition = " or ".join(f'{source}["verdict"] == "{verdict}"' for verdict in entry.trigger.verdicts)
                    lines.append(f"    if {condition}")
                    indent += "  "
                lines.append(f'{indent}{result_var} = await {entry.action_name}(text=$text, binding_id="{entry.id}")')
            lines.extend((
                f"    $decision = await {ACTION_RESOLVE}(text=$text)",
                '    $text = $decision["content"]',
                '    $blocked = $decision["blocked"]',
                f"    {message_var} = $text",
            ))
        lines.extend((f"  $decision = await {ACTION_RESOLVE}(text=$text)", ""))

    return "\n".join(lines).rstrip() + "\n"



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
    policy_id = dict(step.parameters).get("policy_id")
    policy_version = dict(step.parameters).get("policy_version")
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
        rule_order = selected.rule_order
        by_id = {f"flow/{rail.rail_type}/{rail.flow_name}": rail for rail in version.rail_bindings}
        if len(set(rule_order)) != len(rule_order) or set(rule_order) - by_id.keys():
            raise ValueError(f"Invalid Rule order for Policy {selected.policy_id}")
        ordered_rails = [by_id[rule_id] for rule_id in rule_order]
        ordered_rails.extend(rail for rule_id, rail in by_id.items() if rule_id not in rule_order)
        for rail in ordered_rails:
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
                    parameters=selected.parameter_values,
                    policy_id=version.policy_id,
                    policy_version=version.version,
                    flow_name=rail.flow_name,
                    action_name=action.name if action else None,
                    action_version=action.version if action else None,
                    parallel_group=None,
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
    positions = {item.flow_name: index for index, item in enumerate(bindings)}
    for binding in bindings:
        for dependency_name in binding.depends_on:
            dependency = by_name[dependency_name]
            if dependency.rail_type != binding.rail_type or positions[dependency_name] >= positions[binding.flow_name]:
                raise PlanCompilationError(
                    f"Policy {policy_id!r} Flow {binding.flow_name!r} must follow "
                    f"dependency {dependency_name!r} in the same Rail's list order."
                )



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
    return max((
        sum(module.timeout_ms for module in plan.modules_for(phase))
        + sum(item.timeout_ms for item in custom_bindings if phase in item.phases)
        for phase in ("input", "output")
    ), default=0)


def _validate_execution_order(plan: GuardrailPlanSnapshot) -> None:
    """Reject contradictory dependencies rather than silently reordering lists."""
    if len({step.id for step in plan.steps}) != len(plan.steps):
        raise PlanCompilationError("Ordered plan step IDs must be unique.")
    for phase in ("input", "output"):
        phase_steps = [step for step in plan.steps if phase in step.phases]
        positions = {step.id: index for index, step in enumerate(phase_steps)}
        for step in phase_steps:
            owners = [module for module in plan.modules_for(phase) if step.id in module.step_ids]
            if len(owners) != 1:
                raise PlanCompilationError(f"Step {step.id!r} must belong to exactly one {phase} Policy module.")
            source = step.trigger.step_ref
            if step.trigger.type != "always" and (source not in positions or positions[source] >= positions[step.id]):
                raise PlanCompilationError(f"Step {step.id!r} must follow trigger {source!r} in list order.")
        modules = {module.id: module for module in plan.modules_for(phase)}
        for module in modules.values():
            own_positions = [positions[item] for item in module.step_ids if item in positions]
            for dependency in module.depends_on:
                previous = modules.get(dependency)
                dependency_positions = [positions[item] for item in previous.step_ids if item in positions] if previous else []
                if not own_positions or not dependency_positions or max(dependency_positions) >= min(own_positions):
                    raise PlanCompilationError(f"Module {module.id!r} must follow dependency {dependency!r} in list order.")
