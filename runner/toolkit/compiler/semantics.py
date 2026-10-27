"""Execution constraints for collecting complete Rule evidence."""

from ..runtime.contracts import GuardrailPlanSnapshot


def complete_evidence_supported(plan: GuardrailPlanSnapshot) -> bool:
    # Custom flows control their own execution; windowed streaming needs a
    # separate evidence contract. Neither depends on a compiler version.
    return (
        plan.output_delivery == "full_buffered"
        and all(version.source == "built-in" for version in plan.policy_versions)
    )
