"""Execution constraints for collecting complete Rule evidence."""

import re

from ..runtime.contracts import GuardrailPlanSnapshot, NeMoConfigSnapshot


PLAN_COMPILER_VERSION = "tasklattice-controller-plan-v1"
NEMO_COMPILER_VERSION = "tasklattice-nemo-config-v1"


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
    # The signed plan must also agree with its own executable graph; a load-time
    # gate cannot accept metadata that the compiler would reject.
    try:
        validate_step_contract(plan)
    except ValueError as error:
        raise ValueError(f"artifact_recompile_required: {error} {recovery}") from error


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


def collects_complete_evidence(evidence_scope: str, plan: GuardrailPlanSnapshot) -> bool:
    """Single source of truth for "does this request suppress short-circuiting".

    ``evidence_scope`` answers two different questions at once, which is why the
    mapping lives here instead of in each execution path:

    * reporting: report every conclusive result, not only interventions;
    * control flow: keep evaluating after a Block and stop cancelling siblings.

    Only a supported execution type can honour the second one. An unsupported
    plan (custom Colang, windowed streaming) keeps its early exit even when the
    caller asks for ``full``; its report then says ``not_reached`` rather than
    pretending the check never ran. Splitting the two meanings into separate
    request fields is the follow-up; until then every execution path must ask
    this function so the two answers can never diverge.
    """
    return evidence_scope == "full" and complete_evidence_supported(plan)


def derived_evaluation_view(plan: GuardrailPlanSnapshot, step) -> str:
    """The view the executable trigger graph requires for one step.

    A Transform step inspects the text produced by the Transforms before it, and
    so does every step reachable from it through `on_result` edges. Everything
    else inspects the phase input.
    """
    by_id = {item.id: item for item in plan.steps}
    seen: set[str] = set()
    current = step
    while True:
        if current.on_unsafe == "transform":
            return "previous_output"
        reference = current.trigger.step_ref if current.trigger.type == "on_result" else None
        if reference is None or reference in seen:
            return "original"
        seen.add(reference)
        prerequisite = by_id.get(reference)
        if prerequisite is None:
            # A dangling trigger is rejected by the execution-order validation.
            return "original"
        current = prerequisite


def declared_view(step) -> str | None:
    values = [value for key, value in step.parameters if key == "evaluation_view"]
    return values[0] if len(values) == 1 else None


def declared_precedence(step) -> int | None:
    values = [value for key, value in step.parameters if key == "precedence"]
    if len(values) != 1 or not re.fullmatch(r"0|[1-9][0-9]*", values[0]):
        return None
    return int(values[0])


def validate_step_contract(plan: GuardrailPlanSnapshot) -> None:
    """Reject a plan whose declared metadata contradicts its executable graph.

    Two independent properties are checked, both needed for the schedule to stay
    a pure optimisation:

    * a step that depends on a Transform must declare `previous_output`, so it
      cannot be scheduled ahead of the text it is supposed to inspect;
    * a step's authored `precedence` must follow the steps it triggers on, so
      reporting and any future arbitration read a truthful author order.

    A step may always declare the more conservative `previous_output`: a plan
    with custom Flows keeps the whole plan threaded. Only the dangerous
    direction - declaring `original` where the graph requires derived text - is
    rejected.
    """
    positions = {step.id: declared_precedence(step) for step in plan.steps}
    for step in plan.steps:
        declared = declared_view(step)
        required = derived_evaluation_view(plan, step)
        if required == "previous_output" and declared not in {None, "previous_output"}:
            raise ValueError(
                f"Step {step.id!r} depends on a Transform step and must declare "
                "evaluation_view='previous_output'."
            )
        if step.trigger.type != "on_result":
            continue
        source = step.trigger.step_ref
        if source not in positions:
            continue
        own, prerequisite = positions[step.id], positions[source]
        if own is None or prerequisite is None:
            continue
        if prerequisite >= own:
            raise ValueError(
                f"Step {step.id!r} precedence {own} must follow its trigger "
                f"{source!r} precedence {prerequisite}."
            )
