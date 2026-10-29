"""Shared native TypeSafe transport, strict Noul parsing and decision evidence."""
from __future__ import annotations

import json
import math
import time

import httpx

from runner.model_validation_diagnostics import record_validation_error, validation_http_hooks
from ...runtime.contracts import ProviderEvidence, RiskFinding, RuntimeTraceStep
from ...safety.taxonomy import taxonomy_for_evaluator
from ..actions.model_call import action_usage, observe_model_call
from ..actions.model_retry import with_connection_retry
from .contracts import EvaluationRequest, EvaluationResult, EvaluationUsage, evaluation_result

JEV_PROFILE = "tali.typesafe-jev.v1"
JEV_TOPIC_PROFILE = "tali.typesafe-jev-topic.v1"
JEV_PROFILES = frozenset({JEV_PROFILE, JEV_TOPIC_PROFILE})
# Initial operating points, not calibrated accuracy/confidence guarantees.
DEFAULT_LOWER_THRESHOLD = 0.1
DEFAULT_UPPER_THRESHOLD = 0.9


def parse_answers(payload: object, question_ids: set[str]) -> tuple[str, dict[str, float]]:
    if not isinstance(payload, dict) or not isinstance(payload.get("model"), str) or not payload["model"].strip():
        raise ValueError("Missing response model.")
    answers = payload.get("answers")
    if not isinstance(answers, dict) or set(answers) != question_ids:
        raise ValueError("Mismatched answer IDs.")
    probabilities = {}
    for key, answer in answers.items():
        if not isinstance(answer, dict) or answer.get("type") != "noul":
            raise ValueError("Expected a Noul answer.")
        value = answer.get("noul")
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 1 or not math.isfinite(value):
            raise ValueError("Invalid Noul probability.")
        probabilities[key] = float(value)
    return payload["model"], probabilities


