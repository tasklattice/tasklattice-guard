from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Protocol

from .enforcement_action_generated import (
    ENFORCEMENT_ACTIONS,
    ENFORCEMENT_ACTION_CONFLICT_ORDER,
    EnforcementAction,
)


GuardrailPhase = Literal["input", "output"]
RailType = Literal["input", "output", "retrieval", "dialog", "execution"]
# Raw evaluator evidence. It does not directly determine how an interaction is
# handled; routing and policy resolution produce the decision below.
EvaluatorVerdict = Literal["safe", "unsafe", "uncertain", "error"]
RouteDecision = Literal["complete", "enforce", "escalate", "fail_open", "fail_closed"]
# Coarse runtime outcome aligned with allow/block/transform rail semantics.
# EnforcementAction is the separate, more specific post-decision directive.
PolicyDecision = Literal["allow", "transform", "block"]
PolicyModule = Literal[
    "data_protection",
    "interaction_safety",
    "business_assurance",
]
ContentView = Literal["original", "masked", "previous_output", "complete_output"]
ContentRole = Literal[
    "trusted_instruction",
    "user_input",
    "query",
    "retrieved_content",
    "grounding_source",
    "tool_output",
    "model_output",
]
ContentTrust = Literal["trusted", "untrusted"]
ContentQualifier = Literal["guard_content", "query", "grounding_source"]
GroundingFilterType = Literal["grounding", "relevance"]
ClaimSupport = Literal["supported", "unsupported", "uncertain"]
AutomatedReasoningResult = Literal[
    "valid",
    "invalid",
    "satisfiable",
    "impossible",
    "translation_ambiguous",
    "too_complex",
    "no_translations",
]
FailureMode = Literal["fail_open", "fail_closed"]
FragmentStatus = Literal["pass", "intervene", "needs_context", "uncovered", "error"]
CoverageStatus = Literal["complete", "partial", "none"]
EnforcementMode = Literal["enforce", "detect"]
EvidenceScope = Literal["interventions", "full"]
SafetyLevel = Literal["balanced", "strict"]
OutputDeliveryMode = Literal["interruptible", "window_buffered", "full_buffered"]
EvaluationTriggerType = Literal["always", "on_result"]
MatcherKind = Literal["header", "jwt_claim", "field"]
NeMoRuntimeEngine = Literal["iorails", "llmrails"]
NeMoRuntimeProfile = Literal[
    "iorails_native",
    "llmrails_colang1_standard",
    "llmrails_colang2_programmable",
]
PolicyExecutionMode = Literal["detect", "mutate"]


def flow_rule_id(rail_type: GuardrailPhase, flow_name: str) -> str:
    """Return the stable product Rule identity for one NeMo Flow binding."""

    return f"flow/{rail_type}/{flow_name}"


@dataclass(frozen=True, slots=True)
class RuntimeTraceStep:
    id: str
    kind: str
    name: str
    status: str
    detail: str
    duration_ms: int = 0
    parent_id: str | None = None
    evidence: str | None = None
    contract_ref: str | None = None
    verdict: EvaluatorVerdict | None = None
    route: RouteDecision | None = None
    capability: str | None = None
    confidence: float | None = None
    content_block_id: str | None = None
    module_id: str | None = None
    guardrail_id: str | None = None
    guardrail_version: int | None = None
    policy_id: str | None = None
    policy_version: str | None = None
    rail_type: str | None = None
    flow_name: str | None = None
    action_name: str | None = None
    action_version: str | None = None
    outcome: str | None = None
    timeout_ms: int | None = None
    timed_out: bool = False
    parallel_group: str | None = None
    engine: str | None = None
    runtime_profile: str | None = None
    config_checksum: str | None = None
    provider_latency_ms: int = 0
    provider_work_ms: int = 0
    model_wait_ms: int = 0
    provider_name: str | None = None
    model_name: str | None = None
    model_operation: str | None = None
    model_result: str | None = None
    error_type: str | None = None
    model_time_to_first_token_ms: int | None = None
    model_input_tokens: int = 0
    model_output_tokens: int = 0
    model_retries: int = 0
    model_backoff_ms: int = 0
    started_offset_ms: int | None = None
    finished_offset_ms: int | None = None
    evaluator_id: str | None = None
    profile_ref: str | None = None


