"""Replay a recorded decision from evidence, not from retained traffic.

A schedule is an optimisation, so the evidence it produces must be
schedule-independent. This suite fixes the record shape an operator could
persist for offline replay - digests, per-step verdicts and matched Rules, never
request text - and proves three things:

* two legal schedules of one plan produce the same record;
* the recorded evidence predicts what the fast path decides, so a schedule
  change can be reviewed offline without re-running traffic;
* the record still changes when the plan semantics change, so the comparison is
  not a tautology.

Persisting these records is the `captureMode=evidence` follow-up described in
`docs/policy-scheduling-optimization-design.zh-CN.md`. No plaintext is needed for
this class of replay, which is why shadow traffic capture is not a prerequisite.
"""
from __future__ import annotations

import hashlib
import json
from copy import deepcopy

import pytest

from runner.compiler import DefaultRunnerCompiler
from runner.draft_preview import DraftPreviewRuntime
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.actions import local_action_providers
from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext
from tests.control_plane.test_schedule_invariance import _controller_plans, authored_schedule


def digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:16]


def plan_semantics(plan: dict) -> list[dict]:
    """The parts of a plan a replay depends on, independent of schedule order."""
    semantics = [
        {
            "id": step["id"],
            "action": step["on_unsafe"],
            "view": dict(step["parameters"]).get("evaluation_view"),
            "precedence": dict(step["parameters"]).get("precedence"),
            "trigger": [step["trigger"]["type"], step["trigger"].get("step_ref")],
        }
        for step in plan["steps"]
    ]
    return sorted(semantics, key=lambda item: item["id"])


async def evaluate(plan: dict, text: str, scope: str) -> object:
    runtime = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers(*local_action_providers()))
    try:
        return await runtime.evaluate(
            ProtectionRequest(phase="input", texts=(text,), evidence_scope=scope,
                              context=RequestContext(protocol="replay")),
            preview_id=f"replay-{scope}-{len(plan['steps'])}", guardrail_id=plan["guardrail_id"],
            draft_revision=1, candidate_version=plan["guardrail_version"], plan=plan, runtime_profile="auto")
    finally:
        await runtime.shutdown()


def evidence_record(plan: dict, text: str, decision) -> dict:
    """The replay record: what happened, never what was said."""
    return {
        "caseId": "reviewed-case",
        "phase": "input",
        "inputDigest": digest(text),
        "planDigest": digest(plan_semantics(plan)),
        # Deliberately schedule-dependent: a reviewer can see that the two
        # recordings came from different execution orders.
        "scheduleDigest": digest([step["id"] for step in plan["steps"]]),
        "decision": decision.decision,
        "outputDigest": digest(decision.texts[0]) if decision.texts else "",
        "steps": sorted(
            ({"id": step.id, "status": step.status, "verdict": step.verdict}
             for step in decision.trace if step.kind == "action"),
            key=lambda item: item["id"]),
        "findings": sorted(
            ({"policyId": finding.policy_id, "ruleId": finding.rule_id, "verdict": finding.verdict,
              "action": finding.recommended_action, "taxonomy": finding.taxonomy_id}
             for finding in decision.findings),
            key=lambda item: (item["policyId"] or "", item["ruleId"] or "", item["taxonomy"] or "")),
    }


def predicted_decision(record: dict) -> str:
    """Re-adjudicate recorded evidence the way the fast path would decide."""
    actions = {item["action"] for item in record["findings"] if item["verdict"] == "matched"}
    if "block" in actions:
        return "block"
    if "transform" in actions:
        return "transform"
    return "allow"


def without_schedule(record: dict) -> dict:
    return {key: value for key, value in record.items() if key != "scheduleDigest"}


@pytest.fixture(scope="module")
def plan() -> dict:
    return _controller_plans()["mix"]


async def record_for(plan: dict, text: str = "alpha beta") -> dict:
    return evidence_record(plan, text, await evaluate(plan, text, "full"))


@pytest.mark.asyncio
async def test_two_legal_schedules_produce_one_replay_record(plan) -> None:
    scheduled = await record_for(plan)
    alternative = await record_for(authored_schedule(plan))

    assert scheduled["scheduleDigest"] != alternative["scheduleDigest"], "the schedules must really differ"
    assert without_schedule(scheduled) == without_schedule(alternative)


@pytest.mark.asyncio
async def test_recorded_evidence_predicts_the_fast_path(plan) -> None:
    recorded = await record_for(plan)
    fast = await evaluate(plan, "alpha beta", "interventions")
    assert fast.decision == recorded["decision"] == "block"
    assert predicted_decision(recorded) == fast.decision
    # The fast path deliberately skips work; the record still explains the result.
    fast_actions = [step for step in fast.trace if step.kind == "action"]
    assert len(fast_actions) < len(recorded["steps"])


@pytest.mark.asyncio
async def test_the_record_never_carries_request_or_output_text(plan) -> None:
    recorded = await record_for(plan)
    serialized = json.dumps(recorded, sort_keys=True)
    transformed = (await evaluate(plan, "alpha beta", "full")).texts
    assert "alpha" not in serialized
    assert all(text not in serialized for text in transformed)


@pytest.mark.asyncio
async def test_a_semantic_change_is_detected_offline(plan) -> None:
    recorded = await record_for(plan)
    changed = deepcopy(plan)
    removed = {step["id"] for step in changed["steps"] if step["id"].endswith(":r-block:rules")}
    changed["steps"] = [step for step in changed["steps"] if step["id"] not in removed]
    changed["modules"] = [module for module in changed["modules"] if not set(module["step_ids"]) & removed]
    for module in changed["modules"]:
        module["depends_on"] = []

    replayed = await record_for(changed)
    assert replayed["planDigest"] != recorded["planDigest"]
    assert replayed["decision"] != recorded["decision"]
    assert predicted_decision(replayed) == replayed["decision"]
    assert {item["ruleId"] for item in replayed["findings"]} != {item["ruleId"] for item in recorded["findings"]}
