from __future__ import annotations

import asyncio
import difflib
import re
import time
from contextvars import ContextVar
from dataclasses import asdict, dataclass, replace
from typing import Any

from nemoguardrails import Guardrails
from nemoguardrails.rails.llm.options import GenerationResponse
from opentelemetry import context as otel_context, trace
from opentelemetry.trace import Status, StatusCode

from ..runtime.content_views import request_view, with_active_text
from ..runtime.contracts import (
    AppliedIntervention,
    ContentPatch,
    DecisionFragment,
    ENFORCEMENT_ACTIONS,
    ENFORCEMENT_ACTION_CONFLICT_ORDER,
    EngineRequest,
    ProtectionDecision,
    RuntimeTraceStep,
    RuntimeUsage,
    GuardrailPlanModule,
    GuardrailPlanSnapshot,
    ModuleAssessment,
    NeMoActionBinding,
    NeMoConfigSnapshot,
    ProviderEvidence,
    RiskFinding,
    RuntimeCoverage,
    flow_rule_id,
)
from .action_registry import (
    ACTION_CUSTOMER_IDENTIFIER,
    ACTION_EVALUATE,
    ACTION_RECORD_NATIVE,
    ACTION_RECORD_POLICY,
    ACTION_RESOLVE,
    ActionProviders,
)
from ..evaluation.contracts import CONTRACT_PII_EXACT
from .actions.contracts import ActionRequest, ActionResult, ModelCallUsage
from .actions.model_call import (
    ModelCallObserver,
    activate_native_model_observation,
    deactivate_native_model_observation,
)
from .artifacts import config_checksum
from .registry import NeMoRuntimeRegistry
from ..safety.taxonomy import taxonomy, taxonomy_for_evaluator


_CURRENT_SCOPE: ContextVar["_ExecutionScope | None"] = ContextVar(
    "tasklattice_nemo_execution_scope",
    default=None,
)
_TRACER = trace.get_tracer("tasklattice.guard-runner.actions")


@dataclass(slots=True)
class _RuntimeResult:
    binding: NeMoActionBinding
    result: ActionResult
    latency_ms: int
    provider_latency_ms: int = 0


@dataclass(slots=True)
class _ExecutionScope:
    request: EngineRequest
    profile: str
    results: list[_RuntimeResult]
    started_at: float
    c2_decision: dict[str, Any] | None = None
    closed: bool = False


class _PatchConflict(ValueError):
    pass


