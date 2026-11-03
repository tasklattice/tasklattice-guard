"""Authoritative Guardrail outcomes. Wire adapters never adjudicate evidence."""
from dataclasses import replace

from .contracts import ExecutionDiagnostic, ExecutionPurpose, ProtectionDecision, RuntimeTraceStep

# Product-owned descriptions only: exception strings and evaluator reasons can
# contain request content or credentials and must not enter plaintext telemetry.
DIAGNOSTIC_MESSAGES = {
    "authentication": "The model service rejected the configured credentials.",
    "permission": "The model service denied access to the requested model.",
    "not_found": "The configured model or endpoint was not found.",
    "request_rejected": "The model service rejected the request contract or parameters.",
    "rate_limit": "The model service rejected the call because of a rate or quota limit.",
    "connection": "The Runner could not connect to the model service.",
    "timeout": "The model call did not complete within its time budget.",
    "json_decode": "The model responded, but its output was not valid JSON.",
    "response_schema": "The model responded, but its output did not match the configured protocol.",
    "model_uncertain": "The model responded successfully but could not make a conclusive classification.",
    "category_mapping": "The model responded, but its native categories could not be mapped to this check.",
    "review_inconclusive": "The review model returned unknown; it could not resolve the classifier's uncertainty.",
    "missing_query": "Contextual grounding did not run because the request has no query.",
    "missing_grounding_sources": "Contextual grounding did not run because the request has no grounding sources.",
    "missing_grounding_context": "Contextual grounding did not run because the request has neither a query nor grounding sources.",
    "inconclusive": "A required check did not produce a conclusive result. No specific missing context field was recorded.",
}

class GuardrailExecutionError(RuntimeError):
    def __init__(self, decision: ProtectionDecision):
        self.decision = decision
        self.timed_out = decision.execution_status == "timeout"
        self.code = "guardrail_timeout" if self.timed_out else "guardrail_execution_failed"
        cause = next((d for d in decision.diagnostics if d.affects_result), None)
        super().__init__(cause.message if cause else "Guardrail execution failed.")


def _failed(step: RuntimeTraceStep) -> bool:
    return step.timed_out or step.verdict == "error" or step.status in {"error", "failed", "timeout"}


def attribute_trace(trace: tuple[RuntimeTraceStep, ...]) -> tuple[RuntimeTraceStep, ...]:
    """Propagate recorded child causes, never guess responsibility from text."""
    children: dict[str, list[RuntimeTraceStep]] = {}
    for step in trace:
        if step.parent_id:
            children.setdefault(step.parent_id, []).append(step)
    resolved = {}
    def resolve(step, visiting=frozenset()):
        if step.id in resolved:
            return resolved[step.id]
        if step.id in visiting:
            return step
        causes = [resolve(child, visiting | {step.id}) for child in children.get(step.id, ()) if _failed(child)]
        if _failed(step) and not step.error_source:
            sources = {c.error_source for c in causes if c.error_source}
            categories = {c.error_category for c in causes if c.error_category}
            call_ids = {c.model_call_id for c in causes if c.model_call_id}
            statuses = {c.http_status for c in causes if c.http_status}
            step = replace(step,
                error_source=next(iter(sources)) if len(sources) == 1 else "mixed" if sources else "guard",
                error_category=next(iter(categories)) if len(categories) == 1 else "multiple" if categories else "deadline" if step.timed_out else "execution",
                model_call_id=next(iter(call_ids)) if len(call_ids) == 1 else None,
                http_status=next(iter(statuses)) if len(statuses) == 1 else None)
        resolved[step.id] = step
        return step
    return tuple(resolve(step) for step in trace)


