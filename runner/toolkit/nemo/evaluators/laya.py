"""Shared native Laya transport, strict Noul parsing and decision evidence."""
from __future__ import annotations

import json
import math
import time

import httpx
from ...runtime.failures import ModelResponseError, model_response

from runner.builtin_laya import BUILTIN_LAYA_BACKEND, BuiltinLaya, BuiltinLayaBusyError, BuiltinLayaInferenceError
from runner.model_validation_diagnostics import record_validation_error, validation_http_hooks
from ...runtime.contracts import ProviderEvidence, RiskFinding, RuntimeTraceStep
from ...safety.taxonomy import taxonomy_for_evaluator
from ..actions.model_call import ModelCallTracker, action_usage, observe_model_call
from ..actions.model_retry import with_connection_retry
from .contracts import EvaluationRequest, EvaluationResult, EvaluationUsage, evaluation_result

LAYA_PROFILE = "tali.laya.v1"
LAYA_TOPIC_PROFILE = "tali.laya-topic.v1"
LAYA_PROFILES = frozenset({LAYA_PROFILE, LAYA_TOPIC_PROFILE})
# Initial operating points, not calibrated accuracy/confidence guarantees.
DEFAULT_LOWER_THRESHOLD = 0.1
DEFAULT_UPPER_THRESHOLD = 0.9
# Laya budgets the question separately from the evaluated state. Its default
# 192-token English head silently cuts long questions, even when usage reports
# truncated=false (that flag describes the state only). v2 questions are short;
# dynamic policy/context stays in state where truncation is observable.
MODEL_MAX_LEN = 1024
MODEL_HEAD_MAX_LEN = 512
# The Controller declares the deployment once at model registration. The
# Runner sends the matching body and never probes or rewrites the schema.
LAYA_REQUEST_MODES = frozenset({"native", "compatible"})
DEFAULT_REQUEST_MODE = "compatible"


def validate_request_mode(request_mode: str) -> None:
    if not isinstance(request_mode, str) or request_mode not in LAYA_REQUEST_MODES:
        raise ValueError(f"Laya request mode must be native or compatible, got {request_mode!r}.")


def admission_rejected(response: httpx.Response) -> bool:
    """Recognize Laya's explicit pre-inference capacity rejection only.

    A cancelled Guard scan can finish before the remote CPU forward pass
    releases its slot. This also happens with scan and model concurrency one.
    An arbitrary 503 does not prove that inference was never admitted.
    """
    if response.status_code != 503:
        return False
    try:
        payload = response.json()
    except ValueError:
        return False
    return isinstance(payload, dict) and payload.get("detail") == "server busy, try again later"


class LayaInputTruncatedError(ModelResponseError):
    """The classifier did not see the entire input/policy/context."""

    def __init__(self):
        super().__init__("input_truncated", type(self).__name__)


def check_input_coverage(payload: dict) -> None:
    usage = payload.get("usage")
    if isinstance(usage, dict) and (usage.get("truncated") or usage.get("state_tokens_dropped")):
        raise LayaInputTruncatedError()


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