@dataclass(frozen=True, slots=True)
class RequestContext:
    """Integration-normalized, trusted attributes used for Deployment resolution."""

    protocol: str
    integration_id: str | None = None
    headers: tuple[tuple[str, str], ...] = ()
    jwt_claims: tuple[tuple[str, str], ...] = ()
    fields: tuple[tuple[str, str], ...] = ()

    def value(self, kind: MatcherKind, key: str) -> str | None:
        source = {
            "header": self.headers,
            "jwt_claim": self.jwt_claims,
            "field": self.fields,
        }[kind]
        lookup = key.lower() if kind == "header" else key
        return next(
            (
                value
                for candidate, value in source
                if (candidate.lower() if kind == "header" else candidate) == lookup
            ),
            None,
        )


@dataclass(frozen=True, slots=True)
class GuardContentBlock:
    """One immutable content unit crossing a guardrail trust boundary."""

    id: str
    text: str
    role: ContentRole
    trust: ContentTrust
    source: str
    qualifiers: tuple[ContentQualifier, ...] = ("guard_content",)
    metadata: tuple[tuple[str, str], ...] = ()

    def __post_init__(self) -> None:
        if not self.id.strip():
            raise ValueError("Content block identifiers cannot be empty.")
        if not self.source.strip():
            raise ValueError("Content block sources cannot be empty.")
        if len(set(self.qualifiers)) != len(self.qualifiers):
            raise ValueError("Content block qualifiers must be unique.")
        metadata_keys = tuple(key for key, _value in self.metadata)
        if any(not key.strip() for key in metadata_keys):
            raise ValueError("Content block metadata keys cannot be empty.")
        if len(set(metadata_keys)) != len(metadata_keys):
            raise ValueError("Content block metadata keys must be unique.")
        if self.trust == "trusted" and self.role != "trusted_instruction":
            raise ValueError("Only trusted-instruction blocks may cross as trusted content.")
        if self.role == "trusted_instruction" and (
            self.trust != "trusted" or "guard_content" in self.qualifiers
        ):
            raise ValueError(
                "Trusted instructions must be trusted context, not guard targets."
            )

    @property
    def guard_content(self) -> bool:
        return "guard_content" in self.qualifiers

    def metadata_value(self, key: str) -> str | None:
        return next((value for candidate, value in self.metadata if candidate == key), None)


@dataclass(frozen=True, slots=True)
class ContentViewSnapshot:
    """An immutable projection over content blocks with one active protection target."""

    kind: ContentView
    blocks: tuple[GuardContentBlock, ...]
    active_block_id: str
    source_digest: str

    def __post_init__(self) -> None:
        ids = tuple(block.id for block in self.blocks)
        if len(set(ids)) != len(ids):
            raise ValueError("Content block identifiers must be unique within a view.")
        if self.active_block_id not in ids:
            raise ValueError("The active content block is unavailable in the content view.")

    @property
    def active_block(self) -> GuardContentBlock:
        return next(block for block in self.blocks if block.id == self.active_block_id)


@dataclass(frozen=True, slots=True)
class ProtectionRequest:
    phase: GuardrailPhase
    texts: tuple[str, ...]
    context: RequestContext
    content_blocks: tuple[GuardContentBlock, ...] = ()
    call_id: str | None = None
    messages: tuple[dict[str, Any], ...] = ()
    mode: EnforcementMode = "enforce"
    evidence_scope: EvidenceScope = "interventions"


@dataclass(frozen=True, slots=True)
class EvaluationTrigger:
    type: EvaluationTriggerType = "always"
    step_ref: str | None = None
    verdicts: tuple[EvaluatorVerdict, ...] = ()

    def __post_init__(self) -> None:
        if self.type == "always":
            if self.step_ref is not None or self.verdicts:
                raise ValueError("An always trigger cannot reference a prior result.")
            return
        if not self.step_ref or not self.verdicts:
            raise ValueError("An on_result trigger requires step_ref and verdicts.")
        if len(set(self.verdicts)) != len(self.verdicts):
            raise ValueError("Evaluation trigger verdicts must be unique.")


@dataclass(frozen=True, slots=True)
class GuardrailPlanStep:
    id: str
    capability: str
    contract_ref: str
    phases: tuple[GuardrailPhase, ...]
    on_unsafe: EnforcementAction
    trigger: EvaluationTrigger = EvaluationTrigger()
    parameters: tuple[tuple[str, str], ...] = ()

    def parameter(self, name: str) -> str | None:
        return next((value for key, value in self.parameters if key == name), None)


