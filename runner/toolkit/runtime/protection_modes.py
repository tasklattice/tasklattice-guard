"""Resource operating modes preserve detector evidence without enforcing it."""
from dataclasses import replace

from .content_views import text_blocks
from .contracts import ContentBlockResult, PlanResolution, ProtectionRequest, ProtectionDecision, RuntimeCoverage, RuntimeTraceStep, RuntimeUsage


def allowed_decision(request: ProtectionRequest, resolution: PlanResolution, mode: str, *,
                     detected: ProtectionDecision | None = None, error: str | None = None) -> ProtectionDecision:
    blocks = request.content_blocks or text_blocks(request.phase, request.texts,
        request.context.value("field", "target_source") or "user_input")
    status = "bypassed" if mode == "bypass" else "error" if error else "observed"
    trace = RuntimeTraceStep(id=f"protection-mode:{mode}", kind="protection_mode",
        name=mode, status=status,
        detail="Emergency bypass: detection was skipped." if mode == "bypass"
        else "Monitor mode: detector evidence is recorded; original content is allowed.",
        guardrail_id=resolution.plan.guardrail_id, guardrail_version=resolution.plan.guardrail_version)
    base = detected or ProtectionDecision(decision="allow", action="allow",
        guardrail_id=resolution.plan.guardrail_id, guardrail_version=resolution.plan.guardrail_version,
        router_id=resolution.router_id, endpoint_id=resolution.endpoint_id,
        output_delivery=resolution.plan.output_delivery, effective_release_id=resolution.effective_release_id,
        model_revision_id=resolution.model_revision_id, route_assignment=resolution.route_assignment,
        trace=resolution.trace, coverage=RuntimeCoverage(status="none"), usage=RuntimeUsage())
    observed = None
    if detected is not None:
        error = error or ("detection_failed" if (detected.usage and detected.usage.fail_closed)
            or any(a.status in {"error", "needs_context", "uncovered"} for a in detected.assessments)
            or any(f.verdict == "error" for f in detected.findings)
            or (detected.coverage and detected.coverage.required_modules_completed < detected.coverage.required_modules_total)
            else None)
        actions = {f.recommended_action for f in detected.findings if f.verdict == "matched"}
        actions.update(f.action for a in detected.assessments if a.status in {"intervene", "uncertain"} for f in a.fragments)
        observed = "block" if detected.decision == "block" or "block" in actions else "transform" if detected.decision == "transform" or actions & {"mask", "redact", "replace", "transform"} else "allow"
    return replace(base, decision="allow", action="allow", texts=(), interventions=(),
        reason=trace.detail, protection_mode=mode, mode="detect" if mode == "monitor" else request.mode,
        detection_decision="error" if error else observed, detection_error=error,
        trace=(*base.trace, replace(trace, status="error" if error else status)),
        usage=replace(base.usage, fail_closed=False) if base.usage else None,
        content_results=tuple(ContentBlockResult(id=b.id, role=b.role, source=b.source,
            decision="allow", action="allow", text=b.text,
            evaluated=mode == "monitor" and detected is not None and not error and b.guard_content and b.trust != "trusted") for b in blocks))
