from __future__ import annotations

from collections.abc import Callable
from dataclasses import replace
from datetime import UTC, datetime

from .content_views import content_view, text_blocks
from .context import CallContextStore
from .streaming import output_stream_contract
from .contracts import (
    AppliedIntervention,
    ContentBlockResult,
    ENFORCEMENT_ACTION_CONFLICT_ORDER,
    EnforcementAction,
    EngineRequest,
    ProtectionDecision,
    ProtectionRequest,
    RuntimeUsage,
    NeMoPolicyRuntime,
    GuardContentBlock,
    ModuleAssessment,
    PlanResolution,
    PlanResolver,
    RuntimeCoverage,
    OutputDeliveryMode,
)


class GuardrailRuntimeService:
    """Pin a tested Guardrail Plan and evaluate model input or output."""

    def __init__(
        self,
        runtime: NeMoPolicyRuntime,
        resolver: PlanResolver,
        contexts: CallContextStore | None = None,
    ) -> None:
        self._runtime = runtime
        self._resolver = resolver
        self._contexts = contexts or CallContextStore()
        self.routing_event_sink = None

    def _resolve_call(self, request, *, require_existing=False, allow_new_output=False):
        stored = self._contexts.get(request.call_id)
        composed = getattr(self._resolver, "composed_endpoint", lambda _: False)(request.context.endpoint_id)
        if stored is not None:
            if stored.resolution.endpoint_id != request.context.endpoint_id:
                from runner.routing import RoutingError
                raise RoutingError("call_endpoint_mismatch")
            return stored.resolution, stored
        if require_existing or (composed and request.phase == "output" and request.call_id and not allow_new_output):
            from runner.routing import RoutingError
            raise RoutingError("call_context_expired: correlated output cannot be reassigned")
        resolution = self._resolver.resolve(replace(request.context, call_id=request.call_id))
        blocks = request.content_blocks or text_blocks(request.phase, request.texts,
            request.context.value("field", "target_source") or "user_input")
        stored = self._contexts.claim(request.call_id, request.messages, resolution, blocks)
        if stored.resolution.endpoint_id != request.context.endpoint_id:
            from runner.routing import RoutingError
            raise RoutingError("call_endpoint_mismatch")
        return stored.resolution, stored

    async def publish_assignment(self, resolution, call_id):
        if resolution.route_assignment and self.routing_event_sink:
            a = resolution.route_assignment
            await self.routing_event_sink({**a, "id": a["decisionId"] + ":assignment",
                "eventType": "route_assignment", "callId": call_id or a["decisionId"],
                "occurredAt": a["decisionAt"]})

    async def complete_call(self, resolution, call_id, outcome, failure_reason=None):
        if resolution.route_assignment and self.routing_event_sink:
            a = resolution.route_assignment
            now = datetime.now(UTC)
            outcome = self._contexts.record_outcome(call_id, outcome)
            event = {**a, "id": a["decisionId"] + ":completion",
                "eventType": "completion", "callId": call_id or a["decisionId"],
                "occurredAt": now.isoformat(), "outcome": outcome,
                "durationMs": max(0, round((now-datetime.fromisoformat(a["decisionAt"])).total_seconds()*1000)),
                **({"failureReason": failure_reason} if failure_reason else {})}
            await self.routing_event_sink(self._contexts.finish(call_id, event))


    async def evaluate(
        self,
        request: ProtectionRequest,
        *,
        on_resolved: Callable[[PlanResolution], None] | None = None,
    ) -> ProtectionDecision:
        try:
            resolution, stored = self._resolve_call(request)
        except Exception as error:
            assignment = getattr(error, "assignment", None)
            if assignment and self.routing_event_sink:
                await self.routing_event_sink({**assignment, "id": assignment["decisionId"] + ":assignment",
                    "eventType": "route_assignment", "callId": request.call_id or assignment["decisionId"],
                    "occurredAt": assignment["decisionAt"]})
            raise
        if on_resolved is not None:
            on_resolved(resolution)
        await self.publish_assignment(resolution, request.call_id)
        try:
            decision = await self._evaluate_resolved(request, resolution, stored)
        except Exception as error:
            await self.complete_call(resolution, request.call_id, "timeout" if isinstance(error, TimeoutError) else "error", type(error).__name__)
            raise
        outcome = "error" if decision.usage and decision.usage.fail_closed else "intervene" if decision.interventions and decision.decision != "block" else decision.decision
        outcome = self._contexts.record_outcome(request.call_id, outcome)
        if outcome in {"error", "block"} or (request.phase == "output" and request.context.value("field", "routing.stream") != "true"):
            await self.complete_call(resolution, request.call_id, outcome)
        return decision

    def output_delivery(
        self,
        request: ProtectionRequest,
        *,
        on_resolved: Callable[[PlanResolution], None] | None = None,
        require_existing: bool = False,
        allow_new_output: bool = False,
    ) -> OutputDeliveryMode:
        """Resolve and pin the delivery contract before the first output chunk is released."""
        resolution, stored = self._resolve_call(request, require_existing=require_existing, allow_new_output=allow_new_output)
        retain = getattr(self._resolver, "retain_release", None)
        if retain is not None:
            try:
                retain(resolution.effective_release_id)
            except LookupError as error:
                from runner.routing import RoutingError
                raise RoutingError("pinned_release_unavailable", resolution.route_assignment) from error
        self._contexts.put(request.call_id, stored.messages if stored else request.messages,
                           resolution, stored.content_blocks if stored else request.content_blocks)
        if on_resolved is not None:
            on_resolved(resolution)
        return output_stream_contract(resolution.plan).effective_mode

    async def evaluate_guardrail(
        self,
        request: ProtectionRequest,
        guardrail_id: str,
        version: str,
        *,
        on_resolved: Callable[[PlanResolution], None] | None = None,
    ) -> ProtectionDecision:
        stored = self._contexts.get(request.call_id)
        resolver = getattr(self._resolver, "resolve_guardrail", None)
        if resolver is None:
            raise LookupError("This Runner cannot resolve an explicit Guardrail Version.")
        if request.phase == "output" and stored is not None:
            if (
                stored.resolution.plan.guardrail_id != guardrail_id
                or stored.resolution.plan.guardrail_version != version
            ):
                raise LookupError("The output check does not match the pinned Playground Guardrail Version.")
            resolution = stored.resolution
        else:
            resolution = resolver(guardrail_id, version)
        if on_resolved is not None:
            on_resolved(resolution)
        return await self._evaluate_resolved(request, resolution, stored)

    async def _evaluate_resolved(self, request, resolution, stored) -> ProtectionDecision:
        incoming_blocks = request.content_blocks or text_blocks(
            request.phase,
            request.texts,
            request.context.value("field", "target_source") or "user_input",
        )
        if request.phase == "input":
            self._contexts.put(
                request.call_id,
                request.messages,
                resolution,
                incoming_blocks,
            )

        if not incoming_blocks:
            return ProtectionDecision(
                decision="allow",
                action="pass",
                reason="No model content required a protection check.",
                guardrail_id=resolution.plan.guardrail_id,
                guardrail_version=resolution.plan.guardrail_version,
                router_id=resolution.router_id,
                endpoint_id=resolution.endpoint_id,
                output_delivery=resolution.plan.output_delivery,
                effective_release_id=resolution.effective_release_id,
                model_revision_id=resolution.model_revision_id,
                route_assignment=resolution.route_assignment,
                trace=resolution.trace,
                mode=request.mode,
            )

        output_by_id: dict[str, str] = {}
        findings = []
        trace = list(resolution.trace)
        assessments: list[ModuleAssessment] = []
        interventions: list[AppliedIntervention] = []
        coverages: list[RuntimeCoverage] = []
        usages: list[RuntimeUsage] = []
        final_decision = "allow"
        final_action = "pass"
        reason = "All model content passed the active Guardrail."
        pinned = stored if request.phase == "output" else None
        context_messages = pinned.messages if pinned else request.messages
        view_blocks = _context_blocks(
            pinned.content_blocks if pinned else (),
            incoming_blocks,
        )
        trusted_instruction = _trusted_instruction(context_messages, view_blocks)
        content_results: dict[str, ContentBlockResult] = {
            block.id: ContentBlockResult(
                id=block.id,
                role=block.role,
                source=block.source,
                decision="allow",
                action="pass",
                text=block.text,
                evaluated=False,
            )
            for block in incoming_blocks
            if not block.guard_content or block.trust == "trusted"
        }

        for block in incoming_blocks:
            if not block.guard_content or block.trust == "trusted":
                continue
            view = content_view(view_blocks, block.id)
            decision = await self._runtime.evaluate(
                EngineRequest(
                    phase=request.phase,
                    text=block.text,
                    plan=resolution.plan,
                    context_messages=context_messages,
                    trusted_instruction=trusted_instruction,
                    target_source=block.source,
                    mode=request.mode,
                    evidence_scope=request.evidence_scope,
                    content_view=view,
                    active_block_id=block.id,
                    request_context=request.context,
                    effective_release_id=resolution.effective_release_id,
                )
            )
            findings.extend(decision.findings)
            trace.extend(decision.trace)
            assessments.extend(decision.assessments)
            interventions.extend(decision.interventions)
            if decision.coverage is not None:
                coverages.append(decision.coverage)
            if decision.usage is not None:
                usages.append(decision.usage)
            resolved_text = (
                None
                if decision.decision == "block"
                else decision.texts[0]
                if decision.texts
                else block.text
            )
            content_results[block.id] = ContentBlockResult(
                id=block.id,
                role=block.role,
                source=block.source,
                decision=decision.decision,
                action=decision.action,
                text=resolved_text,
            )
            if resolved_text is not None:
                output_by_id[block.id] = resolved_text
            if decision.decision == "block":
                final_decision = "block"
                final_action = "reject"
                reason = decision.reason or "A content block was blocked by the active Guardrail."
                continue
            if decision.decision == "transform":
                if final_decision != "block":
                    final_decision = "transform"
                    final_action = _strongest_action((final_action, decision.action))
                    reason = decision.reason or "The active Guardrail transformed model content."

        ordered_results = tuple(content_results[block.id] for block in incoming_blocks)
        output = tuple(output_by_id.get(block.id, block.text) for block in incoming_blocks)

        return ProtectionDecision(
            decision=final_decision,
            action=final_action,
            reason=reason,
            texts=(
                output
                if request.texts and final_decision == "transform"
                else ()
            ),
            guardrail_id=resolution.plan.guardrail_id,
            guardrail_version=resolution.plan.guardrail_version,
            router_id=resolution.router_id,
            endpoint_id=resolution.endpoint_id,
            output_delivery=resolution.plan.output_delivery,
            effective_release_id=resolution.effective_release_id,
            model_revision_id=resolution.model_revision_id,
            route_assignment=resolution.route_assignment,
            findings=tuple(findings),
            trace=tuple(trace),
            assessments=tuple(assessments),
            interventions=tuple(interventions),
            coverage=_coverage(coverages),
            usage=_usage(usages),
            mode=request.mode,
            content_results=ordered_results,
        )