class LayaNoulEvaluator:
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
    decision_rule = "any_upper_all_lower"

    def __init__(self, *, rate_limit_attempts: int = 3, base_url: str, model: str, api_key: str,
                 provider_id: str = "laya", timeout_seconds: float = 20,
                 lower_threshold: float = DEFAULT_LOWER_THRESHOLD,
                 upper_threshold: float = DEFAULT_UPPER_THRESHOLD,
                 transport: httpx.AsyncBaseTransport | None = None,
                 skip_tls_verify: bool = False, request_mode: str = DEFAULT_REQUEST_MODE,
                 profile_ref: str, reviewer=None, rail_type: str | None = None,
                 builtin_laya: BuiltinLaya | None = None) -> None:
        if not 0 <= lower_threshold < upper_threshold <= 1:
            raise ValueError("Expected 0 <= lower_threshold < upper_threshold <= 1.")
        self._url = base_url.rstrip("/") + "/systemone"
        self._model, self._api_key, self._provider_id = model, api_key, provider_id
        self._timeout, self._transport, self._skip_tls_verify = timeout_seconds, transport, skip_tls_verify
        self._rate_limit_attempts = rate_limit_attempts
        self._lower, self._upper = lower_threshold, upper_threshold
        self._profile_ref = profile_ref
        self._reviewer = reviewer
        self._builtin_laya = builtin_laya
        # The wire budget is fixed once by the Controller's declared deployment
        # mode and recorded verbatim as evidence; it is never negotiated.
        mode = "native" if builtin_laya is not None else request_mode
        validate_request_mode(mode)
        self._request_budget = {"max_len": MODEL_MAX_LEN}
        if mode == "native":
            self._request_budget["head_max_len"] = MODEL_HEAD_MAX_LEN
        self._model_metadata = {"laya_request_mode": mode}
        if builtin_laya is not None:
            self._model_metadata.update(backend=BUILTIN_LAYA_BACKEND, checkpoint_revision=builtin_laya.revision)
        elif mode == "compatible":
            # The strict server applies its own head budget when the field is absent.
            self._model_metadata["head_max_len_source"] = "server_default"
        if rail_type is not None:
            if rail_type not in self.rails:
                raise ValueError(f"Laya {self.id} does not support {rail_type}.")
            self.rails = frozenset({rail_type})

    def questions(self, request: EvaluationRequest) -> dict[str, dict[str, object]]:
        raise NotImplementedError

    def review_questions(self, request: EvaluationRequest) -> dict[str, dict[str, object]]:
        return self.questions(request)

    def state(self, request: EvaluationRequest) -> dict[str, object]:
        context = [dict(role=m["role"], content=m["content"]) for m in request.context_messages[-12:]
                   if m.get("role") in {"user", "assistant"} and isinstance(m.get("content"), str)]
        if context and context[-1] == {"role": "user", "content": request.content}:
            context.pop()
        return {"current_input": request.content, "context_messages": context}

    def model_state(self, request: EvaluationRequest) -> str | dict[str, object]:
        state = self.state(request)
        # Empty JSON scaffolding changes the small encoder's judgment. Keep
        # single-turn text native; preserve structured context when it exists.
        return state if state.get("context_messages") or len(state) > 2 else request.content

    def revision(self, request: EvaluationRequest) -> str:
        return self.question_revision

    def classify(self, probabilities: dict[str, float]) -> str:
        return ("matched" if any(p >= self._upper for p in probabilities.values()) else
                "not_matched" if all(p <= self._lower for p in probabilities.values()) else "unknown")

    def result_content(self, request: EvaluationRequest, verdict: str) -> str:
        """Content returned by a successful classification; PII may transform it."""
        return request.content

    def result_replacement(self, request: EvaluationRequest, verdict: str) -> str | None:
        """Replacement recorded on a matched finding, if the action is transform."""
        return None

    def _trace(self, request: EvaluationRequest, verdict: str, reason: str,
               probabilities: dict[str, float], actual_model: str | None = None,
               error_type: str | None = None, model_metadata: dict | None = None,
               request_budget: dict[str, int] | None = None) -> RuntimeTraceStep:
        judgments = {key: {"probability": p, "answer": "yes" if p >= self._upper else "no" if p <= self._lower else "uncertain"}
                     for key, p in probabilities.items()}
        metadata = {**self._model_metadata, **(model_metadata or {})}
        evidence = json.dumps({"decision_model": "laya", "profile": self._profile_ref, "question_revision": self.revision(request),
                               "decision_rule": self.decision_rule,
                               "requested_model": self._model, "response_model": actual_model,
                               "thresholds": {"lower": self._lower, "upper": self._upper},
                               "request_budget": request_budget if request_budget is not None else dict(self._request_budget),
                               "model_metadata": metadata,
                               "judgments": judgments}, sort_keys=True)
        return RuntimeTraceStep(id=f"{request.binding.id}:laya", kind="evaluation", name=self.display_name,
                                status="error" if verdict == "error" else "completed", detail=reason,
                                evidence=evidence, verdict=verdict, error_type=error_type,
                                timed_out=error_type in {"TimeoutError", "TimeoutException", "ReadTimeout", "ConnectTimeout", "PoolTimeout", "WriteTimeout"},
                                contract_ref=request.binding.contract_ref, capability=request.capability,
                                evaluator_id=self.id, profile_ref=self._profile_ref, model_name=actual_model or self._model,
                                rail_type=request.rail_type, policy_id=request.policy_id,
                                policy_version=request.policy_version, content_block_id=request.active_block_id)

    def _error(self, request: EvaluationRequest, reason: str, *,
               usage: EvaluationUsage = EvaluationUsage(), error_type: str | None = None,
               actual_model: str | None = None, model_metadata: dict | None = None,
               request_budget: dict[str, int] | None = None) -> EvaluationResult:
        # A failed call still proves the requested model and actual operating
        # point. No probability or response model is invented for a failed parse.
        return evaluation_result(request, "error", request.content, reason=reason, usage=usage,
                                 trace=(self._trace(request, "error", reason, {}, actual_model,
                                     error_type=error_type, model_metadata=model_metadata,
                                     request_budget=request_budget),),
                                 error_source="configuration" if not usage.model_calls and error_type is None else None,
                                 error_category="configuration" if not usage.model_calls and error_type is None else None)

    async def evaluate(self, request: EvaluationRequest) -> EvaluationResult:
        result = await self.evaluate_primary(request)
        from .classifier_review import apply_review_transform
        if result.verdict == "unknown" and self._reviewer is not None:
            reviewed = await self._reviewer.review(request, self.review_questions(request), self.state(request), result)
            return apply_review_transform(request, reviewed,
                content=self.result_content(request, reviewed.verdict),
                replacement=self.result_replacement(request, reviewed.verdict))
        return result

    async def _send_http(self, state: str | dict[str, object], questions: dict[str, dict[str, object]],
                         request_budget: dict[str, int], deadline: float, remaining: float,
                         call: ModelCallTracker) -> httpx.Response:
        async with httpx.AsyncClient(timeout=remaining, transport=self._transport, verify=not self._skip_tls_verify,
                                     event_hooks=validation_http_hooks()) as client:
            body = {"model": self._model, "state": state, "questions": questions, **request_budget}

            async def send() -> httpx.Response:
                attempt = await client.post(self._url, headers={"authorization": f"Bearer {self._api_key}"}, json=body)
                attempt.raise_for_status()
                return attempt

            return await with_connection_retry(send, deadline=deadline, call=call,
                                               rate_limit_attempts=self._rate_limit_attempts,
                                               retryable_rejection=admission_rejected)

    async def evaluate_primary(self, request: EvaluationRequest) -> EvaluationResult:
        if (request.rail_type not in self.rails or request.capability not in self.capabilities
            or request.binding.contract_ref not in self.contracts):
            return self._error(request, f"Laya supports {self.scope_label} only.")
        call = None
        probabilities: dict[str, float] = {}
        actual_model: str | None = None
        model_metadata = {}
        request_budget = dict(self._request_budget)
        try:
            questions = self.questions(request)
            if questions:
                if self._builtin_laya is None and not self._api_key.strip():
                    return self._error(request, "Laya credential is not configured.")
                deadline = min(request.deadline, time.monotonic() + self._timeout)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise httpx.TimeoutException("Evaluation deadline exceeded.")
                with observe_model_call(request, provider=self._provider_id, model=self._model,
                                        operation=self.operation, profile_ref=self._profile_ref,
                                        runtime_ref=self._provider_id) as call:
                    state = self.model_state(request)
                    if self._builtin_laya is not None:
                        payload = await self._builtin_laya.predict(state, questions, deadline=deadline, **request_budget)
                    else:
                        response = await self._send_http(state, questions, request_budget, deadline, remaining, call)
                        with model_response():
                            payload = response.json()
                    with model_response():
                        actual_model, probabilities = parse_answers(payload, set(questions))
                        usage = payload.get("usage", {})
                        routing = payload.get("routing", {})
                        model_metadata.update({
                            "usage": {k: usage[k] for k in ("input_tokens", "state_tokens", "state_tokens_dropped", "truncated") if isinstance(usage, dict) and k in usage},
                            "routing": {k: routing[k] for k in ("model", "repo") if isinstance(routing, dict) and k in routing},
                        })
                        check_input_coverage(payload)
                    call.complete(payload=payload)
        except (httpx.HTTPError, TimeoutError, ValueError, TypeError, KeyError,
                BuiltinLayaBusyError, BuiltinLayaInferenceError) as error:
            record_validation_error(error)
            if isinstance(error, LayaInputTruncatedError) and self._reviewer is not None:
                # A well-formed partial answer cannot decide the full request.
                # Keep the failed native call for audit, discard its judgments,
                # and let the configured reviewer inspect the original state.
                reason = "Laya input or policy context was truncated; independent full-context review is required."
                model_metadata.update(coverage="input_truncated", discarded_probabilities=probabilities)
                trace = self._trace(request, "unknown", reason, {}, actual_model,
                                    model_metadata=model_metadata, request_budget=request_budget)
                return evaluation_result(request, "unknown", request.content, reason=reason,
                    trace=(trace,), unknown_reason="uncertain",
                    usage=action_usage(call, len(request.content)) if call is not None else EvaluationUsage())
            detail = " Input or policy context was truncated; no complete classification is available." if isinstance(error, LayaInputTruncatedError) else ""
            return self._error(request, f"Laya {self.scope_label} evaluation failed: {type(error).__name__}.{detail}",
                               error_type=type(error).__name__,
                               actual_model=actual_model, model_metadata=model_metadata,
                               request_budget=request_budget,
                               usage=action_usage(call, len(request.content)) if call is not None else EvaluationUsage())
        verdict = self.classify(probabilities)
        reason = self.reasons[verdict]
        # Machine-readable evidence for all outcomes; Noul is not a confidence or severity score.
        trace = self._trace(request, verdict, reason, probabilities, actual_model,
                            model_metadata=model_metadata, request_budget=request_budget)
        findings = () if verdict != "matched" else (RiskFinding(
            risk=request.capability, taxonomy_id=taxonomy_for_evaluator(request.capability), verdict="matched",
            confidence=None, evidence=reason, recommended_action=request.proposed_action,
            replacement=self.result_replacement(request, verdict),
            provider_evidence=(ProviderEvidence(provider_id=self._provider_id, model=actual_model or self._model,
                                               native_verdict=trace.evidence),),
        ),)
        result = evaluation_result(request, verdict, self.result_content(request, verdict),
                                 reason=reason, findings=findings,
                                 trace=(trace,), unknown_reason="uncertain",
                                 usage=action_usage(call, len(request.content)) if call is not None else EvaluationUsage())
        return result
