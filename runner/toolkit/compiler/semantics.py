"""Versioned execution contracts, independent of scheduling choices."""

from ..runtime.contracts import GuardrailPlanSnapshot

PLAN_VERSION = "tasklattice-controller-plan-v16-explicit-views"
RUNNER_CAPABILITY = "tasklattice.explicit-views"


def complete_evidence_supported(plan: GuardrailPlanSnapshot) -> bool:
    # Legacy artifacts and arbitrary custom flows retain their stop behavior.
    # Windowed streaming needs a separate evidence contract.
    return (
        plan.compiler_version == PLAN_VERSION
        and plan.output_delivery == "full_buffered"
        and all(version.source == "built-in" for version in plan.policy_versions)
    )