def finalize_decision(decision: ProtectionDecision, *, purpose: ExecutionPurpose = "online", require_coverage: bool = False) -> ProtectionDecision:
    """Separate a conclusive disposition from independent detector failures.

    Only the engine can certify policy_block/policy_unknown, using terminal
    results and their effective actions. Raw findings cannot certify a Block.
    """
    decision = replace(decision, trace=attribute_trace(decision.trace))
    terminal = decision.decision == "block" and decision.termination_reason in {"policy_block", "policy_unknown"}
    diagnostics = list(decision.diagnostics)
    module_status = {(a.module_id, a.content_block_id): a.status for a in decision.assessments}
    failed_open = {(s.module_id, s.content_block_id) for s in decision.trace if s.route == "fail_open"}
    for step in decision.trace:
        if step.kind not in {"action", "rail", "runtime", "evaluation", "evaluator"}:
            continue
        if step.timed_out or step.verdict == "error" or step.status in {"error", "failed", "timeout"}:
            diagnostics.append(ExecutionDiagnostic(
                "timeout" if step.timed_out else step.error_type or "check_failed",
                DIAGNOSTIC_MESSAGES.get(step.error_category,
                    "A required check timed out." if step.timed_out else "A Guardrail check failed."),
                step.id, step.policy_id,
                affects_result=(step.module_id, step.content_block_id) not in failed_open and
                    module_status.get((step.module_id, step.content_block_id), "error") in {"error", "uncovered", "needs_context"},
                source=step.error_source or "guard", category=step.error_category or "execution",
                http_status=step.http_status, model_call_id=step.model_call_id))
        elif step.verdict == "unknown" and step.error_category:
            diagnostics.append(ExecutionDiagnostic(step.error_category,
                DIAGNOSTIC_MESSAGES.get(step.error_category, DIAGNOSTIC_MESSAGES["inconclusive"]),
                step.id, step.policy_id,
                affects_result=module_status.get((step.module_id, step.content_block_id)) == "needs_context",
                source=step.error_source or "unknown", category=step.error_category,
                model_call_id=step.model_call_id))
    for item in decision.assessments:
        if item.status == "error" and any(_failed(s) and s.module_id == item.module_id and s.content_block_id == item.content_block_id for s in decision.trace):
            continue
        if item.status in {"error", "needs_context"} or item.status == "uncovered" and not terminal:
            # An unspecified unknown is not evidence of a missing request field.
            # Keep the existing conservative execution outcome, while retaining
            # the evaluator's structured cause and the actual trace identity.
            unknown_steps = [s for s in decision.trace if s.module_id == item.module_id
                and s.content_block_id == item.content_block_id and s.verdict == "unknown"]
            cause = next((s for s in reversed(unknown_steps) if s.error_category),
                         unknown_steps[-1] if unknown_steps else None) if item.status == "needs_context" else None
            if cause and any(d.step_id == cause.id for d in diagnostics):
                continue
            category = (cause.error_category if cause else None) or ("inconclusive" if item.status == "needs_context" else item.status)
            diagnostics.append(ExecutionDiagnostic(category,
                DIAGNOSTIC_MESSAGES.get(category, {"error": "A Guardrail module failed.",
                 "uncovered": "This required check was not reached before processing ended; no result was produced."}.get(item.status,
                 DIAGNOSTIC_MESSAGES["inconclusive"])), cause.id if cause else item.module_id,
                policy_id=cause.policy_id if cause else None,
                affects_result=item.status != "error" or (item.module_id, item.content_block_id) not in failed_open,
                source=(cause.error_source or "unknown") if cause else "unknown" if item.status == "needs_context" else "guard",
                category=category, model_call_id=cause.model_call_id if cause else None))
    coverage = decision.coverage
    all_incomplete_failed_open = any(a.status == "error" for a in decision.assessments) and all(
        a.status in {"pass", "allow", "intervene", "uncertain"} or
        a.status == "error" and (a.module_id, a.content_block_id) in failed_open for a in decision.assessments)
    if not terminal and not all_incomplete_failed_open and not any(d.affects_result for d in diagnostics) and (require_coverage and (coverage is None or coverage.required_modules_total < 1)
                         or coverage is not None and (coverage.status != "complete"
                             or coverage.required_modules_completed != coverage.required_modules_total)):
        diagnostics.append(ExecutionDiagnostic("incomplete_coverage", "Required Guardrail coverage is incomplete."))
    if decision.detection_error and not diagnostics:
        diagnostics.append(ExecutionDiagnostic("detection_failed", "Monitor detection did not complete."))
    fail_closed = bool(decision.usage and decision.usage.fail_closed)
    if fail_closed and not any(d.affects_result for d in diagnostics):
        diagnostics.append(ExecutionDiagnostic("fail_closed", "Guardrail execution failed closed."))
    invalid_transform = decision.decision == "transform" and not decision.texts
    if invalid_transform:
        diagnostics.append(ExecutionDiagnostic("invalid_transform", "The Guardrail did not return transformed content."))
    # Successful fallback is a policy decision; actual provider failures remain
    # visible as degradation rather than becoming an Adapter-specific exception.
    fatal_diagnostics = [d for d in diagnostics if d.affects_result]
    fail_open = bool(failed_open) and not fail_closed and not fatal_diagnostics
    if decision.protection_mode == "bypass":
        status, reason = "bypassed", "bypass"
    elif decision.protection_mode == "monitor":
        status, reason = ("degraded" if diagnostics else "complete"), "monitor"
    elif terminal and purpose == "online":
        status, reason = "complete", decision.termination_reason
    elif fatal_diagnostics or fail_closed:
        status = "timeout" if any(d.code == "timeout" for d in fatal_diagnostics) else "error"
        reason = "fail_closed" if fail_closed else fatal_diagnostics[0].code
    elif fail_open:
        status, reason = "degraded", "fail_open"
    else:
        status, reason = "complete", decision.termination_reason or decision.decision
    fatal = status in {"error", "timeout"}
    diagnostics = tuple(dict.fromkeys(replace(d, affects_result=d.affects_result and fatal) for d in diagnostics))
    calls = decision.usage.model_calls if decision.usage else ()
    sent_calls = tuple(call for call in calls if call.request_sent is not False)
    usage = replace(decision.usage, model_invocations=len(sent_calls)) if calls else decision.usage
    model_status = ("not_called" if not sent_calls else "error" if any(c.result not in {"success", "cancelled"} for c in sent_calls)
                    else "ok" if all(c.result == "success" for c in sent_calls) else "unknown")
    affected_steps = {d.step_id for d in diagnostics if d.affects_result}
    return replace(decision, execution_status=status, termination_reason=reason, model_status=model_status,
        trace=tuple(replace(s, affects_result=s.id in affected_steps) for s in decision.trace),
        diagnostics=diagnostics, usage=usage,
        flagged=decision.protection_mode == "enforce" and (decision.decision in {"block", "transform"}
            or any(item.status == "intervene" for item in decision.assessments)))


def require_online_result(decision: ProtectionDecision) -> ProtectionDecision:
    if decision.execution_status in {"error", "timeout"}:
        raise GuardrailExecutionError(decision)
    return decision


def call_outcome(decision: ProtectionDecision) -> str:
    if decision.execution_status in {"error", "timeout"}:
        return decision.execution_status
    return decision.decision
