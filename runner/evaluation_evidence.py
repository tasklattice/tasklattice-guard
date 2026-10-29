"""Opt-in, bounded classifier evidence without input text or free-form model output."""
from __future__ import annotations

import json
import math
import re

from .toolkit.runtime.contracts import ProtectionDecision

REQUEST_HEADER = "x-guard-evidence"
RESPONSE_HEADER = "x-guard-evaluation-evidence"
EVIDENCE_VERSION = "evaluations-v1"
MAX_HEADER_BYTES = 6000
_IDENTITY = re.compile(r"[A-Za-z0-9_.:/-]{1,160}\Z")


def _identity(value):
    return value if isinstance(value, str) and _IDENTITY.fullmatch(value) else None


def execution_status(decision: ProtectionDecision) -> str:
    if decision.protection_mode == "bypass":
        return "bypassed"
    failed = (decision.detection_error or decision.usage and decision.usage.fail_closed
              or any(item.verdict == "error" for item in decision.findings)
              or any(item.kind in {"action", "rail", "runtime", "evaluator", "evaluation"}
                     and (item.timed_out or item.verdict == "error"
                          or item.status in {"error", "failed", "timeout"}) for item in decision.trace))
    return "error" if failed else "complete"


def evaluation_evidence(decision: ProtectionDecision) -> str:
    payload = {"schemaVersion": 1, "complete": bool(decision.guardrail_id),
               "protectionMode": decision.protection_mode,
               "modelRevisionId": _identity(decision.model_revision_id), "evaluations": [],
               "execution": {"status": execution_status(decision),
                             "failClosed": bool(decision.usage and decision.usage.fail_closed),
                             "errorTypes": sorted({step.error_type for step in decision.trace
                                 if step.error_type and re.fullmatch(r"[A-Za-z0-9_-]{1,64}", step.error_type)})[:8]}}
    context_step = next((step for step in decision.trace if step.id == "context:redis-capacity"), None)
    if context_step:
        payload["context"] = {"status": "degraded", "reason": "redis_capacity",
                              "historyAvailable": json.loads(context_step.evidence or "{}").get("historyAvailable", False),
                              "currentContentChecked": execution_status(decision) == "complete"}
    evaluator_capabilities = {"typesafe-jev-jailbreak": "jailbreak", "typesafe-jev-content-safety": "content_safety",
                              "typesafe-jev-topic": "topic_control"}
    probability_keys = {"jailbreak": {"jailbreak_attempt", "unsafe_pretext"}, "content_safety": {"unsafe_content"},
                        "topic_control": {"denied_task", "unlisted_task"}}
    traces = [s for s in decision.trace if s.kind == "evaluation"
              and evaluator_capabilities.get(s.evaluator_id) == s.capability and s.evaluator_id in evaluator_capabilities]
    # Failed calls may have only the enclosing model action, without a custom evaluation step.
    traces += [s for s in decision.trace if s.kind == "action" and s.capability in evaluator_capabilities.values()
               and s.profile_ref in {"tali.typesafe-jev.v1", "tali.typesafe-jev-topic.v1"}
               and not any(e.policy_id == s.policy_id and e.capability == s.capability and e.content_block_id == s.content_block_id for e in traces)]
    for step in traces:
        if step.verdict not in {"matched", "not_matched", "unknown", "error"}:
            payload["complete"] = False
            continue
        binding_id = step.id.removesuffix(":jev").removeprefix("nemo:action:")
        enforced = next((i.kind for i in decision.interventions
                         if i.fragment_id == f"nemo:{binding_id}:{i.kind}"
                         and i.content_block_id == step.content_block_id), None)
        row = {"evaluatorId": next(k for k, v in evaluator_capabilities.items() if v == step.capability), "capability": step.capability,
               "model": _identity(step.model_name), "policyId": _identity(step.policy_id),
               "verdict": step.verdict,
               "enforcedAction": enforced if decision.protection_mode == "enforce" else None}
        try:
            native = json.loads(step.evidence or "{}")
            if not isinstance(native, dict):
                native = {}
            row["questionRevision"] = _identity(native.get("question_revision"))
            thresholds = native.get("thresholds", {})
            if (isinstance(thresholds, dict) and all(type(thresholds.get(k)) in (int, float)
                    and math.isfinite(thresholds[k]) for k in ("lower", "upper"))
                    and 0 <= thresholds["lower"] < thresholds["upper"] <= 1):
                row["thresholds"] = {k: thresholds[k] for k in ("lower", "upper")}
            judgments = native.get("judgments", {})
            if isinstance(judgments, dict):
                row["probabilities"] = {k: answer["probability"] for k, answer in judgments.items()
                    if k in probability_keys[step.capability] and isinstance(answer, dict)
                    and type(answer.get("probability")) in (int, float)
                    and math.isfinite(answer["probability"]) and 0 <= answer["probability"] <= 1}
        except (ValueError, TypeError):
            pass
        payload["evaluations"].append(row)
        if len(json.dumps(payload, separators=(",", ":"))) > MAX_HEADER_BYTES:
            payload["evaluations"].pop()
            payload["complete"] = False
            break
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=True)