def _trusted_instruction(
    messages: tuple[dict, ...],
    blocks: tuple[GuardContentBlock, ...],
) -> str:
    messages_text = tuple(
        str(message.get("content", "")).strip()
        for message in messages
        if message.get("role") in {"system", "developer"}
        and isinstance(message.get("content"), str)
        and str(message.get("content", "")).strip()
    )
    block_text = tuple(
        block.text.strip()
        for block in blocks
        if block.role == "trusted_instruction"
        and block.trust == "trusted"
        and block.text.strip()
    )
    return "\n\n".join((*messages_text, *block_text))


def _context_blocks(
    stored: tuple[GuardContentBlock, ...],
    incoming: tuple[GuardContentBlock, ...],
) -> tuple[GuardContentBlock, ...]:
    incoming_ids = {block.id for block in incoming}
    return (*tuple(block for block in stored if block.id not in incoming_ids), *incoming)


def _strongest_action(
    actions: tuple[EnforcementAction, ...],
) -> EnforcementAction:
    values = set(actions)
    return next(
        (action for action in ENFORCEMENT_ACTION_CONFLICT_ORDER if action in values),
        "pass",
    )


def _coverage(items: list[RuntimeCoverage]) -> RuntimeCoverage | None:
    if not items:
        return None
    return RuntimeCoverage(
        status=(
            "complete"
            if all(item.status == "complete" for item in items)
            else "none"
            if all(item.status == "none" for item in items)
            else "partial"
        ),
        guarded_items=sum(item.guarded_items for item in items),
        total_items=sum(item.total_items for item in items),
        guarded_characters=sum(item.guarded_characters for item in items),
        total_characters=sum(item.total_characters for item in items),
        required_modules_completed=sum(item.required_modules_completed for item in items),
        required_modules_total=sum(item.required_modules_total for item in items),
    )