class NeMoActionBridge:
    """Bind version-pinned providers to official NeMo Python Actions."""

    def __init__(
        self,
        plan: GuardrailPlanSnapshot,
        config: NeMoConfigSnapshot,
        providers: ActionProviders,
    ) -> None:
        self._plan = plan
        self._config = config
        self._bindings = {item.id: item for item in config.action_bindings}
        self._providers = providers

    def register(self, rails: Guardrails) -> None:
        if self._config.runtime_profile == "llmrails_colang2_programmable":
            rails.register_action(
                self.record_native,
                name=ACTION_RECORD_NATIVE,
            )
            rails.register_action(
                self.resolve,
                name=ACTION_RESOLVE,
            )
            rails.register_action(
                self.customer_identifier,
                name=ACTION_CUSTOMER_IDENTIFIER,
            )
            rails.register_action(
                self.record_policy,
                name=ACTION_RECORD_POLICY,
            )
        for provider in self._providers.values():
            rails.register_action(
                self._action_handler(provider.name, provider.version),
                name=provider.name,
            )
        if "sensitive_data_detection" in self._config.required_features:
            # Keep NeMo's native sensitive-data flows while providing a small,
            # dependency-free detector with the product's existing semantics.
            rails.register_action(
                self.detect_sensitive_data,
                name=(
                    "DetectSensitiveDataAction"
                    if self._config.runtime_profile
                    == "llmrails_colang2_programmable"
                    else "detect_sensitive_data"
                ),
            )
            rails.register_action(
                self.mask_sensitive_data,
                name=(
                    "MaskSensitiveDataAction"
                    if self._config.runtime_profile
                    == "llmrails_colang2_programmable"
                    else "mask_sensitive_data"
                ),
            )

    def _action_handler(self, action_name: str, action_version: str):
        async def execute_provider(
            text: str,
            binding_id: str,
            context: dict[str, Any] | None = None,
        ) -> dict[str, Any]:
            return await self.execute_action(
                action_name,
                action_version,
                text,
                binding_id,
                context,
            )

        return execute_provider

    async def execute_action(
        self,
        action_name: str,
        action_version: str,
        text: str,
        binding_id: str,
        context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        binding = self._bindings.get(binding_id)
        if binding is None:
            missing = NeMoActionBinding(
                id=binding_id,
                capability="unknown",
                contract_ref="tali.guard.unknown.v1",
                phases=(self._request().phase,),
                on_unsafe="reject",
                action_name=action_name,
                action_version=action_version,
            )
            return self._record(
                context,
                missing,
                ActionResult(
                    "error",
                    text,
                    reason=f"NeMo action binding {binding_id!r} is unavailable.",
                ),
                0,
            )
        started = time.perf_counter()
        provider_latency_ms = 0
        request = self._request()
        module = self._module(binding)
        integration_id = (
            request.request_context.integration_id
            if request.request_context is not None
            else "__internal__"
        )
        with _TRACER.start_as_current_span(
            "guardrail.action",
            attributes={
                "guardrail.id": self._plan.guardrail_id,
                "guardrail.version": self._plan.guardrail_version,
                "guardrail.phase": request.phase,
                "guardrail.action": action_name,
                "guardrail.action.version": action_version,
                "guardrail.action.binding_id": binding.id,
                "guardrail.module.id": module.id if module is not None else "__unmapped__",
                "guardrail.evaluation.contract": binding.contract_ref,
                "guardrail.capability": binding.capability,
                "guardrail.policy.id": binding.policy_id or "__none__",
                "guardrail.action.timeout_ms": binding.timeout_ms,
                "integration.id": integration_id or "__internal__",
            },
        ) as span:
            try:
                provider = self._providers[(action_name, action_version)]
                supported_capabilities = getattr(
                    provider, "capabilities", frozenset()
                )
                supported_rails = getattr(provider, "rails", frozenset())
                if (
                    supported_capabilities
                    and binding.capability not in supported_capabilities
                ):
                    raise LookupError("provider does not support the pinned Policy")
                if supported_rails and request.phase not in supported_rails:
                    raise LookupError("provider does not support the active Rail")
                action_request = self._action_request(text, binding)
                async with asyncio.timeout(binding.timeout_ms / 1_000):
                    action_result = await provider.execute(action_request)
                result = (
                    replace(action_result, reason=action_result.evidence)
                    if action_result.reason is None and action_result.evidence
                    else action_result
                )
                provider_latency_ms = action_result.usage.provider_latency_ms
            except asyncio.CancelledError:
                raise
            except TimeoutError:
                result = ActionResult(
                    "error",
                    text,
                    reason=(
                        f"NeMo Action {action_name}@{action_version} hit its "
                        f"{binding.timeout_ms} ms timeout deadline."
                    ),
                )
            except Exception as error:
                # Do not include provider messages, responses, credentials, or
                # model content in production errors.
                result = ActionResult(
                    "error",
                    text,
                    reason=(
                        f"NeMo Action {action_name}@{action_version} failed with "
                        f"{type(error).__name__}."
                    ),
                )
            latency = max(0, round((time.perf_counter() - started) * 1_000))
            model_calls = result.usage.model_calls
            action_result_name = (
                "timeout"
                if result.verdict == "error"
                and "timeout" in (result.reason or "").casefold()
                else result.verdict
            )
            span.set_attributes({
                "guardrail.action.result": action_result_name,
                "guardrail.action.duration_ms": latency,
                "guardrail.action.provider_work_ms": sum(
                    call.duration_ms for call in model_calls
                ),
                "guardrail.action.model_wait_ms": _model_calls_wall_ms(model_calls),
                "guardrail.action.failure_mode": (
                    "fail_closed" if self._fails_closed(binding) else "fail_open"
                ),
            })
            if result.verdict == "error":
                span.set_status(Status(StatusCode.ERROR, action_result_name))
            return self._record(
                context,
                binding,
                result,
                latency,
                provider_latency_ms=provider_latency_ms,
            )

    async def detect_sensitive_data(
        self,
        source: str,
        text: str,
        context: dict[str, Any] | None = None,
        **_: Any,
    ) -> bool:
        result, binding, latency = await self._pii(text)
        self._record(context, binding, result, latency)
        return result.verdict == "unsafe"

    async def mask_sensitive_data(
        self,
        source: str,
        text: str,
        context: dict[str, Any] | None = None,
        **_: Any,
    ) -> str:
        result, binding, latency = await self._pii(text)
        self._record(context, binding, result, latency)
        return result.content if result.verdict == "unsafe" else text

    async def resolve(
        self,
        text: str,
        context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        resolve_started = time.perf_counter()
        runtime_results = self._ordered_results()
        terminal_by_policy: dict[tuple[str, ...], _RuntimeResult] = {}
        for item in runtime_results:
            terminal_by_policy[_result_group_key(item)] = item
        decision_results = tuple(terminal_by_policy.values())
        unsafe = tuple(item for item in decision_results if item.result.verdict == "unsafe")
        errors = tuple(item for item in decision_results if item.result.verdict == "error")
        closed_errors = tuple(
            item for item in errors if self._fails_closed(item.binding)
        )
        uncertain = tuple(
            item for item in decision_results if item.result.verdict == "uncertain"
        )
        actions = [_runtime_action(item) for item in unsafe]
        if closed_errors:
            action = "reject"
            reason = (
                closed_errors[0].result.reason
                or "A required NeMo Action failed closed."
            )
        elif actions:
            action = next(
                value
                for value in ENFORCEMENT_ACTION_CONFLICT_ORDER
                if value in set(actions)
            )
            reason = next(
                (
                    item.result.reason
                    for item in unsafe
                    if item.binding.on_unsafe == action and item.result.reason
                ),
                unsafe[0].result.reason,
            )
        elif uncertain:
            action = "clarify"
            reason = uncertain[0].result.reason or "More context is required."
        else:
            action = "pass"
            reason = "All NeMo Actions passed."

        request = self._request()
        try:
            resolved = _resolved_content(request.text, action, unsafe)
        except _PatchConflict as error:
            action = "reject"
            reason = str(error)
            resolved = request.text
        enforce = request.mode == "enforce"
        blocked = enforce and action == "reject"
        modified = enforce and action not in {"pass", "reject"}
        payload = {
            "decision": "block" if blocked else "transform" if modified else "allow",
            "action": action if enforce else "pass",
            "proposed_action": action,
            "blocked": blocked,
            "modified": modified,
            "content": resolved if modified else text,
            "reason": reason,
            "_resolve_latency_ms": max(
                0, round((time.perf_counter() - resolve_started) * 1_000)
            ),
        }
        if context is not None:
            context["tasklattice_decision"] = payload
        scope = _execution_scope()
        if scope.profile == "llmrails_colang2_programmable":
            scope.c2_decision = dict(payload)
        return payload

    async def record_native(
        self,
        risk: str,
        safe: bool,
        text: str,
        details: Any = None,
        context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Normalize a NeMo-native Action result into product telemetry."""
        request = self._request()
        step = next(
            (
                item
                for item in self._plan.steps
                if item.capability == risk and request.phase in item.phases
            ),
            None,
        )
        binding = NeMoActionBinding(
            id=step.id if step is not None else f"{risk}:nemo-native",
            capability=risk,
            contract_ref=(
                step.contract_ref
                if step is not None
                else f"tali.guard.{risk.replace('_', '-')}.native.v1"
            ),
            phases=(request.phase,),
            on_unsafe=step.on_unsafe if step is not None else "reject",
            parameters=step.parameters if step is not None else (),
        )
        reason = (
            f"NeMo native {risk.replace('_', ' ')} Action passed."
            if safe
            else _native_reason(risk, details)
        )
        findings = () if safe else (
            RiskFinding(
                risk=risk,
                taxonomy_id=taxonomy_for_evaluator(risk),
                verdict="unsafe",
                confidence=None,
                evidence=reason,
                recommended_action=binding.on_unsafe,
            ),
        )
        result = ActionResult(
            "safe" if safe else "unsafe",
            text,
            findings=findings,
            reason=reason,
        )
        return self._record(context, binding, result, 0)

    async def customer_identifier(
        self,
        text: str,
        context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Reference catalog Action used by the custom-Policy validation slice."""
        patterns = (
            re.compile(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b"),
            re.compile(r"(?i)\b(?:customer|cust)[-_ ]?id[:# ]*[A-Z0-9-]{4,}\b"),
        )
        redacted = text
        detected = False
        for pattern in patterns:
            redacted, count = pattern.subn("[CUSTOMER_IDENTIFIER]", redacted)
            detected = detected or count > 0
        return {"detected": detected, "redacted": redacted}

    async def record_policy(
        self,
        flow_name: str,
        safe: bool,
        text: str,
        replacement: str | None = None,
        context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        request = self._request()
        binding = next(
            (
                item
                for item in self._config.action_bindings
                if item.policy_id is not None
                and (
                    item.flow_name == flow_name
                    or _compiled_policy_flow_name(item) == flow_name
                )
                and request.phase in item.phases
            ),
            None,
        )
        if binding is None:
            binding = NeMoActionBinding(
                id=f"unknown-policy-flow:{flow_name}",
                capability="unknown_policy",
                contract_ref="tali.guard.unknown-policy.v1",
                phases=(request.phase,),
                on_unsafe="reject",
            )
            result = ActionResult(
                "error",
                text,
                reason=f"Policy Flow {flow_name!r} has no immutable Rail binding.",
            )
            return self._record(context, binding, result, 0)
        reason = (
            f"Policy {binding.policy_id}@{binding.policy_version} "
            f"flow {binding.flow_name} passed."
            if safe
            else f"Policy {binding.policy_id}@{binding.policy_version} detected customer data."
        )
        findings = () if safe else (
            RiskFinding(
                risk=binding.capability,
                taxonomy_id=taxonomy_for_evaluator(binding.capability),
                verdict="unsafe",
                confidence=1.0,
                evidence=reason,
                recommended_action=binding.on_unsafe,
                replacement=replacement,
            ),
        )
        result = ActionResult(
            "safe" if safe else "unsafe",
            replacement if not safe and replacement is not None else text,
            findings=findings,
            reason=reason,
        )
        return self._record(context, binding, result, 0)

    async def _pii(
        self,
        text: str,
    ) -> tuple[ActionResult, NeMoActionBinding, int]:
        request = self._request()
        phase = request.phase
        plan_step = next(
            (
                step
                for step in self._plan.steps
                if step.capability == "pii"
                and step.contract_ref == CONTRACT_PII_EXACT
                and phase in step.phases
            ),
            None,
        )
        binding = NeMoActionBinding(
            id=(
                plan_step.id
                if plan_step is not None
                else "pii:native-sensitive-data"
            ),
            capability="pii",
            contract_ref=CONTRACT_PII_EXACT,
            phases=(phase,),
            on_unsafe=plan_step.on_unsafe if plan_step is not None else "redact",
            timeout_ms=750,
            parameters=plan_step.parameters if plan_step is not None else (),
            action_name=ACTION_EVALUATE,
            action_version="1.0.0",
        )
        started = time.perf_counter()
        if plan_step is None or (ACTION_EVALUATE, "1.0.0") not in self._providers:
            result = ActionResult("error", text, reason="PII action is unavailable.")
        else:
            try:
                async with asyncio.timeout(binding.timeout_ms / 1_000):
                    result = await self._providers[(ACTION_EVALUATE, "1.0.0")].execute(
                        self._action_request(text, binding)
                    )
            except asyncio.CancelledError:
                raise
            except Exception as error:
                result = ActionResult(
                    "error",
                    text,
                    reason=f"PII action failed with {type(error).__name__}.",
                )
        return result, binding, max(0, round((time.perf_counter() - started) * 1_000))

    def _ordered_results(self) -> tuple[_RuntimeResult, ...]:
        return _ordered_runtime_results(self._plan, _runtime_results())

    def _engine_request(
        self,
        text: str,
        binding: NeMoActionBinding | None = None,
    ) -> EngineRequest:
        request = self._request()
        content = text
        view = request_view(request)
        module = self._module(binding) if binding is not None else None
        if module is not None and module.input_view == "masked":
            redactions = tuple(
                item
                for item in self._ordered_results()
                if item.result.verdict == "unsafe"
                and _runtime_action(item) == "redact"
            )
            content = _resolved_content(request.text, "redact", redactions)
            view = with_active_text(
                request_view(request),
                content,
                kind="masked",
            )
        return EngineRequest(
            phase=request.phase,
            text=content,
            plan=self._plan,
            context_messages=request.context_messages,
            trusted_instruction=request.trusted_instruction,
            target_source=request.target_source,
            mode=request.mode,
            evidence_scope=request.evidence_scope,
            content_view=view,
            active_block_id=request.active_block_id,
            request_context=request.request_context,
        )

    def _action_request(
        self,
        text: str,
        binding: NeMoActionBinding,
    ) -> ActionRequest:
        prepared = self._engine_request(text, binding)
        view = request_view(prepared)
        return ActionRequest(
            content=prepared.text,
            rail_type=prepared.phase,
            guardrail_id=self._plan.guardrail_id,
            guardrail_version=self._plan.guardrail_version,
            policy_id=binding.policy_id,
            policy_version=binding.policy_version,
            trusted_context=(
                ("trusted_instruction", prepared.trusted_instruction),
            ),
            content_blocks=view.blocks,
            deadline=time.monotonic() + binding.timeout_ms / 1_000,
            parameters=binding.parameters,
            capability=binding.capability,
            proposed_action=binding.on_unsafe,
            plan=self._plan,
            binding=binding,
            context_messages=prepared.context_messages,
            target_source=prepared.target_source,
            mode=prepared.mode,
            evidence_scope=prepared.evidence_scope,
            content_view=view,
            active_block_id=prepared.active_block_id,
            request_context=prepared.request_context,
            request_started_at=_execution_scope().started_at,
        )

    def _module(
        self,
        binding: NeMoActionBinding | None,
    ) -> GuardrailPlanModule | None:
        if binding is None:
            return None
        return next(
            (
                module
                for module in self._plan.modules_for(self._request().phase)
                if binding.id in module.step_ids
            ),
            None,
        )

    def _fails_closed(self, binding: NeMoActionBinding) -> bool:
        if binding.policy_id is not None:
            return binding.failure_mode == "fail_closed"
        module = self._module(binding)
        return (
            module is None
            or module.required_for_release and module.failure_mode == "fail_closed"
        )

    @staticmethod
    def _request() -> EngineRequest:
        return _execution_scope().request

    def _record(
        self,
        context: dict[str, Any] | None,
        binding: NeMoActionBinding,
        result: ActionResult,
        latency_ms: int,
        provider_latency_ms: int | None = None,
    ) -> dict[str, Any]:
        policy_id, rule_id = _binding_policy_rule_identity(
            self._plan,
            binding,
            self._request().phase,
        )
        if policy_id is not None and rule_id is not None and result.findings:
            result = replace(
                result,
                findings=tuple(
                    replace(finding, policy_id=policy_id, rule_id=rule_id)
                    for finding in result.findings
                ),
            )
        runtime_result = _RuntimeResult(
            binding,
            result,
            latency_ms,
            0 if provider_latency_ms is None else provider_latency_ms,
        )
        scope = _execution_scope()
        if scope.profile == "llmrails_colang2_programmable":
            scope.results.append(runtime_result)
        if context is not None and scope.profile == "llmrails_colang2_programmable":
            context.setdefault("tasklattice_action_results", []).append(
                {
                    "step_id": binding.id,
                    "capability": binding.capability,
                    "contract_ref": binding.contract_ref,
                    "verdict": result.verdict,
                    "action": binding.on_unsafe,
                    "latency_ms": latency_ms,
                    "provider_latency_ms": runtime_result.provider_latency_ms,
                }
            )
        proposed_action = (
            "reject" if result.verdict == "error" and self._fails_closed(binding)
            else "pass" if result.verdict in {"safe", "error"}
            else "clarify" if result.verdict == "uncertain"
            else _runtime_action(runtime_result)
        )
        enforce = scope.request.mode == "enforce"
        blocked = enforce and proposed_action == "reject"
        modified = enforce and proposed_action not in {"pass", "reject"}
        content = result.content
        if modified and content == scope.request.text:
            try:
                content = _resolved_content(
                    scope.request.text,
                    proposed_action,
                    (runtime_result,) if result.verdict == "unsafe" else (),
                )
            except _PatchConflict:
                proposed_action = "reject"
                blocked = True
                modified = False
                content = scope.request.text
        decision = "block" if blocked else "transform" if modified else "allow"
        return {
            "step_id": binding.id,
            "capability": binding.capability,
            "contract_ref": binding.contract_ref,
            "verdict": result.verdict,
            "content": content,
            "reason": result.reason,
            "decision": decision,
            "action": proposed_action if enforce else "pass",
            "proposed_action": proposed_action,
            "blocked": blocked,
            "modified": modified,
            "findings": [asdict(item) for item in result.findings],
            "failure_mode": (
                "fail_closed" if self._fails_closed(binding) else "fail_open"
            ),
            "latency_ms": latency_ms,
            "provider_latency_ms": runtime_result.provider_latency_ms,
        }


class NeMoRuntime:
    """Run every production Guardrail decision through a version-pinned NeMo runtime."""

    name = "nemo-guardrails"
    supported_phases = frozenset({"input", "output"})

    def __init__(
        self,
        registry: NeMoRuntimeRegistry,
        *,
        model_call_observer: ModelCallObserver | None = None,
    ) -> None:
        self._registry = registry
        self._model_call_observer = model_call_observer

    async def evaluate(self, request: EngineRequest) -> ProtectionDecision:
        instance, cache_hit, registry_queue_latency_ms = self._registry.acquire(
            request.plan
        )
        profile = instance.config.runtime_profile
        started = time.perf_counter()
        scope = _ExecutionScope(request, profile, [], started)
        token = _CURRENT_SCOPE.set(scope)
        request_context = request.request_context
        native_model_scope, native_model_token = activate_native_model_observation(
            guardrail_id=request.plan.guardrail_id,
            integration_id=(
                request_context.integration_id
                if request_context is not None and request_context.integration_id
                else "__internal__"
            ),
            phase=request.phase,
            request_started_at=started,
            observer=self._model_call_observer,
        )
        queue_started = started
        queue_latency_ms = registry_queue_latency_ms
        admitted = False
        waiting = False
        active_concurrency = 0
        response: GenerationResponse | None = None
        runtime_results: tuple[_RuntimeResult, ...] = ()
        custom_decision: dict[str, Any] | None = None
        runtime_span = None
        runtime_context_token = None
        try:
            async with asyncio.timeout(_request_timeout_ms(request) / 1_000):
                instance.waiting_requests += 1
                waiting = True
                with _TRACER.start_as_current_span(
                    "guardrail.queue_wait",
                    attributes={
                        "guardrail.id": request.plan.guardrail_id,
                        "guardrail.version": request.plan.guardrail_version,
                        "guardrail.phase": request.phase,
                        "guardrail.runtime.profile": profile,
                    },
                ) as queue_span:
                    await instance.admission.acquire()
                    queue_span.set_attribute(
                        "guardrail.queue.duration_ms",
                        max(0, round((time.perf_counter() - queue_started) * 1_000)),
                    )
                instance.waiting_requests = max(0, instance.waiting_requests - 1)
                waiting = False
                admitted = True
                instance.active_requests += 1
                active_concurrency = instance.active_requests
                queue_latency_ms += max(
                    0, round((time.perf_counter() - queue_started) * 1_000)
                )
                runtime_started = time.perf_counter()
                runtime_span = _TRACER.start_span(
                    "guardrail.runtime",
                    attributes={
                        "guardrail.id": request.plan.guardrail_id,
                        "guardrail.version": request.plan.guardrail_version,
                        "guardrail.phase": request.phase,
                        "guardrail.runtime.engine": instance.config.runtime_engine,
                        "guardrail.runtime.profile": profile,
                        "guardrail.runtime.cache_hit": cache_hit,
                    },
                )
                runtime_context_token = otel_context.attach(
                    trace.set_span_in_context(runtime_span)
                )
                if profile == "iorails_native":
                    # NeMo 0.23 IORails has no public rails-only/check API.  It
                    # owns main-model generation and returns no structured rail
                    # verdict, so it must never be guessed into this standalone
                    # pre/post validation contract.
                    raise RuntimeError(
                        "iorails_native requires a NeMo-owned generation endpoint"
                    )
                if profile == "llmrails_colang1_standard":
                    candidate = await instance.rails.generate_async(
                        messages=_colang1_messages(request),
                        options={
                            "rails": [request.phase],
                            "output_vars": [
                                *(
                                    binding.result_var
                                    for binding in instance.config.bindings_for(
                                        request.phase
                                    )
                                    if binding.result_var
                                ),
                                (
                                    "user_message"
                                    if request.phase == "input"
                                    else "bot_message"
                                ),
                            ],
                            # Aggregate call counts remain available in
                            # log.stats; raw model prompts/completions stay off.
                            "log": {
                                "activated_rails": True,
                                "llm_calls": False,
                            },
                        },
                    )
                    _raise_if_cancelled()
                    response = _generation_response(candidate)
                    runtime_results, action_payloads = _colang1_results(
                        request,
                        instance.config,
                        response,
                    )
                    custom_decision = _colang1_decision(
                        request,
                        instance.config,
                        response,
                        runtime_results,
                        action_payloads,
                    )
                elif profile == "llmrails_colang2_programmable":
                    response = await instance.rails.generate_async(
                        messages=_programmable_messages(request),
                        options={
                            "rails": {
                                "input": False,
                                "dialog": False,
                                "retrieval": False,
                                "output": False,
                                "tool_input": False,
                                "tool_output": False,
                            },
                        },
                    )
                    _raise_if_cancelled()
                    response = _generation_response(response)
                    runtime_results = _ordered_runtime_results(
                        request.plan, tuple(scope.results)
                    )
                    custom_decision = scope.c2_decision
                    if custom_decision is None:
                        raise RuntimeError(
                            "The Colang 2 policy completed without a decision."
                        )
                else:
                    raise RuntimeError(f"Unknown NeMo runtime profile {profile!r}.")
                runtime_span.set_attributes({
                    "guardrail.runtime.result": "success",
                    "guardrail.runtime.duration_ms": max(
                        0, round((time.perf_counter() - runtime_started) * 1_000)
                    ),
                    "guardrail.runtime.action_count": len(runtime_results),
                })
        except Exception as error:
            if runtime_span is not None:
                runtime_span.record_exception(error)
                runtime_span.set_status(Status(StatusCode.ERROR, type(error).__name__))
                runtime_span.set_attribute("guardrail.runtime.result", "error")
            duration = max(0, round((time.perf_counter() - started) * 1_000))
            if not admitted:
                queue_latency_ms += duration
            return _failed_decision(
                request,
                error,
                duration,
                instance.config,
                cache_hit=cache_hit,
                queue_latency_ms=queue_latency_ms,
                active_concurrency=active_concurrency,
                native_model_calls=tuple(native_model_scope.calls),
            )
        finally:
            if runtime_context_token is not None:
                otel_context.detach(runtime_context_token)
            if runtime_span is not None:
                runtime_span.end()
            if waiting:
                instance.waiting_requests = max(0, instance.waiting_requests - 1)
            if admitted:
                instance.active_requests = max(0, instance.active_requests - 1)
                instance.admission.release()
            scope.closed = True
            _CURRENT_SCOPE.reset(token)
            deactivate_native_model_observation(native_model_token)
        if response is None:
            return _failed_decision(
                request,
                RuntimeError("NeMo invocation completed without a response."),
                max(0, round((time.perf_counter() - started) * 1_000)),
                instance.config,
                cache_hit=cache_hit,
                queue_latency_ms=queue_latency_ms,
                active_concurrency=active_concurrency,
                native_model_calls=tuple(native_model_scope.calls),
            )
        try:
            return _decision(
                request,
                response,
                instance.config,
                runtime_results,
                custom_decision=custom_decision,
                cache_hit=cache_hit,
                queue_latency_ms=queue_latency_ms,
                active_concurrency=active_concurrency,
                native_model_calls=tuple(native_model_scope.calls),
            )
        except Exception as error:
            return _failed_decision(
                request,
                error,
                max(0, round((time.perf_counter() - started) * 1_000)),
                instance.config,
                cache_hit=cache_hit,
                queue_latency_ms=queue_latency_ms,
                active_concurrency=active_concurrency,
                native_model_calls=tuple(native_model_scope.calls),
            )

    async def shutdown(self) -> None:
        await self._registry.shutdown()

    def ready(self) -> bool:
        return self._registry.ready()

    def readiness(self) -> dict[str, object]:
        return self._registry.readiness()


def _execution_scope() -> _ExecutionScope:
    scope = _CURRENT_SCOPE.get()
    if scope is None or scope.closed:
        raise RuntimeError("A NeMo Action ran outside an active Guardrail request.")
    return scope


def _runtime_results() -> tuple[_RuntimeResult, ...]:
    return tuple(_execution_scope().results)


def _ordered_runtime_results(
    plan: GuardrailPlanSnapshot,
    results: tuple[_RuntimeResult, ...],
) -> tuple[_RuntimeResult, ...]:
    order = {step.id: index for index, step in enumerate(plan.steps)}
    return tuple(sorted(
        results,
        key=lambda item: (
            order.get(item.binding.id, len(order)),
            item.binding.id,
        ),
    ))


def _messages(request: EngineRequest) -> list[dict[str, Any]]:
    context = {
        "tasklattice_action_results": [],
        "tasklattice_guardrail_id": request.plan.guardrail_id,
        "tasklattice_guardrail_version": request.plan.guardrail_version,
        "tasklattice_phase": request.phase,
    }
    messages: list[dict[str, Any]] = [{"role": "context", "content": context}]
    messages.extend(
        {
            "role": str(item.get("role")),
            "content": str(item.get("content", "")),
        }
        for item in request.context_messages
        if item.get("role") in {"system", "user", "assistant"}
        and isinstance(item.get("content"), str)
    )
    role = "user" if request.phase == "input" else "assistant"
    if messages and messages[-1].get("role") == role:
        messages[-1] = {"role": role, "content": request.text}
    else:
        messages.append({"role": role, "content": request.text})
    return messages


def _colang1_messages(request: EngineRequest) -> list[dict[str, Any]]:
    messages = _messages(request)
    if request.phase == "output" and not any(
        item.get("role") == "user" for item in messages
    ):
        # This is the exact normalization used by NeMo 0.23 check_async for an
        # assistant-only output check.  We call generate_async directly because
        # the enterprise DTO also needs output_vars and the structured log.
        assistant_index = next(
            (
                index
                for index in range(len(messages) - 1, -1, -1)
                if messages[index].get("role") == "assistant"
            ),
            len(messages),
        )
        messages.insert(assistant_index, {"role": "user", "content": ""})
    return messages


def _programmable_messages(request: EngineRequest) -> list[dict[str, Any]]:
    """Drive the Colang 2.x main flow without replaying prior user events."""
    return [
        {
            "role": "context",
            "content": {
                "tasklattice_guardrail_id": request.plan.guardrail_id,
                "tasklattice_guardrail_version": request.plan.guardrail_version,
                "tasklattice_phase": request.phase,
            },
        },
        {"role": "user", "content": request.text},
    ]


def _generation_response(value: Any) -> GenerationResponse:
    if not isinstance(value, GenerationResponse):
        raise RuntimeError(f"Unexpected NeMo response {type(value).__name__}.")
    return value


def _raise_if_cancelled() -> None:
    # NeMo 0.23's Colang 1 runner can translate a cancelled Action into a
    # completed flow. Preserve the caller's cancellation contract at the API
    # boundary instead of turning cancellation into a fail-closed verdict.
    task = asyncio.current_task()
    if task is not None and task.cancelling():
        raise asyncio.CancelledError


def _activated_rails(response: GenerationResponse) -> tuple[Any, ...]:
    return tuple(response.log.activated_rails or ()) if response.log else ()


def _colang1_results(
    request: EngineRequest,
    config: NeMoConfigSnapshot,
    response: GenerationResponse,
) -> tuple[tuple[_RuntimeResult, ...], tuple[dict[str, Any], ...]]:
    bindings = config.bindings_for(request.phase)
    raw_by_id: dict[str, dict[str, Any]] = {}
    output_data = response.output_data or {}
    if not isinstance(output_data, dict):
        raise RuntimeError("NeMo Colang 1 output_data must be a mapping.")

    for binding in bindings:
        if not binding.result_var:
            raise RuntimeError(
                f"Colang 1 binding {binding.id!r} has no explicit result variable."
            )
        raw = output_data.get(binding.result_var)
        if isinstance(raw, dict):
            raw_by_id[binding.id] = raw

    # A stopping parallel rail can cancel sibling flows before their output
    # variables are copied.  The official generation log still carries the
    # executed Action's return value, so use it only as a same-call fallback.
    for rail in _activated_rails(response):
        for action in rail.executed_actions:
            raw = action.return_value
            if isinstance(raw, dict) and isinstance(raw.get("step_id"), str):
                raw_by_id.setdefault(str(raw["step_id"]), raw)

    binding_by_id = {item.id: item for item in bindings}
    unknown = set(raw_by_id) - set(binding_by_id)
    if unknown:
        raise RuntimeError(
            "NeMo Colang 1 returned results for unknown bindings: "
            + ", ".join(sorted(unknown))
            + "."
        )

    parsed = tuple(
        _colang1_runtime_result(binding_by_id[binding_id], raw)
        for binding_id, raw in raw_by_id.items()
    )
    ordered = _ordered_runtime_results(request.plan, parsed)
    payload_by_id = {
        str(item.get("step_id")): item for item in raw_by_id.values()
    }
    payloads = tuple(
        payload_by_id[item.binding.id]
        for item in ordered
    )

    stopping = any(rail.stop for rail in _activated_rails(response))
    if bindings and not stopping and len(ordered) != len(bindings):
        missing = sorted(set(binding_by_id) - set(raw_by_id))
        raise RuntimeError(
            "NeMo Colang 1 completed without explicit Action results for: "
            + ", ".join(missing)
            + "."
        )
    return ordered, payloads


def _colang1_runtime_result(
    binding: NeMoActionBinding,
    payload: dict[str, Any],
) -> _RuntimeResult:
    if payload.get("step_id") != binding.id:
        raise RuntimeError(
            f"NeMo Action result does not match binding {binding.id!r}."
        )
    if (
        payload.get("capability") != binding.capability
        or payload.get("contract_ref") != binding.contract_ref
    ):
        raise RuntimeError(
            f"NeMo Action result metadata does not match binding {binding.id!r}."
        )
    verdict = str(payload.get("verdict", ""))
    if verdict not in {"safe", "unsafe", "uncertain", "error"}:
        raise RuntimeError(f"NeMo Action {binding.id!r} returned an invalid verdict.")
    content = payload.get("content")
    if not isinstance(content, str):
        raise RuntimeError(f"NeMo Action {binding.id!r} returned invalid content.")
    blocked = payload.get("blocked")
    modified = payload.get("modified")
    if not isinstance(blocked, bool) or not isinstance(modified, bool) or (
        blocked and modified
    ):
        raise RuntimeError(
            f"NeMo Action {binding.id!r} returned invalid policy-effect flags."
        )
    expected_decision = "block" if blocked else "transform" if modified else "allow"
    if payload.get("decision") != expected_decision:
        raise RuntimeError(
            f"NeMo Action {binding.id!r} returned an inconsistent decision."
        )
    action = str(payload.get("action", ""))
    if action not in ENFORCEMENT_ACTIONS:
        raise RuntimeError(f"NeMo Action {binding.id!r} returned an invalid action.")
    findings_raw = payload.get("findings", [])
    if not isinstance(findings_raw, list):
        raise RuntimeError(f"NeMo Action {binding.id!r} returned invalid findings.")
    findings = tuple(
        _risk_finding_from_payload(binding, item) for item in findings_raw
    )
    latency_ms = _non_negative_int(payload.get("latency_ms", 0))
    provider_latency_ms = _non_negative_int(
        payload.get("provider_latency_ms", latency_ms)
    )
    return _RuntimeResult(
        binding=binding,
        result=ActionResult(
            verdict=verdict,  # type: ignore[arg-type]
            content=content,
            findings=findings,
            reason=(
                str(payload["reason"])
                if payload.get("reason") is not None
                else None
            ),
        ),
        latency_ms=latency_ms,
        provider_latency_ms=provider_latency_ms,
    )


def _risk_finding_from_payload(
    binding: NeMoActionBinding,
    payload: Any,
) -> RiskFinding:
    if not isinstance(payload, dict):
        raise RuntimeError(f"NeMo Action {binding.id!r} returned an invalid finding.")
    verdict = str(payload.get("verdict", ""))
    action = str(payload.get("recommended_action", ""))
    if verdict not in {"safe", "unsafe", "uncertain", "error"}:
        raise RuntimeError(f"NeMo Action {binding.id!r} returned an invalid finding verdict.")
    if action not in ENFORCEMENT_ACTIONS:
        raise RuntimeError(f"NeMo Action {binding.id!r} returned an invalid finding action.")
    taxonomy_id = payload.get("taxonomy_id")
    if not isinstance(taxonomy_id, str) or not taxonomy().contains(taxonomy_id):
        raise RuntimeError(
            f"NeMo Action {binding.id!r} returned an invalid TALI Taxonomy ID."
        )
    raw_confidence = payload.get("confidence")
    confidence: float | None = None
    if raw_confidence is not None:
        try:
            confidence = float(raw_confidence)
        except (TypeError, ValueError) as error:
            raise RuntimeError(
                f"NeMo Action {binding.id!r} returned invalid finding confidence."
            ) from error
        if not 0 <= confidence <= 1:
            raise RuntimeError(
                f"NeMo Action {binding.id!r} returned out-of-range finding confidence."
            )
    replacement = payload.get("replacement")
    if replacement is not None and not isinstance(replacement, str):
        raise RuntimeError(
            f"NeMo Action {binding.id!r} returned an invalid replacement."
        )
    policy_id = payload.get("policy_id")
    rule_id = payload.get("rule_id")
    if policy_id is not None and not isinstance(policy_id, str):
        raise RuntimeError(
            f"NeMo Action {binding.id!r} returned an invalid Policy identity."
        )
    if rule_id is not None and not isinstance(rule_id, str):
        raise RuntimeError(
            f"NeMo Action {binding.id!r} returned an invalid Rule identity."
        )
    provider_evidence_raw = payload.get("provider_evidence", [])
    if not isinstance(provider_evidence_raw, (list, tuple)):
        raise RuntimeError(
            f"NeMo Action {binding.id!r} returned invalid Provider evidence."
        )
    provider_evidence: list[ProviderEvidence] = []
    for item in provider_evidence_raw:
        if not isinstance(item, dict):
            raise RuntimeError(
                f"NeMo Action {binding.id!r} returned invalid Provider evidence."
            )
        required = (item.get("provider_id"), item.get("model"), item.get("native_verdict"))
        if not all(isinstance(value, str) and value for value in required):
            raise RuntimeError(
                f"NeMo Action {binding.id!r} returned incomplete Provider evidence."
            )
        native_category = item.get("native_category")
        mapping_quality = item.get("mapping_quality")
        if native_category is not None and not isinstance(native_category, str):
            raise RuntimeError(
                f"NeMo Action {binding.id!r} returned invalid native category evidence."
            )
        if mapping_quality is not None and not isinstance(mapping_quality, str):
            raise RuntimeError(
                f"NeMo Action {binding.id!r} returned invalid mapping-quality evidence."
            )
        provider_evidence.append(
            ProviderEvidence(
                provider_id=required[0],
                model=required[1],
                native_verdict=required[2],
                native_category=native_category,
                mapping_quality=mapping_quality,
            )
        )
    return RiskFinding(
        # The immutable binding, not Action-supplied telemetry, owns the risk
        # identity used by policy aggregation and enterprise audit.
        risk=binding.capability,
        taxonomy_id=taxonomy_id,
        verdict=verdict,  # type: ignore[arg-type]
        confidence=confidence,
        evidence=str(payload.get("evidence", "")),
        recommended_action=action,  # type: ignore[arg-type]
        replacement=replacement,
        policy_id=policy_id,
        rule_id=rule_id,
        provider_evidence=tuple(provider_evidence),
    )


def _non_negative_int(value: Any) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError) as error:
        raise RuntimeError("NeMo Action timing metadata is invalid.") from error


def _colang1_decision(
    request: EngineRequest,
    config: NeMoConfigSnapshot,
    response: GenerationResponse,
    runtime_results: tuple[_RuntimeResult, ...],
    payloads: tuple[dict[str, Any], ...],
) -> dict[str, Any]:
    # Runtime results are consumed downstream for audit/usage. The NeMo rail
    # response and explicit Action payloads are the policy-effect authorities.
    del runtime_results
    activated = _activated_rails(response)
    stopping = next((rail for rail in activated if rail.stop), None)
    result_content = _response_content(response, request.text)

    if request.mode == "detect":
        return {
            "decision": "allow",
            "action": "pass",
            "proposed_action": _strongest(
                tuple(str(item.get("proposed_action", "pass")) for item in payloads)
            ),
            "blocked": False,
            "modified": False,
            "content": request.text,
            "reason": "NeMo Guardrails completed in detection-only mode.",
        }

    blocked_payloads = tuple(item for item in payloads if item.get("blocked") is True)
    modified_payloads = tuple(item for item in payloads if item.get("modified") is True)
    if stopping is not None:
        if config.bindings_for(request.phase) and not blocked_payloads:
            raise RuntimeError(
                "A Colang 1 rail stopped without an explicit blocking Action result."
            )
        selected = blocked_payloads[0] if blocked_payloads else None
        return {
            "decision": "block",
            "action": "reject",
            "proposed_action": (
                str(selected.get("proposed_action", "reject"))
                if selected is not None
                else "reject"
            ),
            "blocked": True,
            "modified": False,
            "content": request.text,
            "reason": (
                str(selected.get("reason") or f"NeMo rail {stopping.name} blocked the interaction.")
                if selected is not None
                else f"NeMo rail {stopping.name} blocked the interaction."
            ),
        }
    if blocked_payloads:
        raise RuntimeError(
            "A Colang 1 Action requested blocking but the NeMo rail did not stop."
        )
    if modified_payloads:
        if len(modified_payloads) != 1:
            raise RuntimeError("Multiple Colang 1 Actions modified the interaction.")
        selected = modified_payloads[0]
        expected_content = selected.get("content")
        if not isinstance(expected_content, str) or result_content != expected_content:
            raise RuntimeError(
                "A Colang 1 Action modification was not applied by the NeMo rail."
            )
        return {
            "decision": "transform",
            "action": str(selected["action"]),
            "proposed_action": str(selected.get("proposed_action", selected["action"])),
            "blocked": False,
            "modified": True,
            "content": result_content,
            "reason": str(selected.get("reason") or "NeMo Guardrails modified content."),
        }
    if result_content != request.text:
        # This covers a pure NeMo library flow which modifies content without a
        # product Action binding.  Its response, not a product resolver, is the
        # source of truth.
        return {
            "decision": "transform",
            "action": "redact",
            "proposed_action": "redact",
            "blocked": False,
            "modified": True,
            "content": result_content,
            "reason": "A native NeMo rail modified the interaction.",
        }
    return {
        "decision": "allow",
        "action": "pass",
        "proposed_action": "pass",
        "blocked": False,
        "modified": False,
        "content": request.text,
        "reason": "All activated NeMo rails passed.",
    }


def _decision(
    request: EngineRequest,
    response: GenerationResponse,
    config: NeMoConfigSnapshot,
    runtime_results: tuple[_RuntimeResult, ...],
    *,
    custom_decision: dict[str, Any] | None = None,
    cache_hit: bool,
    queue_latency_ms: int,
    active_concurrency: int,
    native_model_calls: tuple[ModelCallUsage, ...] = (),
) -> ProtectionDecision:
    output_data = response.output_data or {}
    custom = (
        custom_decision
        if custom_decision is not None
        else output_data.get("tasklattice_decision")
    )
    activated = _activated_rails(response)
    stopping = next((rail for rail in activated if rail.stop), None)
    stopping_binding = _binding_for_activated_rail(config, stopping)
    native_risk = (
        None
        if stopping_binding is not None
        else _native_risk(stopping.name if stopping else None)
    )
    native_action = _action_for_risk(request.plan, native_risk, request.phase)
    result_content = _response_content(response, request.text)

    if isinstance(custom, dict):
        validated = _validated_decision_payload(custom)
        decision = validated["decision"]
        action = validated["action"]
        reason = validated["reason"]
        result_content = validated["content"]
    elif stopping is not None:
        decision = (
            "allow"
            if request.mode == "detect"
            else "block"
            if native_action == "reject"
            else "transform"
        )
        action = "pass" if request.mode == "detect" else native_action
        reason = f"NeMo rail {stopping.name} blocked the interaction."
    elif result_content != request.text and request.mode == "enforce":
        decision = "transform"
        action = native_action if native_action != "reject" else "redact"
        reason = "NeMo Guardrails modified sensitive content."
    else:
        decision = "allow"
        action = "pass"
        reason = "All activated NeMo rails passed."

    findings = tuple(
        finding
        for item in runtime_results
        for finding in item.result.findings
    )
    if native_risk and not any(item.risk == native_risk for item in findings):
        findings = (
            *findings,
            RiskFinding(
                risk=native_risk,
                taxonomy_id=taxonomy_for_evaluator(native_risk),
                verdict="unsafe",
                confidence=None,
                evidence=reason,
                recommended_action=native_action,
            ),
        )
    trace = _trace(
        request,
        config,
        activated,
        runtime_results,
        request.active_block_id,
        queue_latency_ms=queue_latency_ms,
        resolve_latency_ms=int((custom_decision or {}).get("_resolve_latency_ms", 0)),
        native_model_calls=native_model_calls,
    )
    assessments = _assessments(request, runtime_results, trace, findings)
    interventions = _interventions(
        request,
        decision,
        action,
        reason,
        runtime_results,
    )
    modules = request.plan.modules_for(request.phase)
    completed_modules = sum(
        item.coverage.status == "complete" for item in assessments
    )
    coverage_status = (
        "complete"
        if completed_modules == len(modules)
        else "none" if completed_modules == 0 else "partial"
    )
    coverage = RuntimeCoverage(
        status=coverage_status,
        guarded_items=1 if completed_modules else 0,
        total_items=1,
        guarded_characters=len(request.text) if completed_modules else 0,
        total_characters=len(request.text),
        required_modules_completed=completed_modules,
        required_modules_total=len(modules),
    )
    return ProtectionDecision(
        decision=decision,  # type: ignore[arg-type]
        action=action,  # type: ignore[arg-type]
        reason=reason,
        texts=(result_content,) if decision == "transform" else (),
        guardrail_id=request.plan.guardrail_id,
        guardrail_version=request.plan.guardrail_version,
        output_delivery=request.plan.output_delivery,
        findings=findings,
        trace=trace,
        assessments=assessments,
        interventions=interventions,
        coverage=coverage,
        usage=RuntimeUsage(
            module_invocations=len(assessments),
            evaluator_invocations=len(runtime_results),
            text_characters=len(request.text),
            rail_invocations=max(
                len(activated),
                len({item.binding.capability for item in runtime_results}),
            ),
            # Count versioned policy Actions only. NeMo's internal bot/stop
            # actions are implementation details, not billable evaluators.
            action_invocations=len(runtime_results),
            model_invocations=len(native_model_calls) + sum(
                item.result.usage.model_invocations for item in runtime_results
            ),
            cache_hits=int(cache_hit),
            cache_misses=int(not cache_hit),
            queue_latency_ms=queue_latency_ms,
            runtime_engine=config.runtime_engine,
            runtime_profile=config.runtime_profile,
            config_checksum=config_checksum(config),
            fail_closed=any(
                item.result.verdict == "error"
                and _binding_fails_closed(request, item.binding)
                for item in _terminal_runtime_results(runtime_results)
            ),
            active_concurrency=active_concurrency,
            provider_latency_ms=_provider_work_ms(
                runtime_results, native_model_calls,
            ),
            provider_work_latency_ms=_provider_work_ms(
                runtime_results, native_model_calls,
            ),
            model_wait_latency_ms=_model_wait_wall_ms(
                runtime_results, native_model_calls,
            ),
        ),
        mode=request.mode,
    )


def _trace(
    request,
    config,
    activated,
    results,
    content_block_id,
    *,
    queue_latency_ms=0,
    resolve_latency_ms=0,
    native_model_calls: tuple[ModelCallUsage, ...] = (),
):
    checksum = config_checksum(config)
    root_id = f"nemo:config:{config.guardrail_id}:{config.guardrail_version}"

    def common(**values):
        return {
            "guardrail_id": config.guardrail_id,
            "guardrail_version": config.guardrail_version,
            "engine": config.runtime_engine,
            "runtime_profile": config.runtime_profile,
            "config_checksum": checksum,
            "content_block_id": content_block_id,
            **values,
        }

    trace = [
        RuntimeTraceStep(
            id=root_id,
            kind="runtime",
            name="NeMo Guardrails",
            status="active",
            outcome="active",
            detail=f"Executed immutable {config.compiler_version} configuration.",
            **common(),
        ),
        RuntimeTraceStep(
            id=f"{root_id}:queue",
            kind="queue",
            name="Runtime admission",
            status="passed",
            outcome="admitted",
            detail="Waited for the version-isolated Guardrail admission slot.",
            duration_ms=max(0, queue_latency_ms),
            parent_id=root_id,
            rail_type=request.phase,
            **common(),
        ),
    ]
    trace.extend(
        _native_model_trace_steps(request, native_model_calls, root_id)
    )
    bindings_by_id = {item.id: item for item in config.action_bindings}
    results_by_id = {item.binding.id: item for item in results}
    action_parents: dict[str, str] = {}
    for index, rail in enumerate(activated):
        rail_type = str(rail.type or request.phase)
        binding_ids = tuple(
            str(action.return_value["step_id"])
            for action in rail.executed_actions
            if isinstance(action.return_value, dict)
            and isinstance(action.return_value.get("step_id"), str)
            and action.return_value["step_id"] in bindings_by_id
        )
        binding = bindings_by_id.get(binding_ids[0]) if binding_ids else None
        result = results_by_id.get(binding.id) if binding is not None else None
        capability = (
            binding.capability
            if binding is not None
            else _native_risk(rail.name)
        )
        error = result is not None and result.result.verdict == "error"
        unsafe = result is not None and result.result.verdict == "unsafe"
        uncertain = result is not None and result.result.verdict == "uncertain"
        modified = any(
            isinstance(action.return_value, dict)
            and action.return_value.get("modified") is True
            for action in rail.executed_actions
        )
        status = (
            "error" if error else "blocked" if rail.stop else
            "modified" if modified else "needs_context" if uncertain else "passed"
        )
        verdict = (
            "error" if error else "uncertain" if uncertain else
            "unsafe" if unsafe or rail.stop or modified else "safe"
        )
        route = (
            "fail_closed"
            if error and binding is not None and _binding_fails_closed(request, binding)
            else "fail_open" if error else "enforce" if rail.stop or modified else
            "escalate" if uncertain else "complete"
        )
        rail_id = f"nemo:rail:official:{index}"
        trace.append(
            RuntimeTraceStep(
                id=rail_id,
                kind="rail",
                name=rail.name,
                status=status,
                outcome=status,
                detail=f"NeMo {rail_type} Rail {'stopped' if rail.stop else 'continued'} processing.",
                duration_ms=max(0, round((rail.duration or 0) * 1_000)),
                parent_id=root_id,
                verdict=verdict,
                route=route,
                capability=capability,
                rail_type=rail_type,
                **common(),
            )
        )
        for binding_id in binding_ids:
            action_parents[binding_id] = rail_id

        policy_rail = (
            _policy_rail_binding(request.plan, binding, request.phase)
            if binding is not None
            else None
        )
        if binding is not None and binding.policy_id is not None:
            policy_id = (
                f"nemo:policy:{binding.policy_id}:"
                f"{binding.policy_version}:{binding.flow_name or binding.capability}"
            )
            trace.append(
                RuntimeTraceStep(
                    id=policy_id,
                    kind="policy",
                    name=f"{binding.policy_id}@{binding.policy_version}",
                    status=status,
                    outcome=status,
                    detail="Executed the immutable Policy binding inside an official NeMo Rail.",
                    duration_ms=max(0, round((rail.duration or 0) * 1_000)),
                    parent_id=rail_id,
                    verdict=verdict,
                    route=route,
                    capability=binding.capability,
                    policy_id=binding.policy_id,
                    policy_version=binding.policy_version,
                    rail_type=request.phase,
                    flow_name=(
                        binding.flow_name
                        or (policy_rail.flow_name if policy_rail is not None else None)
                    ),
                    parallel_group=(
                        binding.parallel_group
                        or (
                            policy_rail.parallel_group
                            if policy_rail is not None
                            else None
                        )
                    ),
                    timeout_ms=binding.timeout_ms,
                    **common(),
                )
            )
            for binding_id in binding_ids:
                action_parents[binding_id] = policy_id
        else:
            native_policy = _native_policy_rail(
                request.plan,
                capability,
                request.phase,
            )
            if native_policy is None:
                continue
            selected, version, policy_rail = native_policy
            trace.append(
                RuntimeTraceStep(
                    id=(
                        f"nemo:policy:{selected.policy_id}:"
                        f"{selected.policy_version}:{policy_rail.flow_name}"
                    ),
                    kind="policy",
                    name=f"{version.name}@{selected.policy_version}",
                    status=status,
                    outcome=status,
                    detail="Executed the immutable native NeMo Policy binding.",
                    duration_ms=max(0, round((rail.duration or 0) * 1_000)),
                    parent_id=rail_id,
                    verdict=verdict,
                    route=route,
                    capability=capability,
                    policy_id=selected.policy_id,
                    policy_version=selected.policy_version,
                    rail_type=request.phase,
                    flow_name=policy_rail.flow_name,
                    parallel_group=policy_rail.parallel_group,
                    timeout_ms=policy_rail.timeout_ms,
                    **common(),
                )
            )
    rail_ids: dict[str, str] = {}
    policy_ids: dict[str, str] = {}
    if config.runtime_profile == "llmrails_colang2_programmable":
        grouped: dict[tuple[str, ...], list[_RuntimeResult]] = {}
        for item in results:
            grouped.setdefault(_result_group_key(item), []).append(item)
        for group_index, selected_items in enumerate(grouped.values()):
            selected = tuple(selected_items)
            terminal = selected[-1]
            binding = terminal.binding
            capability = binding.capability
            policy_rail = _policy_rail_binding(
                request.plan,
                binding,
                request.phase,
            )
            flow_name = binding.flow_name or (
                policy_rail.flow_name if policy_rail is not None else None
            )
            parallel_group = binding.parallel_group or (
                policy_rail.parallel_group if policy_rail is not None else None
            )
            error = terminal.result.verdict == "error"
            unsafe = terminal.result.verdict == "unsafe"
            uncertain = terminal.result.verdict == "uncertain"
            status = (
                "error" if error else "blocked" if unsafe else
                "needs_context" if uncertain else "passed"
            )
            rail_id = f"nemo:rail:{request.phase}:{capability}:{group_index}"
            for item in selected:
                rail_ids[item.binding.id] = rail_id
            trace.append(
                RuntimeTraceStep(
                    id=rail_id,
                    kind="rail",
                    name=f"{request.phase.title()} Rail",
                    status=status,
                    outcome=status,
                    detail=(
                        "Product-derived Colang 2 flow telemetry; pinned NeMo 0.23 "
                        "does not expose an activated-rail generation log for this profile."
                    ),
                    duration_ms=sum(item.latency_ms for item in selected),
                    parent_id=root_id,
                    verdict=(
                        "error" if error else "unsafe" if unsafe else
                        "uncertain" if uncertain else "safe"
                    ),
                    route=(
                        "fail_closed"
                        if error and _binding_fails_closed(request, binding)
                        else "fail_open" if error else "enforce" if unsafe else
                        "escalate" if uncertain else "complete"
                    ),
                    capability=capability,
                    rail_type=request.phase,
                    flow_name=flow_name,
                    parallel_group=parallel_group,
                    timeout_ms=binding.timeout_ms,
                    timed_out=error and "timeout" in (terminal.result.reason or "").casefold(),
                    **common(),
                )
            )
            if binding.policy_id is not None:
                policy_id = (
                    f"nemo:policy:{binding.policy_id}:"
                    f"{binding.policy_version}:{flow_name or capability}"
                )
                for item in selected:
                    policy_ids[item.binding.id] = policy_id
                trace.append(
                    RuntimeTraceStep(
                        id=policy_id,
                        kind="policy",
                        name=f"{binding.policy_id}@{binding.policy_version}",
                        status=status,
                        outcome=status,
                        detail="Executed the immutable Policy Flow binding.",
                        duration_ms=sum(item.latency_ms for item in selected),
                        parent_id=rail_id,
                        capability=capability,
                        policy_id=binding.policy_id,
                        policy_version=binding.policy_version,
                        rail_type=request.phase,
                        flow_name=flow_name,
                        parallel_group=parallel_group,
                        timeout_ms=binding.timeout_ms,
                        timed_out=error and "timeout" in (terminal.result.reason or "").casefold(),
                        **common(),
                    )
                )
    for item in results:
        trace.extend(item.result.trace)
        binding = item.binding
        module = next((
            candidate
            for candidate in request.plan.modules_for(request.phase)
            if binding.id in candidate.step_ids
        ), None)
        policy_rail = _policy_rail_binding(
            request.plan,
            binding,
            request.phase,
        )
        flow_name = binding.flow_name or (
            policy_rail.flow_name if policy_rail is not None else None
        )
        parallel_group = binding.parallel_group or (
            policy_rail.parallel_group if policy_rail is not None else None
        )
        timed_out = (
            item.result.verdict == "error"
            and "timeout" in (item.result.reason or "").casefold()
        )
        model_calls = item.result.usage.model_calls
        providers = tuple(dict.fromkeys(call.provider for call in model_calls))
        models = tuple(dict.fromkeys(call.model for call in model_calls))
        operations = tuple(dict.fromkeys(call.operation for call in model_calls))
        model_results = tuple(dict.fromkeys(call.result for call in model_calls))
        error_types = tuple(dict.fromkeys(
            call.error_type for call in model_calls if call.error_type != "none"
        ))
        profile_refs = tuple(dict.fromkeys(
            call.profile_ref for call in model_calls if call.profile_ref
        ))
        trace.append(
            RuntimeTraceStep(
                id=f"nemo:action:{binding.id}",
                kind="action",
                name=binding.action_name or binding.id,
                status=item.result.verdict,
                outcome=item.result.verdict,
                detail=item.result.reason or "NeMo Action completed.",
                duration_ms=item.latency_ms,
                parent_id=(
                    action_parents.get(binding.id)
                    or policy_ids.get(binding.id)
                    or rail_ids.get(binding.id)
                    or root_id
                ),
                contract_ref=binding.contract_ref,
                verdict=item.result.verdict,
                route=(
                    "enforce" if item.result.verdict == "unsafe" else
                    "fail_closed"
                    if item.result.verdict == "error"
                    and _binding_fails_closed(request, binding)
                    else "fail_open" if item.result.verdict == "error" else
                    "escalate" if item.result.verdict == "uncertain" else
                    "complete"
                ),
                capability=binding.capability,
                evaluator_id=(
                    _one_or_mixed(providers)
                    if model_calls
                    else binding.action_name
                ),
                profile_ref=_one_or_mixed(profile_refs),
                module_id=module.id if module is not None else "__unmapped__",
                policy_id=binding.policy_id,
                policy_version=binding.policy_version,
                rail_type=request.phase,
                flow_name=flow_name,
                action_name=binding.action_name,
                action_version=binding.action_version,
                timeout_ms=binding.timeout_ms,
                timed_out=timed_out,
                parallel_group=parallel_group,
                provider_latency_ms=item.provider_latency_ms,
                provider_work_ms=sum(call.duration_ms for call in model_calls),
                model_wait_ms=_model_calls_wall_ms(model_calls),
                provider_name=_one_or_mixed(providers),
                model_name=_one_or_mixed(models),
                model_operation=_one_or_mixed(operations),
                model_result=_one_or_mixed(model_results),
                error_type=_one_or_mixed(error_types),
                model_time_to_first_token_ms=next((
                    call.time_to_first_token_ms
                    for call in model_calls
                    if call.time_to_first_token_ms is not None
                ), None),
                model_input_tokens=sum(call.input_tokens for call in model_calls),
                model_output_tokens=sum(call.output_tokens for call in model_calls),
                model_retries=sum(call.retries for call in model_calls),
                model_backoff_ms=sum(call.backoff_ms for call in model_calls),
                started_offset_ms=min(
                    (call.started_offset_ms for call in model_calls), default=None,
                ),
                finished_offset_ms=max(
                    (call.finished_offset_ms for call in model_calls), default=None,
                ),
                **common(),
            )
        )
    if config.runtime_profile == "llmrails_colang2_programmable":
        trace.append(
            RuntimeTraceStep(
                id=f"{root_id}:resolve",
                kind="action",
                name=ACTION_RESOLVE,
                status="passed",
                outcome="resolved",
                detail="Resolved programmable Colang 2 Action results.",
                duration_ms=max(0, resolve_latency_ms),
                parent_id=root_id,
                rail_type=request.phase,
                action_name=ACTION_RESOLVE,
                action_version="1.0.0",
                **common(),
            )
        )
    return tuple(trace)


def _policy_rail_binding(plan, binding, phase):
    if binding.policy_id is None or binding.policy_version is None:
        return None
    selected = next(
        (
            item
            for item in plan.policy_bindings
            if item.policy_id == binding.policy_id
            and item.policy_version == binding.policy_version
            and phase in item.enabled_rails
        ),
        None,
    )
    if selected is None:
        return None
    version = next(
        (
            item
            for item in plan.policy_versions
            if item.policy_id == binding.policy_id
            and item.version == binding.policy_version
        ),
        None,
    )
    if version is None:
        return None
    return next(
        (
            item
            for item in version.rail_bindings
            if item.rail_type == phase
            and (binding.flow_name is None or item.flow_name == binding.flow_name)
        ),
        None,
    )


def _binding_policy_rule_identity(
    plan: GuardrailPlanSnapshot,
    binding: NeMoActionBinding,
    phase: str,
) -> tuple[str | None, str | None]:
    """Resolve immutable product identities for a runtime Action finding."""

    if phase not in {"input", "output"}:
        return None, None
    if binding.policy_id is not None:
        rail = _policy_rail_binding(plan, binding, phase)
        flow_name = binding.flow_name or (rail.flow_name if rail is not None else None)
        return (
            binding.policy_id,
            flow_rule_id(phase, flow_name) if flow_name is not None else None,
        )
    native = _native_policy_rail(plan, binding.capability, phase)
    if native is None:
        return None, None
    selected, _version, rail = native
    return selected.policy_id, flow_rule_id(phase, rail.flow_name)


def _native_policy_rail(plan, risk, phase):
    if risk is None:
        return None
    versions = {
        (item.policy_id, item.version): item for item in plan.policy_versions
    }
    for selected in plan.policy_bindings:
        if phase not in selected.enabled_rails:
            continue
        version = versions.get((selected.policy_id, selected.policy_version))
        if (
            version is None
            or version.source != "built-in"
            or dict(version.execution_contract).get("native_risk") != risk
        ):
            continue
        rail = next(
            (item for item in version.rail_bindings if item.rail_type == phase),
            None,
        )
        if rail is not None:
            return selected, version, rail
    return None


def _assessments(request, results, trace, all_findings=(), *, force_error=False):
    assessments = []
    for module in request.plan.modules_for(request.phase):
        capabilities = {
            step.capability
            for step in request.plan.steps
            if step.id in module.step_ids
        }
        selected = tuple(
            item for item in results
            if item.binding.capability in capabilities
        )
        terminal = _terminal_runtime_results(selected)
        native_unsafe = any(
            item.kind == "rail"
            and item.capability in capabilities
            and item.verdict == "unsafe"
            for item in trace
        )
        observed = bool(selected) or any(
            item.kind in {"rail", "policy", "action"}
            and item.capability in capabilities
            for item in trace
        )
        status = (
            "error"
            if force_error or any(item.result.verdict == "error" for item in terminal)
            else "uncovered"
            if not observed
            else "intervene"
            if native_unsafe or any(item.result.verdict == "unsafe" for item in terminal)
            else "needs_context"
            if any(item.result.verdict == "uncertain" for item in terminal)
            else "pass"
        )
        findings = tuple(
            dict.fromkeys(
                (
                    *(f for item in selected for f in item.result.findings),
                    *(f for f in all_findings if f.risk in capabilities),
                )
            )
        )
        reason = next(
            (item.result.reason for item in selected if item.result.reason),
            (
                "The module was not reached because another NeMo rail stopped processing."
                if status == "uncovered"
                else "NeMo rail completed."
            ),
        )
        module_coverage = "none" if status in {"error", "uncovered"} else "complete"
        fragment = DecisionFragment(
            id=f"nemo:{module.id}:{status}",
            module_id=module.id,
            module=module.module,
            status=status,
            action=_strongest(tuple(f.recommended_action for f in findings)),
            findings=findings,
            coverage=module_coverage,
            reason=reason,
            content_block_id=request.active_block_id,
        )
        module_trace = tuple(
            item
            for item in trace
            if item.capability in capabilities or item.kind == "runtime"
        )
        assessments.append(
            ModuleAssessment(
                module_id=module.id,
                module=module.module,
                status=status,
                fragments=(fragment,),
                coverage=RuntimeCoverage(
                    status=module_coverage,
                    guarded_items=int(module_coverage == "complete"),
                    total_items=1,
                    guarded_characters=(
                        len(request.text) if module_coverage == "complete" else 0
                    ),
                    total_characters=len(request.text),
                    required_modules_completed=int(module_coverage == "complete"),
                    required_modules_total=1,
                ),
                latency_ms=max(
                    (
                        sum(
                            item.latency_ms
                            for item in selected
                            if item.binding.capability == capability
                        )
                        for capability in capabilities
                    ),
                    default=0,
                ),
                trace=module_trace,
                content_block_id=request.active_block_id,
            )
        )
    return tuple(assessments)


def _interventions(request, decision, action, reason, runtime_results):
    terminal = _terminal_runtime_results(runtime_results)
    interventions = []
    for item in terminal:
        if item.result.verdict not in {"unsafe", "uncertain"}:
            continue
        proposed = (
            "clarify"
            if item.result.verdict == "uncertain"
            else _runtime_action(item)
        )
        if proposed == "pass":
            continue
        module = next(
            (
                value
                for value in request.plan.modules_for(request.phase)
                if item.binding.id in value.step_ids
            ),
            None,
        )
        interventions.append(
            AppliedIntervention(
                kind=proposed,
                module_id=module.id if module is not None else "nemo-guardrails",
                fragment_id=f"nemo:{item.binding.id}:{proposed}",
                reason=item.result.reason,
                patches=(
                    _redaction_patches(request.text, (item,))
                    if proposed == "redact"
                    else ()
                ),
                replacement=next(
                    (
                        finding.replacement
                        for finding in item.result.findings
                        if finding.recommended_action == proposed
                        and finding.replacement is not None
                    ),
                    None,
                ),
                content_block_id=request.active_block_id,
            )
        )
    if decision == "block" and action == "reject" and not any(
        item.kind == "reject" for item in interventions
    ):
        interventions.append(
            AppliedIntervention(
                kind="reject",
                module_id="nemo-guardrails",
                fragment_id="nemo:reject",
                reason=reason,
                content_block_id=request.active_block_id,
            )
        )
    return tuple(interventions)


def _failed_decision(
    request,
    error,
    duration,
    config,
    *,
    cache_hit=False,
    queue_latency_ms=0,
    active_concurrency=0,
    native_model_calls: tuple[ModelCallUsage, ...] = (),
):
    reason = f"NeMo Guardrails failed closed with {type(error).__name__}."
    checksum = config_checksum(config)
    trace = (
        RuntimeTraceStep(
            id="nemo:runtime:error",
            kind="runtime",
            name="NeMo Guardrails",
            status="error",
            detail=reason,
            duration_ms=duration,
            route="fail_closed",
            content_block_id=request.active_block_id,
            guardrail_id=request.plan.guardrail_id,
            guardrail_version=request.plan.guardrail_version,
            rail_type=request.phase,
            outcome="error",
            timed_out=isinstance(error, TimeoutError),
            engine=config.runtime_engine,
            runtime_profile=config.runtime_profile,
            config_checksum=checksum,
        ),
        *_native_model_trace_steps(
            request, native_model_calls, "nemo:runtime:error",
        ),
    )
    return ProtectionDecision(
        decision="block" if request.mode == "enforce" else "allow",
        action="reject" if request.mode == "enforce" else "pass",
        reason=reason,
        guardrail_id=request.plan.guardrail_id,
        guardrail_version=request.plan.guardrail_version,
        output_delivery=request.plan.output_delivery,
        trace=trace,
        assessments=_assessments(request, (), trace, force_error=True),
        coverage=RuntimeCoverage(
            status="none",
            total_items=1,
            total_characters=len(request.text),
            required_modules_total=len(request.plan.modules_for(request.phase)),
        ),
        usage=RuntimeUsage(
            text_characters=len(request.text),
            cache_hits=int(cache_hit),
            cache_misses=int(not cache_hit),
            queue_latency_ms=queue_latency_ms,
            runtime_engine=config.runtime_engine,
            runtime_profile=config.runtime_profile,
            config_checksum=checksum,
            fail_closed=True,
            active_concurrency=active_concurrency,
            model_invocations=len(native_model_calls),
            provider_latency_ms=sum(
                call.duration_ms for call in native_model_calls
            ),
            provider_work_latency_ms=sum(
                call.duration_ms for call in native_model_calls
            ),
            model_wait_latency_ms=_model_calls_wall_ms(native_model_calls),
        ),
        mode=request.mode,
    )


def _response_content(response: GenerationResponse, fallback: str) -> str:
    if isinstance(response.response, list) and response.response:
        return str(response.response[-1].get("content", fallback))
    if isinstance(response.response, str):
        return response.response
    return fallback


def _validated_decision_payload(payload: dict[str, Any]) -> dict[str, str]:
    decision = payload.get("decision")
    action = payload.get("action")
    content = payload.get("content")
    if decision not in {"allow", "transform", "block"}:
        raise RuntimeError("NeMo returned an invalid policy decision.")
    if action not in ENFORCEMENT_ACTIONS:
        raise RuntimeError("NeMo returned an invalid enforcement action.")
    if not isinstance(content, str):
        raise RuntimeError("NeMo returned invalid decision content.")
    if decision == "allow" and action != "pass":
        raise RuntimeError("NeMo returned an inconsistent allow decision.")
    if decision == "block" and action != "reject":
        raise RuntimeError("NeMo returned an inconsistent block decision.")
    if decision == "transform" and action in {"pass", "reject"}:
        raise RuntimeError("NeMo returned an inconsistent transform decision.")
    if "blocked" in payload and bool(payload["blocked"]) != (decision == "block"):
        raise RuntimeError("NeMo returned inconsistent blocking metadata.")
    if "modified" in payload and bool(payload["modified"]) != (
        decision == "transform"
    ):
        raise RuntimeError("NeMo returned inconsistent modification metadata.")
    return {
        "decision": str(decision),
        "action": str(action),
        "content": content,
        "reason": str(payload.get("reason") or "NeMo Guardrails completed."),
    }


def _binding_for_activated_rail(
    config: NeMoConfigSnapshot,
    rail: Any,
) -> NeMoActionBinding | None:
    if rail is None:
        return None
    bindings = {item.id: item for item in config.action_bindings}
    for action in rail.executed_actions:
        result = action.return_value
        if isinstance(result, dict):
            binding = bindings.get(str(result.get("step_id", "")))
            if binding is not None:
                return binding
    return None


def _native_risk(rail: str | None) -> str | None:
    if not rail:
        return None
    normalized = rail.casefold()
    if "sensitive data" in normalized or "pii" in normalized:
        return "pii"
    if "topic safety" in normalized:
        return "topic_control"
    if "content safety" in normalized:
        return "content_safety"
    if "jailbreak" in normalized:
        return "jailbreak"
    if "injection" in normalized:
        return "prompt_injection"
    return None


def _native_reason(risk: str, details: Any) -> str:
    reason = f"NeMo native {risk.replace('_', ' ')} Action reported unsafe content."
    if isinstance(details, (list, tuple)):
        labels = tuple(str(item) for item in details if str(item).strip())
        if labels:
            return f"{reason} Policy categories: {', '.join(labels[:8])}."
    return reason


def _compiled_policy_flow_name(binding: NeMoActionBinding) -> str:
    if binding.policy_id is None or binding.policy_version is None or not binding.flow_name:
        return ""

    def clean(value: str) -> str:
        return "_".join(re.sub(r"[^a-zA-Z0-9]+", " ", value).split()).lower()

    return "_".join(
        ("tl", clean(binding.policy_id), f"v{binding.policy_version}", clean(binding.flow_name))
    )


def _action_for_risk(plan, risk, phase):
    step = next(
        (
            item for item in plan.steps
            if item.capability == risk and phase in item.phases
        ),
        None,
    )
    return step.on_unsafe if step is not None else "reject"


def _strongest(actions):
    values = set(actions)
    return next(
        (item for item in ENFORCEMENT_ACTION_CONFLICT_ORDER if item in values),
        "pass",
    )


def _resolved_content(text, action, unsafe):
    if action == "redact":
        patches = _redaction_patches(text, unsafe)
        content = text
        previous_end = -1
        for patch in sorted(set(patches), key=lambda value: (value.start, value.end)):
            if patch.start < previous_end:
                raise _PatchConflict(
                    "The interaction was blocked because redaction patches conflicted."
                )
            previous_end = patch.end
        for patch in reversed(sorted(set(patches), key=lambda value: (value.start, value.end))):
            content = content[:patch.start] + patch.replacement + content[patch.end:]
        return content
    replacement = next(
        (
            finding.replacement
            for item in unsafe
            for finding in item.result.findings
            if finding.recommended_action == action and finding.replacement is not None
        ),
        None,
    )
    if replacement is not None:
        return replacement
    return {
        "clarify": "More information is required before the request can be evaluated safely.",
        "redirect": "I can help with topics inside this assistant's approved purpose.",
        "regenerate": "The response was withheld and should be regenerated under the active Guardrail.",
        "rewrite": "The response was rewritten to comply with the active Guardrail.",
        "fallback": "A safe fallback response was selected by the active Guardrail.",
    }.get(action, text)


def _redaction_patches(text, results):
    patches = []
    for item in results:
        matcher = difflib.SequenceMatcher(
            a=text,
            b=item.result.content,
            autojunk=False,
        )
        patches.extend(
            ContentPatch(start, end, item.result.content[new_start:new_end])
            for operation, start, end, new_start, new_end in matcher.get_opcodes()
            if operation != "equal"
        )
    return tuple(patches)


def _terminal_runtime_results(results):
    terminal = {}
    for item in results:
        terminal[_result_group_key(item)] = item
    return tuple(terminal.values())


def _native_model_trace_steps(
    request: EngineRequest,
    calls: tuple[ModelCallUsage, ...],
    parent_id: str,
) -> tuple[RuntimeTraceStep, ...]:
    steps: list[RuntimeTraceStep] = []
    for index, call in enumerate(calls):
        suffix = f"_{request.phase}"
        risk = (
            call.operation[: -len(suffix)]
            if call.operation.endswith(suffix)
            else call.operation
        )
        plan_step = next(
            (
                item for item in request.plan.steps
                if item.capability == risk and request.phase in item.phases
            ),
            None,
        )
        module = next(
            (
                item for item in request.plan.modules_for(request.phase)
                if plan_step is not None and plan_step.id in item.step_ids
            ),
            None,
        )
        native_policy = _native_policy_rail(
            request.plan, risk, request.phase,
        )
        selected_policy = native_policy[0] if native_policy is not None else None
        failed = call.result != "success"
        failure_mode = (
            module.failure_mode if module is not None else "fail_closed"
        )
        steps.append(RuntimeTraceStep(
            id=f"nemo:model:{index}:{risk}",
            kind="evaluator",
            name=f"{call.provider}/{call.model}",
            status=call.result if failed else "complete",
            detail=(
                f"NeMo-native {risk.replace('_', ' ')} model call failed."
                if failed
                else f"NeMo-native {risk.replace('_', ' ')} model call completed."
            ),
            duration_ms=call.duration_ms,
            parent_id=parent_id,
            contract_ref=(plan_step.contract_ref if plan_step is not None else None),
            verdict="error" if failed else "safe",
            route=(failure_mode if failed else "complete"),
            capability=risk,
            module_id=module.id if module is not None else "__unknown__",
            guardrail_id=request.plan.guardrail_id,
            guardrail_version=request.plan.guardrail_version,
            policy_id=(
                selected_policy.policy_id if selected_policy is not None else None
            ),
            policy_version=(
                selected_policy.policy_version if selected_policy is not None else None
            ),
            rail_type=request.phase,
            action_name=f"nemo_{risk}",
            outcome=call.result,
            timeout_ms=module.timeout_ms if module is not None else None,
            timed_out=call.result == "timeout",
            provider_latency_ms=call.duration_ms,
            provider_work_ms=call.duration_ms,
            model_wait_ms=call.duration_ms,
            provider_name=call.provider,
            model_name=call.model,
            model_operation=call.operation,
            model_result=call.result,
            error_type=call.error_type,
            model_input_tokens=call.input_tokens,
            model_output_tokens=call.output_tokens,
            model_retries=call.retries,
            model_backoff_ms=call.backoff_ms,
            started_offset_ms=call.started_offset_ms,
            finished_offset_ms=call.finished_offset_ms,
        ))
    return tuple(steps)


def _provider_work_ms(
    results: tuple[_RuntimeResult, ...],
    extra_calls: tuple[ModelCallUsage, ...] = (),
) -> int:
    total = 0
    for item in results:
        calls = item.result.usage.model_calls
        total += (
            sum(call.duration_ms for call in calls)
            if calls
            else max(0, item.provider_latency_ms)
        )
    return total + sum(call.duration_ms for call in extra_calls)


def _model_wait_wall_ms(
    results: tuple[_RuntimeResult, ...],
    extra_calls: tuple[ModelCallUsage, ...] = (),
) -> int:
    calls = tuple(
        call
        for item in results
        for call in item.result.usage.model_calls
    ) + extra_calls
    return _model_calls_wall_ms(calls)


def _model_calls_wall_ms(calls) -> int:
    intervals = sorted(
        (
            max(0, call.started_offset_ms),
            max(call.started_offset_ms, call.finished_offset_ms),
        )
        for call in calls
    )
    if not intervals:
        return 0
    total = 0
    current_start, current_end = intervals[0]
    for started, finished in intervals[1:]:
        if started <= current_end:
            current_end = max(current_end, finished)
            continue
        total += current_end - current_start
        current_start, current_end = started, finished
    return total + current_end - current_start


def _one_or_mixed(values: tuple[str, ...]) -> str | None:
    return values[0] if len(values) == 1 else "mixed" if values else None


def _result_group_key(item: _RuntimeResult) -> tuple[str, ...]:
    """Collapse one capability graph, but never distinct Policy Flows."""
    binding = item.binding
    if binding.policy_id is not None:
        return (
            "policy-flow",
            binding.policy_id,
            str(binding.policy_version or ""),
            binding.flow_name or binding.id,
        )
    return ("capability", binding.capability)


def _runtime_action(item):
    reasoning = tuple(
        evidence
        for finding in item.result.findings
        for evidence in finding.reasoning
    )
    if not reasoning:
        recommended = tuple(
            finding.recommended_action
            for finding in item.result.findings
            if finding.recommended_action != "pass"
        )
        return _strongest(recommended) if recommended else item.binding.on_unsafe
    severity = {
        "too_complex": 0,
        "translation_ambiguous": 1,
        "impossible": 2,
        "invalid": 3,
        "satisfiable": 4,
        "no_translations": 5,
        "valid": 6,
    }
    result = min(
        reasoning,
        key=lambda value: (severity[value.result], value.id),
    ).result
    return {
        "valid": "pass",
        "invalid": item.binding.on_unsafe,
        "satisfiable": "clarify",
        "impossible": "reject",
        "translation_ambiguous": "clarify",
        "too_complex": "reject",
        "no_translations": "clarify",
    }[result]


def _binding_fails_closed(request, binding):
    if binding.policy_id is not None:
        return binding.failure_mode == "fail_closed"
    module = next(
        (
            item
            for item in request.plan.modules_for(request.phase)
            if binding.id in item.step_ids
        ),
        None,
    )
    return (
        module is None
        or module.required_for_release and module.failure_mode == "fail_closed"
    )


def _request_timeout_ms(request: EngineRequest) -> int:
    modules = request.plan.modules_for(request.phase)
    by_id = {module.id: module for module in modules}
    totals: dict[str, int] = {}
    pending = list(modules)
    while pending:
        ready = tuple(
            module
            for module in pending
            if all(dependency in totals for dependency in module.depends_on)
        )
        if not ready:
            # Compiled plans are validated earlier; this remains fail-closed for
            # a corrupt persisted snapshot.
            return sum(module.timeout_ms for module in modules) + 500
        for module in ready:
            dependency_budget = max(
                (totals[item] for item in module.depends_on if item in by_id),
                default=0,
            )
            totals[module.id] = dependency_budget + module.timeout_ms
            pending.remove(module)
    # Independent modules share a Colang wave, so the critical dependency path
    # is the request deadline. The fixed allowance covers flow and resolution.
    return max(totals.values(), default=2_000) + 500