@dataclass(frozen=True, slots=True)
class GuardrailPlanModule:
    """One independently schedulable Policy module in a compiled plan."""

    id: str
    module: PolicyModule
    phase: GuardrailPhase
    step_ids: tuple[str, ...]
    depends_on: tuple[str, ...] = ()
    input_view: ContentView = "original"
    required_for_release: bool = True
    timeout_ms: int = 2_000
    failure_mode: FailureMode = "fail_closed"


@dataclass(frozen=True, slots=True)
class AutomatedReasoningPolicySnapshot:
    """Immutable reference to one deployed formal policy version."""

    id: str
    policy_id: str
    policy_version: str
    confidence_threshold: float = 0.8

    def __post_init__(self) -> None:
        if not self.id.strip() or not self.policy_id.strip() or not self.policy_version.strip():
            raise ValueError("Automated Reasoning policy identifiers cannot be empty.")
        if not 0 <= self.confidence_threshold <= 1:
            raise ValueError("Automated Reasoning confidence threshold must be between 0 and 1.")


@dataclass(frozen=True, slots=True)
class PolicySourceSnapshot:
    """One immutable Colang source file embedded in a released Policy version."""

    path: str
    content: str


@dataclass(frozen=True, slots=True)
class PolicyRailBindingSnapshot:
    """A version-pinned mapping from a Policy Flow to a NeMo Rail."""

    rail_type: RailType
    flow_name: str
    execution_mode: PolicyExecutionMode
    on_unsafe: EnforcementAction
    parallel_group: str | None = None
    priority: int | None = None
    timeout_ms: int = 2_000
    failure_mode: FailureMode = "fail_closed"
    required: bool = True
    depends_on: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class PolicyActionReferenceSnapshot:
    name: str
    version: str


@dataclass(frozen=True, slots=True)
class PolicyVersionSnapshot:
    """Immutable Policy implementation resolved into a Guardrail plan."""

    policy_id: str
    version: str
    name: str
    source: str
    colang_version: str
    sources: tuple[PolicySourceSnapshot, ...]
    parameter_schema: tuple[tuple[str, str], ...]
    rail_bindings: tuple[PolicyRailBindingSnapshot, ...]
    action_references: tuple[PolicyActionReferenceSnapshot, ...]
    evaluation_contracts: tuple[str, ...]
    prompt_dependencies: tuple[str, ...]
    execution_contract: tuple[tuple[str, str], ...]
    test_cases: tuple[tuple[str, str], ...]
    checksum: str


@dataclass(frozen=True, slots=True)
class GuardrailPolicyBindingSnapshot:
    policy_id: str
    policy_version: str
    action: EnforcementAction | None = None
    parameter_values: tuple[tuple[str, str], ...] = ()
    enabled_rule_ids: tuple[str, ...] = ()
    rule_actions: tuple[tuple[str, str], ...] = ()
    enabled_rails: tuple[RailType, ...] = ()


@dataclass(frozen=True, slots=True)
class GuardrailPlanSnapshot:
    guardrail_id: str
    guardrail_version: int
    compiler_version: str
    safety_level: SafetyLevel
    output_delivery: OutputDeliveryMode
    steps: tuple[GuardrailPlanStep, ...]
    modules: tuple[GuardrailPlanModule, ...] = ()
    reasoning_policies: tuple[AutomatedReasoningPolicySnapshot, ...] = ()
    policy_versions: tuple[PolicyVersionSnapshot, ...] = ()
    policy_bindings: tuple[GuardrailPolicyBindingSnapshot, ...] = ()

    def steps_for(
        self,
        phase: GuardrailPhase,
        contract_ref: str | None = None,
    ) -> tuple[GuardrailPlanStep, ...]:
        return tuple(
            step
            for step in self.steps
            if phase in step.phases
            and (contract_ref is None or step.contract_ref == contract_ref)
        )

    def modules_for(self, phase: GuardrailPhase) -> tuple[GuardrailPlanModule, ...]:
        return tuple(module for module in self.modules if module.phase == phase)

    def reasoning_policy(self, snapshot_id: str) -> AutomatedReasoningPolicySnapshot:
        try:
            return next(item for item in self.reasoning_policies if item.id == snapshot_id)
        except StopIteration as error:
            raise KeyError(f"Unknown Automated Reasoning policy snapshot {snapshot_id!r}.") from error