def _usage(items: list[RuntimeUsage]) -> RuntimeUsage | None:
    if not items:
        return None
    return RuntimeUsage(
        module_invocations=sum(item.module_invocations for item in items),
        evaluator_invocations=sum(item.evaluator_invocations for item in items),
        text_characters=sum(item.text_characters for item in items),
        rail_invocations=sum(item.rail_invocations for item in items),
        action_invocations=sum(item.action_invocations for item in items),
        model_invocations=sum(item.model_invocations for item in items),
        cache_hits=sum(item.cache_hits for item in items),
        cache_misses=sum(item.cache_misses for item in items),
        queue_latency_ms=sum(item.queue_latency_ms for item in items),
        runtime_engine=_one_value(tuple(item.runtime_engine for item in items)),
        runtime_profile=_one_value(tuple(item.runtime_profile for item in items)),
        config_checksum=_one_value(tuple(item.config_checksum for item in items)),
        fail_closed=any(item.fail_closed for item in items),
        active_concurrency=max(
            (item.active_concurrency for item in items),
            default=0,
        ),
        provider_latency_ms=sum(item.provider_latency_ms for item in items),
        provider_work_latency_ms=sum(
            item.provider_work_latency_ms or item.provider_latency_ms
            for item in items
        ),
        model_wait_latency_ms=sum(item.model_wait_latency_ms for item in items),
    )


def _one_value(values: tuple[str, ...]) -> str:
    populated = tuple(dict.fromkeys(value for value in values if value))
    return populated[0] if len(populated) == 1 else "mixed" if populated else ""
