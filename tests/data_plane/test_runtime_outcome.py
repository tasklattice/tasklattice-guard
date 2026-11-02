"""Only the Guardrail adjudicates execution status and terminal policy results."""
from dataclasses import replace
import pytest
from runner.toolkit.runtime.contracts import ModuleAssessment, ProtectionDecision, RuntimeCoverage, RuntimeUsage
from runner.toolkit.runtime.outcome import finalize_decision, require_online_result, GuardrailExecutionError

COVERAGE = RuntimeCoverage(required_modules_total=1, required_modules_completed=1, guarded_items=1, total_items=1)


def decision(action="allow", status="allow", **kwargs):
    return ProtectionDecision(decision=action, action=action, coverage=COVERAGE,
        termination_reason="policy_block" if action == "block" and status == "intervene" else None,
        assessments=(ModuleAssessment(module_id="m", module="interaction_safety", status=status,
            fragments=(), coverage=COVERAGE),), **kwargs)


def check(value):
    return require_online_result(finalize_decision(value, require_coverage=True))


@pytest.mark.parametrize("d", [
    replace(decision(), coverage=None), replace(decision(), coverage=RuntimeCoverage()),
    decision(status="needs_context"), decision(status="error"), decision(status="uncovered"),
    decision("block", "error", usage=RuntimeUsage(fail_closed=True)),
    replace(decision(), coverage=replace(COVERAGE, status="partial", required_modules_completed=0)),
])
def test_unknown_error_and_missing_coverage_are_not_safe(d):
    with pytest.raises(GuardrailExecutionError) as caught:
        check(d)
    assert caught.value.decision.execution_status == "error"


def test_short_circuit_does_not_fabricate_passes():
    d = decision("block", "intervene")
    d = replace(d, assessments=(*d.assessments, replace(d.assessments[0], status="uncovered")),
        coverage=replace(COVERAGE, status="partial", required_modules_total=2))
    check(d)
    result = check(replace(d, assessments=(*d.assessments, replace(d.assessments[0], status="error"))))
    assert result.execution_status == "complete"
    assert result.diagnostics and not any(d.affects_result for d in result.diagnostics)


@pytest.mark.parametrize("status", ["error", "needs_context", "uncovered"])
def test_uncertain_block_does_not_hide_an_incomplete_sibling(status):
    d = decision("block", "uncertain")
    d = replace(d, assessments=(*d.assessments, replace(d.assessments[0], status=status)))
    with pytest.raises(GuardrailExecutionError):
        check(d)


def test_uncertain_block_requires_complete_coverage_and_no_execution_failure():
    d = decision("block", "uncertain")
    for invalid in [replace(d, coverage=replace(COVERAGE, status="partial")),
                    replace(d, usage=RuntimeUsage(fail_closed=True))]:
        with pytest.raises(GuardrailExecutionError):
            check(invalid)




def test_raw_match_is_not_a_certificate_for_an_error_block():
    from runner.toolkit.runtime.contracts import RiskFinding
    d = decision("block", "error", usage=RuntimeUsage(fail_closed=True), findings=(
        RiskFinding(risk="test", taxonomy_id="test", verdict="matched", confidence=1, evidence="synthetic match", recommended_action="block"),))
    with pytest.raises(GuardrailExecutionError):
        check(d)


def test_fail_open_does_not_hide_an_unrelated_missing_context():
    from runner.toolkit.runtime.contracts import RuntimeTraceStep
    base = decision(status="error", trace=(RuntimeTraceStep(id="check", kind="action", name="check",
        status="error", detail="synthetic failure", module_id="m", route="fail_open"),))
    assert check(base).execution_status == "degraded"
    missing = replace(base.assessments[0], module_id="missing", status="needs_context")
    with pytest.raises(GuardrailExecutionError, match="missing context"):
        check(replace(base, assessments=(*base.assessments, missing)))


def test_invalid_transform_fails_but_empty_string_is_a_valid_transform():
    with pytest.raises(GuardrailExecutionError) as caught:
        check(decision("transform", "intervene"))
    assert caught.value.decision.diagnostics[0].code == "invalid_transform"
    assert check(decision("transform", "intervene", texts=("",))).execution_status == "complete"


def test_fail_closed_always_keeps_a_fatal_diagnostic_with_mixed_fallbacks():
    from runner.toolkit.runtime.contracts import RuntimeTraceStep
    value = decision(status="error", usage=RuntimeUsage(fail_closed=True),
        trace=(RuntimeTraceStep(id="fallback", kind="action", name="fallback", detail="Synthetic fallback",
            status="error", module_id="m", route="fail_open"),))
    with pytest.raises(GuardrailExecutionError) as failed:
        check(value)
    assert failed.value.decision.termination_reason == "fail_closed"
    assert any(d.code == "fail_closed" and d.affects_result for d in failed.value.decision.diagnostics)