@dataclass(frozen=True, slots=True)
class NeMoActionBinding:
    """One version-pinned TaskLattice evaluator exposed as a NeMo action."""

    id: str
    capability: str
    contract_ref: str
    phases: tuple[GuardrailPhase, ...]
    on_unsafe: EnforcementAction
    trigger: EvaluationTrigger = EvaluationTrigger()
    timeout_ms: int = 2_000
    parameters: tuple[tuple[str, str], ...] = ()
    policy_id: str | None = None
    policy_version: str | None = None
    flow_name: str | None = None
    action_name: str | None = None
    action_version: str | None = None
    parallel_group: str | None = None
    execution_mode: PolicyExecutionMode = "detect"
    failure_mode: FailureMode = "fail_closed"
    depends_on: tuple[str, ...] = ()
    result_var: str | None = None

    def parameter(self, name: str) -> str | None:
        return next((value for key, value in self.parameters if key == name), None)


@dataclass(frozen=True, slots=True)
class NeMoConfigSnapshot:
    """Immutable NeMo configuration compiled for one released Guardrail version."""

    guardrail_id: str
    guardrail_version: int
    compiler_version: str
    output_delivery: OutputDeliveryMode
    config_yaml: str
    colang_content: str
    prompts_yaml: str = ""
    action_bindings: tuple[NeMoActionBinding, ...] = ()
    required_models: tuple[str, ...] = ()
    required_features: tuple[str, ...] = ()
    runtime_engine: NeMoRuntimeEngine = "llmrails"
    colang_version: str = "2.x"
    runtime_profile: NeMoRuntimeProfile = "llmrails_colang2_programmable"
    rail_flows: tuple[tuple[str, str], ...] = ()
    dependency_manifest: tuple[tuple[str, str, str], ...] = ()
    estimated_critical_path_ms: int = 0

    def bindings_for(
        self,
        phase: GuardrailPhase,
        capability: str | None = None,
    ) -> tuple[NeMoActionBinding, ...]:
        return tuple(
            binding
            for binding in self.action_bindings
            if phase in binding.phases
            and (capability is None or binding.capability == capability)
        )


@dataclass(frozen=True, slots=True)
class GroundingFilterAssessment:
    type: GroundingFilterType
    score: float
    threshold: float
    detected: bool


@dataclass(frozen=True, slots=True)
class GroundingClaimEvidence:
    id: str
    claim: str
    support: ClaimSupport
    confidence: float
    source_block_ids: tuple[str, ...] = ()
    rationale: str = ""


@dataclass(frozen=True, slots=True)
class AutomatedReasoningRuleEvidence:
    id: str
    expression: str
    description: str = ""


@dataclass(frozen=True, slots=True)
class AutomatedReasoningScenario:
    variable_values: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True, slots=True)
class AutomatedReasoningTranslation:
    premises: tuple[str, ...] = ()
    claims: tuple[str, ...] = ()
    untranslated: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class AutomatedReasoningFinding:
    """Detection-only proof result returned by a formal reasoning provider."""

    id: str
    result: AutomatedReasoningResult
    confidence: float
    translation: AutomatedReasoningTranslation | None = None
    supporting_rules: tuple[AutomatedReasoningRuleEvidence, ...] = ()
    contradicting_rules: tuple[AutomatedReasoningRuleEvidence, ...] = ()
    claims_true_scenario: AutomatedReasoningScenario | None = None
    claims_false_scenario: AutomatedReasoningScenario | None = None
    message: str = ""


@dataclass(frozen=True, slots=True)
class ProviderEvidence:
    """Model-native evidence retained without making it the product taxonomy."""

    provider_id: str
    model: str
    native_verdict: str
    native_category: str | None = None
    mapping_quality: str | None = None


@dataclass(frozen=True, slots=True)
class RiskFinding:
    """One canonical TALI category finding produced by an evaluator."""

    risk: str
    taxonomy_id: str
    verdict: EvaluatorVerdict
    confidence: float | None
    evidence: str
    recommended_action: EnforcementAction
    replacement: str | None = None
    policy_id: str | None = None
    rule_id: str | None = None
    grounding: tuple[GroundingFilterAssessment, ...] = ()
    claims: tuple[GroundingClaimEvidence, ...] = ()
    reasoning: tuple[AutomatedReasoningFinding, ...] = ()
    provider_evidence: tuple[ProviderEvidence, ...] = ()


