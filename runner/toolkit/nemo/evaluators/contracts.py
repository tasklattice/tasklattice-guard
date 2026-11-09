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
    ExecutionPurpose,
    EVALUATOR_VERDICTS,
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
    guardrail_version: str
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
    execution_purpose: ExecutionPurpose = "online"
    content_view: ContentViewSnapshot | None = None
    active_block_id: str | None = None
    request_context: RequestContext | None = None
    request_started_at: float = 0.0


ModelCallResult = Literal[
    "success",
    "cancelled",
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
    error_source: str | None = None
    error_category: str | None = None
    http_status: int | None = None
    call_id: str = ""
    queue_duration_ms: int = 0
    request_sent: bool | None = None
    usage_known: bool = False
    cached_input_tokens: int = 0
    unsupported_usage: bool = False


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
    proposed_action: EnforcementAction = "allow"
    evidence: str = ""
    reason: str | None = None
    trace: tuple[RuntimeTraceStep, ...] = ()
    usage: EvaluationUsage = EvaluationUsage()
    # Successful classifier abstention is distinct from an incomplete check.
    # Previous/unspecified unknown results remain conservative.
    unknown_reason: Literal["uncertain", "needs_context"] = "needs_context"

    def __post_init__(self) -> None:
        if self.verdict not in EVALUATOR_VERDICTS:
            raise ValueError("Detector result must be matched, not_matched, unknown, or error.")
        if self.unknown_reason not in {"uncertain", "needs_context"}:
            raise ValueError("Invalid unknown-result reason.")


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
    unknown_reason: Literal["uncertain", "needs_context"] = "needs_context",
    error_source: str | None = None,
    error_category: str | None = None,
) -> EvaluationResult:
    """Build the normalized result returned by every Guard evaluator."""

    if error_source and verdict == "error":
        from dataclasses import replace
        trace = tuple(replace(step, error_source=error_source, error_category=error_category) for step in trace) or (
            RuntimeTraceStep(id=f"{request.binding.id}:preflight", kind="evaluation", name=request.binding.action_name or request.binding.id,
                status="error", verdict="error", detail=reason or "Check configuration failed.",
                error_source=error_source, error_category=error_category, policy_id=request.policy_id),
        )
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
        unknown_reason=unknown_reason,
    )
