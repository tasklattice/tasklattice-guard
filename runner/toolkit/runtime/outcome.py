"""Authoritative Guardrail outcomes. Wire adapters never adjudicate evidence."""
from dataclasses import replace

from .contracts import ExecutionDiagnostic, ExecutionPurpose, ProtectionDecision

class GuardrailExecutionError(RuntimeError):
    def __init__(self, decision: ProtectionDecision):
        self.decision = decision
        self.timed_out = decision.execution_status == "timeout"
        self.code = "guardrail_timeout" if self.timed_out else "guardrail_execution_failed"
        cause = next((d for d in decision.diagnostics if d.affects_result), None)
        super().__init__(cause.message if cause else "Guardrail execution failed.")


def finalize_decision(decision: ProtectionDecision, *, purpose: ExecutionPurpose = "online", require_coverage: bool = False) -> ProtectionDecision:
    """Separate a conclusive disposition from independent detector failures.

    Only the engine can certify policy_block/policy_unknown, using terminal
    results and their effective actions. Raw findings cannot certify a Block.
    """
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
                "A required check timed out." if step.timed_out else "A Guardrail check failed.",
                step.id, step.policy_id,
                affects_result=(step.module_id, step.content_block_id) not in failed_open and
                    module_status.get((step.module_id, step.content_block_id), "error") in {"error", "uncovered", "needs_context"}))
    for item in decision.assessments:
        if item.status in {"error", "needs_context"} or item.status == "uncovered" and not terminal:
            diagnostics.append(ExecutionDiagnostic(item.status,
                {"error": "A Guardrail module failed.", "needs_context": "A required check is missing context.",
                 "uncovered": "A required module was not evaluated."}[item.status], item.module_id,
                affects_result=item.status != "error" or (item.module_id, item.content_block_id) not in failed_open))
    coverage = decision.coverage
    all_incomplete_failed_open = any(a.status == "error" for a in decision.assessments) and all(
        a.status in {"pass", "allow", "intervene", "uncertain"} or
        a.status == "error" and (a.module_id, a.content_block_id) in failed_open for a in decision.assessments)
    if not terminal and not all_incomplete_failed_open and (require_coverage and (coverage is None or coverage.required_modules_total < 1)
                         or coverage is not None and (coverage.status != "complete"
                             or coverage.required_modules_completed != coverage.required_modules_total)):
        diagnostics.append(ExecutionDiagnostic("incomplete_coverage", "Required Guardrail coverage is incomplete."))
    if decision.detection_error:
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
    return replace(decision, execution_status=status, termination_reason=reason,
        diagnostics=diagnostics,
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
