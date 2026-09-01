from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol

from ...runtime.content_views import content_view
from ...runtime.contracts import (
    ContentPatch,
    ContentViewSnapshot,
    EnforcementAction,
    EnforcementMode,
    EvidenceScope,
    EvaluatorVerdict,
    GuardContentBlock,
    GuardrailPhase,
    GuardrailPlanSnapshot,
    NeMoActionBinding,
    RequestContext,
    RiskFinding,
    RuntimeTraceStep,
)


@dataclass(frozen=True, slots=True)
class EvaluationRequest:
    """Immutable request shared by local, model, and mock Guard evaluators."""

    content: str
    rail_type: GuardrailPhase
    guardrail_id: str
    guardrail_version: int
    policy_id: str | None
    policy_version: int | None
    trusted_context: tuple[tuple[str, str], ...]
    content_blocks: tuple[GuardContentBlock, ...]
    deadline: float
    parameters: tuple[tuple[str, str], ...]
    capability: str
    proposed_action: EnforcementAction
    plan: GuardrailPlanSnapshot
    binding: NeMoActionBinding
    context_messages: tuple[dict[str, object], ...] = ()
    target_source: str = "user_input"
    mode: EnforcementMode = "enforce"
    evidence_scope: EvidenceScope = "interventions"
    content_view: ContentViewSnapshot | None = None
    active_block_id: str | None = None
    request_context: RequestContext | None = None
    request_started_at: float = 0.0


ModelCallResult = Literal[
    "success",
    "timeout",
    "rate_limited",
    "client_error",
    "server_error",
    "transport_error",
    "invalid_response",
    "configuration_error",
    "unknown_error",
]


@dataclass(frozen=True, slots=True)
class ModelCallUsage:
    """Privacy-safe facts for one external model/provider RPC."""

    provider: str
    model: str
    operation: str
    result: ModelCallResult
    duration_ms: int
    profile_ref: str | None = None
    runtime_ref: str | None = None
    started_offset_ms: int = 0
    finished_offset_ms: int = 0
    time_to_first_token_ms: int | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    retries: int = 0
    backoff_ms: int = 0
    error_type: str = "none"


@dataclass(frozen=True, slots=True)
class EvaluationUsage:
    provider_latency_ms: int = 0
    model_invocations: int = 0
    input_characters: int = 0
    model_calls: tuple[ModelCallUsage, ...] = ()


@dataclass(frozen=True, slots=True)
class EvaluationResult:
    verdict: EvaluatorVerdict
    content: str
    findings: tuple[RiskFinding, ...] = ()
    patches: tuple[ContentPatch, ...] = ()
    confidence: float | None = None
    proposed_action: EnforcementAction = "pass"
    evidence: str = ""
    reason: str | None = None
    trace: tuple[RuntimeTraceStep, ...] = ()
    usage: EvaluationUsage = EvaluationUsage()


class GuardEvaluator(Protocol):
    id: str
    version: str
    capabilities: frozenset[str]
    contracts: frozenset[str]
    rails: frozenset[GuardrailPhase]

    async def evaluate(self, request: EvaluationRequest) -> EvaluationResult: ...


def evaluation_view(request: EvaluationRequest) -> ContentViewSnapshot:
    """Return the immutable content view supplied to a Guard evaluator."""

    if request.content_view is not None:
        return request.content_view
    if not request.content_blocks:
        raise ValueError("A Guard evaluation request must include a content view.")
    active_block_id = request.active_block_id or request.content_blocks[0].id
    return content_view(request.content_blocks, active_block_id)


def evaluation_result(
    request: EvaluationRequest,
    verdict: EvaluatorVerdict,
    content: str,
    *,
    findings: tuple[RiskFinding, ...] = (),
    patches: tuple[ContentPatch, ...] = (),
    reason: str | None = None,
    trace: tuple[RuntimeTraceStep, ...] = (),
    usage: EvaluationUsage = EvaluationUsage(),
) -> EvaluationResult:
    """Build the normalized result returned by every Guard evaluator."""

    confidence = next((item.confidence for item in findings), None)
    return EvaluationResult(
        verdict=verdict,
        content=content,
        findings=findings,
        patches=patches,
        confidence=confidence,
        proposed_action=request.proposed_action,
        evidence=reason or "",
        reason=reason,
        trace=trace,
        usage=usage,
    )
