"""Execution constraints for collecting complete Rule evidence."""

from ..runtime.contracts import GuardrailPlanSnapshot, NeMoConfigSnapshot


PLAN_COMPILER_VERSION = "tasklattice-controller-plan-v16-explicit-views"
NEMO_COMPILER_VERSION = "tasklattice-nemo-config-v29-single-contract"


def validate_artifact_execution_contract(plan: GuardrailPlanSnapshot, config: NeMoConfigSnapshot) -> None:
    """Reject unsupported signed content before activation, never reinterpret it."""
    recovery = "Recompile and publish a new Guardrail version with the current Controller and Runner before activating it."
    if plan.compiler_version != PLAN_COMPILER_VERSION or config.compiler_version != NEMO_COMPILER_VERSION:
        raise ValueError(
            "artifact_recompile_required: Unsupported Artifact execution contract "
            f"(plan={plan.compiler_version!r}, compiler={config.compiler_version!r}). {recovery}"
        )
    for kind, items in (("Step", plan.steps), ("Action", config.action_bindings)):
        for item in items:
            views = [value for key, value in item.parameters if key == "evaluation_view"]
            if len(views) != 1 or views[0] not in {"original", "previous_output"}:
                raise ValueError(
                    f"artifact_recompile_required: {kind} {item.id!r} must declare exactly one valid evaluation_view. {recovery}"
                )


def complete_evidence_supported(plan: GuardrailPlanSnapshot) -> bool:
    """Whether execution can attempt every reachable check, not certify it.

    Provider availability, determinism and actual target evidence are runtime
    observations. This structural predicate cannot promise complete findings
    or equal results across schedules when provider responses vary.
    """
    # Custom flows control their own execution; windowed streaming needs a
    # separate evidence contract. Neither depends on a compiler version.
    return (
        plan.output_delivery == "full_buffered"
        and all(version.source == "built-in" for version in plan.policy_versions)
    )
