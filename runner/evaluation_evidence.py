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
    short_circuit = decision.decision == "block" and any(a.status == "intervene" for a in decision.assessments)
    incomplete = (any(a.status in {"error", "needs_context"} for a in decision.assessments)
                  or not short_circuit and (any(a.status == "uncovered" for a in decision.assessments)
                      or decision.coverage is not None and decision.coverage.status != "complete"))
    failed = (incomplete or decision.detection_error or decision.usage and decision.usage.fail_closed
              or any(item.verdict == "error" for item in decision.findings)
              or any(item.kind in {"action", "rail", "runtime", "evaluator", "evaluation"}
                     and (item.timed_out or item.verdict == "error"
                          or item.status in {"error", "failed", "timeout"}) for item in decision.trace))
    return "error" if failed else "complete"


def evaluation_evidence(decision: ProtectionDecision) -> str:
    payload = {"schemaVersion": 1, "complete": bool(decision.guardrail_id),
               "guardrailId": _identity(decision.guardrail_id),
               "guardrailVersion": _identity(decision.guardrail_version),
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
    # Native classifiers return labels rather than JEV probabilities. Keep them
    # in a separate collection so existing JEV evidence consumers retain their
    # contract and no numerical confidence or threshold is invented.
    native_steps = [s for s in decision.trace if s.kind == "evaluation" and s.evaluator_id == "model-safety"]
    native_profiles = {"tali.qwen3guard.v1", "tali.llama-guard-3.v1", "tali.nemotron-content-safety.v1",
                       "tali.nemotron-safety-guard-v3.v1", "tali.openai-compatible-pii.v1",
                       "tali.openai-compatible-jailbreak.v1", "tali.nemoguard-jailbreak-detect.v1"}
    # An outer Action deadline can cancel the evaluator before its own trace
    # exists. Retain that failed classifier without inventing a model label.
    native_steps += [s for s in decision.trace if s.kind == "action" and s.profile_ref in native_profiles
                     and not any(e.id == f"{s.id.removeprefix('nemo:action:')}:native-safety"
                                 and e.content_block_id == s.content_block_id for e in native_steps)]
    if native_steps:
        payload["classifications"] = []
    for step in native_steps:
        if step.verdict not in {"matched", "not_matched", "unknown", "error"}:
            payload["complete"] = False
            continue
        binding_id = step.id.removesuffix(":native-safety").removeprefix("nemo:action:")
        action_step = next((s for s in decision.trace if s.kind == "action"
                           and s.id == f"nemo:action:{binding_id}"
                           and s.content_block_id == step.content_block_id), None)
        try:
            native = json.loads(step.evidence or "{}")
            handling = json.loads(action_step.evidence or "{}").get("policy_action") if action_step else None
            row = {"evaluatorId": "model-safety", "capability": _identity(step.capability),
                   "model": _identity(step.model_name), "policyId": _identity(step.policy_id),
                   "policyVersion": _identity(step.policy_version), "verdict": step.verdict,
                   "nativeVerdict": native.get("native_verdict") if native.get("native_verdict") in {"safe", "unsafe", "uncertain", "controversial"} else None,
                   "requestedModel": _identity(native.get("requested_model")) or (_identity(step.model_name) if step.kind == "action" else None),
                   "responseModel": _identity(native.get("response_model")),
                   "policyAction": handling if handling in {"allow", "block", "transform"} else None,
                   "enforcedAction": next((i.kind for i in decision.interventions
                       if i.fragment_id == f"nemo:{binding_id}:{i.kind}" and i.content_block_id == step.content_block_id), None)
                       if decision.protection_mode == "enforce" else None}
        except (ValueError, TypeError, AttributeError):
            payload["complete"] = False
            continue
        payload["classifications"].append(row)
        if len(json.dumps(payload, separators=(",", ":"))) > MAX_HEADER_BYTES:
            payload["classifications"].pop()
            payload["complete"] = False
            break
    # Keep Laya evidence separate: JEV consumers must not label it as JEV.
    families = (
        ("evaluations", ":jev", {"typesafe-jev-jailbreak": "jailbreak", "typesafe-jev-content-safety": "content_safety",
                                 "typesafe-jev-topic": "topic_control"},
         {"tali.typesafe-jev.v1", "tali.typesafe-jev-topic.v1"}, None,
         {"jailbreak": {"jailbreak_attempt", "unsafe_pretext"}, "content_safety": {"unsafe_content"},
          "topic_control": {"denied_task", "unlisted_task"}}),
        ("layaEvaluations", ":laya", {"laya-jailbreak": "jailbreak", "laya-content-safety": "content_safety",
                                     "laya-topic": "topic_control"},
         {"tali.laya.v1", "tali.laya-topic.v1"}, "laya",
         {"jailbreak": {"jailbreak_attempt", "unsafe_pretext", "task_hijack", "answer_planting"},
          "content_safety": {"unsafe_content"}, "topic_control": {"denied_task", "unlisted_task"}}),
    )
    for collection, suffix, evaluator_capabilities, profiles, decision_model, probability_keys in families:
        traces = [s for s in decision.trace if s.kind == "evaluation"
                  and evaluator_capabilities.get(s.evaluator_id) == s.capability and s.evaluator_id in evaluator_capabilities]
        # Failed calls may have only the enclosing model action, without a custom evaluation step.
        traces += [s for s in decision.trace if s.kind == "action" and s.capability in evaluator_capabilities.values()
                   and s.profile_ref in profiles
                   and not any(e.policy_id == s.policy_id and e.capability == s.capability and e.content_block_id == s.content_block_id for e in traces)]
        if not traces:
            continue
        payload.setdefault(collection, [])
        for step in traces:
            if step.verdict not in {"matched", "not_matched", "unknown", "error"}:
                payload["complete"] = False
                continue
            binding_id = step.id.removesuffix(suffix).removeprefix("nemo:action:")
            action_step = next((s for s in decision.trace if s.kind == "action"
                                and s.id == f"nemo:action:{binding_id}"
                                and s.content_block_id == step.content_block_id), None)
            enforced = next((i.kind for i in decision.interventions
                             if i.fragment_id == f"nemo:{binding_id}:{i.kind}"
                             and i.content_block_id == step.content_block_id), None)
            row = {"evaluatorId": next(k for k, v in evaluator_capabilities.items() if v == step.capability), "capability": step.capability,
                   "model": _identity(step.model_name), "policyId": _identity(step.policy_id),
                   "policyVersion": _identity(step.policy_version),
                   "verdict": step.verdict,
                   "policyAction": None,
                   "enforcedAction": enforced if decision.protection_mode == "enforce" else None}
            if decision_model is not None:
                row["decisionModel"] = decision_model
            if action_step is not None:
                try:
                    action = json.loads(action_step.evidence or "{}").get("policy_action")
                    if action in {"allow", "block", "transform"}:
                        row["policyAction"] = action
                except (ValueError, TypeError, AttributeError):
                    pass
            try:
                native = json.loads(step.evidence or "{}")
                if not isinstance(native, dict):
                    native = {}
                row["questionRevision"] = _identity(native.get("question_revision"))
                row["requestedModel"] = _identity(native.get("requested_model"))
                row["responseModel"] = _identity(native.get("response_model"))
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
            review_step = next((s for s in decision.trace if s.kind == "evaluation" and s.evaluator_id == "classifier-review"
                               and s.id == f"{binding_id}:review" and s.content_block_id == step.content_block_id), None)
            if review_step is not None:
                try:
                    review = json.loads(review_step.evidence or "{}")
                    answers = review.get("answers", {})
                    attempts = review.get("attempts", [])
                    row["review"] = {"evaluatorId":"classifier-review", "revision":_identity(review.get("review_revision")),
                        "durationMs":review_step.duration_ms,
                        "attempts":[{"result":_identity(a.get("result")),"errorType":_identity(a.get("error_type")),
                                     "durationMs":a.get("duration_ms") if type(a.get("duration_ms")) is int and a["duration_ms"]>=0 else None,
                                     "usageKnown":a.get("usage_known") is True} for a in attempts[:2] if isinstance(a,dict)] if isinstance(attempts,list) else [],
                        "model":_identity(review_step.model_name), "requestedModel":_identity(review.get("requested_model")),
                        "responseModel":_identity(review.get("response_model")), "verdict":review_step.verdict,
                        "answers":{k:v for k,v in answers.items() if k in probability_keys[step.capability] and v in {"yes","no","unknown"}} if isinstance(answers,dict) else {},
                        "policyAction":row["policyAction"], "enforcedAction":row["enforcedAction"],
                        "errorType":_identity(review_step.error_type)}
                    row["decisionSource"] = "review"
                    row["finalPolicyAction"] = row["policyAction"]
                    # The primary model abstained; enforcement belongs to the
                    # explicit review stage. Preserve unknown and its raw scores.
                    row["policyAction"] = "allow"
                    row["enforcedAction"] = None
                except (ValueError, TypeError, AttributeError):
                    payload["complete"] = False
            payload[collection].append(row)
            if len(json.dumps(payload, separators=(",", ":"))) > MAX_HEADER_BYTES:
                payload[collection].pop()
                payload["complete"] = False
                break
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=True)