@dataclass(frozen=True, slots=True)
class ContentPatch:
    """A proposed edit whose offsets always refer to the immutable source text."""

    start: int
    end: int
    replacement: str


@dataclass(frozen=True, slots=True)
class RuntimeCoverage:
    status: CoverageStatus = "complete"
    guarded_items: int = 0
    total_items: int = 0
    guarded_characters: int = 0
    total_characters: int = 0
    required_modules_completed: int = 0
    required_modules_total: int = 0


@dataclass(frozen=True, slots=True)
class RuntimeUsage:
    module_invocations: int = 0
    evaluator_invocations: int = 0
    text_characters: int = 0
    rail_invocations: int = 0
    action_invocations: int = 0
    model_invocations: int = 0
    cache_hits: int = 0
    cache_misses: int = 0
    queue_latency_ms: int = 0
    runtime_engine: str = ""
    runtime_profile: str = ""
    config_checksum: str = ""
    fail_closed: bool = False
    active_concurrency: int = 0
    provider_latency_ms: int = 0
    provider_work_latency_ms: int = 0
    model_wait_latency_ms: int = 0


@dataclass(frozen=True, slots=True)
class DecisionFragment:
    """An immutable module proposal; fragments never mutate shared content."""

    id: str
    module_id: str
    module: PolicyModule
    status: FragmentStatus
    action: EnforcementAction = "pass"
    findings: tuple[RiskFinding, ...] = ()
    patches: tuple[ContentPatch, ...] = ()
    replacement: str | None = None
    coverage: CoverageStatus = "complete"
    reason: str | None = None
    trace: tuple[RuntimeTraceStep, ...] = ()
    content_block_id: str | None = None


@dataclass(frozen=True, slots=True)
class ModuleAssessment:
    module_id: str
    module: PolicyModule
    status: FragmentStatus
    fragments: tuple[DecisionFragment, ...]
    coverage: RuntimeCoverage
    latency_ms: int = 0
    trace: tuple[RuntimeTraceStep, ...] = ()
    content_block_id: str | None = None


@dataclass(frozen=True, slots=True)
class AppliedIntervention:
    kind: EnforcementAction
    module_id: str
    fragment_id: str
    reason: str | None = None
    patches: tuple[ContentPatch, ...] = ()
    replacement: str | None = None
    content_block_id: str | None = None


@dataclass(frozen=True, slots=True)
class ContentBlockResult:
    id: str
    role: ContentRole
    source: str
    decision: PolicyDecision
    action: EnforcementAction
    text: str | None = None
    evaluated: bool = True


@dataclass(frozen=True, slots=True)
class ProtectionDecision:
    decision: PolicyDecision
    action: EnforcementAction
    reason: str | None = None
    texts: tuple[str, ...] = ()
    guardrail_id: str | None = None
    guardrail_version: int | None = None
    deployment_id: str | None = None
    integration_id: str | None = None
    output_delivery: OutputDeliveryMode | None = None
    findings: tuple[RiskFinding, ...] = ()
    trace: tuple[RuntimeTraceStep, ...] = ()
    assessments: tuple[ModuleAssessment, ...] = ()
    interventions: tuple[AppliedIntervention, ...] = ()
    coverage: RuntimeCoverage | None = None
    usage: RuntimeUsage | None = None
    mode: EnforcementMode = "enforce"
    content_results: tuple[ContentBlockResult, ...] = ()


@dataclass(frozen=True, slots=True)
class PlanResolution:
    plan: GuardrailPlanSnapshot
    deployment_id: str
    integration_id: str | None = None
    trace: tuple[RuntimeTraceStep, ...] = ()


@dataclass(frozen=True, slots=True)
class EngineRequest:
    phase: GuardrailPhase
    text: str
    plan: GuardrailPlanSnapshot
    context_messages: tuple[dict[str, Any], ...] = ()
    trusted_instruction: str = ""
    target_source: str = "user_input"
    mode: EnforcementMode = "enforce"
    evidence_scope: EvidenceScope = "interventions"
    content_view: ContentViewSnapshot | None = None
    active_block_id: str | None = None
    request_context: RequestContext | None = None


class NeMoPolicyRuntime(Protocol):
    name: str
    supported_phases: frozenset[GuardrailPhase]

    async def evaluate(self, request: EngineRequest) -> ProtectionDecision: ...


class PlanResolver(Protocol):
    def resolve(self, context: RequestContext) -> PlanResolution: ...
