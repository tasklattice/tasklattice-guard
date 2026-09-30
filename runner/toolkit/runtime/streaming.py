"""Delivery guarantees derived from the immutable execution plan, not UI toggles."""
from dataclasses import dataclass

from .contracts import GuardrailPlanSnapshot, OutputDeliveryMode


@dataclass(frozen=True, slots=True)
class OutputStreamContract:
    requested_mode: OutputDeliveryMode
    effective_mode: OutputDeliveryMode
    reason: str


def output_stream_contract(plan: GuardrailPlanSnapshot) -> OutputStreamContract:
    requested = plan.output_delivery
    if requested == "full_buffered":
        return OutputStreamContract(requested, requested, "Complete response checked before release.")
    # Pattern/PII redaction, grounding, formal reasoning and arbitrary Colang
    # programs have no finite-prefix safety guarantee. Do not invent one from
    # chunk size, model callability, or an operator's preferred delivery mode.
    steps = plan.steps_for("output")
    versions = {(version.policy_id, version.version): version for version in plan.policy_versions}
    complete_response_policy = False
    for selected in plan.policy_bindings:
        version = versions.get((selected.policy_id, selected.policy_version))
        if version is None or "output" not in selected.enabled_rails:
            # Declarative local Policies are represented by the executable
            # steps below. Unselected snapshots are not part of execution.
            continue
        enabled = set(selected.enabled_rule_ids)
        output_enabled = any(
            rail.rail_type == "output"
            and (not enabled or f"flow/output/{rail.flow_name}" in enabled)
            for rail in version.rail_bindings
        )
        if output_enabled and (
            version.source != "built-in"
            or dict(version.execution_contract).get("output_delivery") == "full_buffered"
        ):
            complete_response_policy = True
            break
    # Built-in native flows are compiled to the same steps as catalog model
    # assignments; their mere presence is not evidence of arbitrary Colang.
    incremental = not complete_response_policy and all(
        step.capability == "content_safety" and step.on_unsafe in {"block", "report", "allow"}
        for step in steps
    )
    if not incremental:
        return OutputStreamContract(requested, "full_buffered",
                                    "Output rules require complete-response checks; text is held until final=true.")
    return OutputStreamContract(requested, requested,
                                "Checks accumulated output before release. Earlier released text cannot be recalled; cancel upstream on terminate=true.")