class JevNoulEvaluator:
    id: str
    scope_label: str
    display_name: str
    operation: str
    question_revision: str
    reasons: dict[str, str]
    version = "1.0.0"
    capabilities: frozenset[str]
    contracts: frozenset[str]
    rails = frozenset({"input"})

    def __init__(self, *, base_url: str, model: str, api_key: str,
                 provider_id: str = "typesafe", timeout_seconds: float = 20,
                 lower_threshold: float = DEFAULT_LOWER_THRESHOLD,
                 upper_threshold: float = DEFAULT_UPPER_THRESHOLD,
                 transport: httpx.AsyncBaseTransport | None = None,
                 skip_tls_verify: bool = False, profile_ref: str, reviewer=None) -> None:
        if not 0 <= lower_threshold < upper_threshold <= 1:
            raise ValueError("Expected 0 <= lower_threshold < upper_threshold <= 1.")
        self._url = base_url.rstrip("/") + "/systemone"
        self._model, self._api_key, self._provider_id = model, api_key, provider_id
        self._timeout, self._transport, self._skip_tls_verify = timeout_seconds, transport, skip_tls_verify
        self._lower, self._upper = lower_threshold, upper_threshold
        self._profile_ref = profile_ref
        self._reviewer = reviewer

    @property
    def review_ready(self) -> bool:
        return self._reviewer is not None

    def questions(self, request: EvaluationRequest) -> dict[str, dict[str, object]]:
        raise NotImplementedError

    def state(self, request: EvaluationRequest) -> dict[str, object]:
        context = [dict(role=m["role"], content=m["content"]) for m in request.context_messages[-12:]
                   if m.get("role") in {"user", "assistant"} and isinstance(m.get("content"), str)]
        if context and context[-1] == {"role": "user", "content": request.content}:
            context.pop()
        return {"current_input": request.content, "context_messages": context}

    def revision(self, request: EvaluationRequest) -> str:
        return self.question_revision

    def _trace(self, request: EvaluationRequest, verdict: str, reason: str,
               probabilities: dict[str, float], actual_model: str | None = None,
               error_type: str | None = None) -> RuntimeTraceStep:
        judgments = {key: {"probability": p, "answer": "yes" if p >= self._upper else "no" if p <= self._lower else "uncertain"}
                     for key, p in probabilities.items()}
        evidence = json.dumps({"profile": self._profile_ref, "question_revision": self.revision(request),
                               "requested_model": self._model, "response_model": actual_model,
                               "thresholds": {"lower": self._lower, "upper": self._upper},
                               "judgments": judgments}, sort_keys=True)
        return RuntimeTraceStep(id=f"{request.binding.id}:jev", kind="evaluation", name=self.display_name,
                                status="error" if verdict == "error" else "completed", detail=reason,
                                evidence=evidence, verdict=verdict, error_type=error_type,
                                timed_out=error_type in {"TimeoutError", "TimeoutException", "ReadTimeout", "ConnectTimeout", "PoolTimeout", "WriteTimeout"},
                                contract_ref=request.binding.contract_ref, capability=request.capability,
                                evaluator_id=self.id, profile_ref=self._profile_ref, model_name=actual_model or self._model,
                                rail_type=request.rail_type, policy_id=request.policy_id,
                                policy_version=request.policy_version, content_block_id=request.active_block_id)

    def _error(self, request: EvaluationRequest, reason: str, *,
               usage: EvaluationUsage = EvaluationUsage(), error_type: str | None = None) -> EvaluationResult:
        # A failed call still proves the requested model and actual operating
        # point. No probability or response model is invented for a failed parse.
        return evaluation_result(request, "error", request.content, reason=reason, usage=usage,
                                 trace=(self._trace(request, "error", reason, {}, error_type=error_type),))

    async def evaluate(self, request: EvaluationRequest) -> EvaluationResult:
        if (request.rail_type not in self.rails or request.capability not in self.capabilities
            or request.binding.contract_ref not in self.contracts):
            return self._error(request, f"Jev supports {self.scope_label} only.")
        call = None
        probabilities: dict[str, float] = {}
        actual_model: str | None = None
        try:
            questions = self.questions(request)
            if questions:
                if not self._api_key.strip():
                    return self._error(request, "Jev credential is not configured.")
                deadline = min(request.deadline, time.monotonic() + self._timeout)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise httpx.TimeoutException("Evaluation deadline exceeded.")
                with observe_model_call(request, provider=self._provider_id, model=self._model,
                                        operation=self.operation, profile_ref=self._profile_ref,
                                        runtime_ref=self._provider_id) as call:
                    async with httpx.AsyncClient(timeout=remaining, transport=self._transport, verify=not self._skip_tls_verify, event_hooks=validation_http_hooks()) as client:
                        body = {
                            "model": self._model,
                            "state": self.state(request),
                            "questions": questions,
                        }
                        def send() -> httpx.Response:
                            # Raise inside the retried operation so an explicit
                            # 429 is recovered instead of failing the case.
                            attempt = client.post(self._url, headers={"authorization": f"Bearer {self._api_key}"}, json=body)
                            return attempt

                        async def guarded() -> httpx.Response:
                            attempt = await send()
                            attempt.raise_for_status()
                            return attempt

                        response = await with_connection_retry(guarded, deadline=deadline, call=call)
                        payload = response.json()
                        actual_model, probabilities = parse_answers(payload, set(questions))
                        call.complete(payload=payload)
        except (httpx.HTTPError, TimeoutError, ValueError, TypeError, KeyError) as error:
            record_validation_error(error)
            return self._error(request, f"Jev {self.scope_label} evaluation failed: {type(error).__name__}.",
                               error_type=type(error).__name__,
                               usage=action_usage(call, len(request.content)) if call is not None else EvaluationUsage())
        verdict = ("matched" if any(p >= self._upper for p in probabilities.values()) else
                   "not_matched" if all(p <= self._lower for p in probabilities.values()) else "unknown")
        reason = self.reasons[verdict]
        # Machine-readable evidence for all outcomes; Noul is not a confidence or severity score.
        trace = self._trace(request, verdict, reason, probabilities, actual_model)
        findings = () if verdict != "matched" else (RiskFinding(
            risk=request.capability, taxonomy_id=taxonomy_for_evaluator(request.capability), verdict="matched",
            confidence=None, evidence=reason, recommended_action=request.proposed_action,
            provider_evidence=(ProviderEvidence(provider_id=self._provider_id, model=actual_model or self._model,
                                               native_verdict=trace.evidence),),
        ),)
        result = evaluation_result(request, verdict, request.content, reason=reason, findings=findings,
                                 trace=(trace,), unknown_reason="uncertain",
                                 usage=action_usage(call, len(request.content)) if call is not None else EvaluationUsage())
        from .classifier_review import review_enabled, unavailable_review
        if verdict == "unknown" and review_enabled(request):
            if self._reviewer is None:
                return unavailable_review(request,result)
            return await self._reviewer.review(request,questions,self.state(request),result)
        return result
