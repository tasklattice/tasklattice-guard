from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from ..runtime.contracts import (
    AutomatedReasoningResult,
    EnforcementAction,
    RuntimeTraceStep,
    GuardrailPhase,
    GuardrailPlanSnapshot,
    NeMoConfigSnapshot,
    OutputDeliveryMode,
    PolicyModule,
    SafetyLevel,
    RailType,
)


# Runner-side view models are local compilation inputs, not Controller resource
# lifecycle states. Keep only aliases that are consumed by the dataclasses below.
ValidationRunStatus = Literal["passed", "failed", "incomplete"]
TestCaseOrigin = Literal["generated", "custom"]
TestTargetSource = Literal[
    "user_input",
    "retrieved_content",
    "tool_output",
    "model_output",
]
PolicySourceKind = Literal["built-in", "custom"]
IntegrationSetupStatus = Literal["awaiting_callback", "verified", "disabled"]
LoggingLevel = Literal["info", "debug", "trace"]


@dataclass(frozen=True, slots=True)
class PolicySourceFile:
    path: str
    content: str


@dataclass(frozen=True, slots=True)
class PolicyParameterDefinition:
    name: str
    kind: str
    required: bool = False
    default: str | None = None
    description: str = ""


@dataclass(frozen=True, slots=True)
class RailBinding:
    rail_type: GuardrailPhase
    flow_name: str
    execution_mode: Literal["detect", "mutate"]
    on_unsafe: EnforcementAction
    parallel_group: str | None = None
    priority: int | None = None
    timeout_ms: int = 2_000
    failure_mode: Literal["fail_open", "fail_closed"] = "fail_closed"
    required: bool = True
    depends_on: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class ActionReference:
    name: str
    version: str


@dataclass(frozen=True, slots=True)
class PolicyTestCaseDefinition:
    name: str
    rail_type: GuardrailPhase
    content: str
    expected_decision: str
    covered_rule_ids: tuple[str, ...]
    id: str = ""
    description: str = ""
    case_type: str = "unit"
    required: bool = True
    expected_failure: str | None = None
    concurrency_group: str | None = None
    trusted_instruction: str = ""
    use_guardrail_instruction: bool = False
    for_each: Literal["allowed_topics", "restricted_topics"] | None = None
    target_source: TestTargetSource = "user_input"
    query: str = ""
    grounding_sources: tuple[str, ...] = ()
    expected_reasoning_result: AutomatedReasoningResult | None = None


@dataclass(frozen=True, slots=True)
class PolicyDraft:
    colang_version: str
    sources: tuple[PolicySourceFile, ...]
    parameter_schema: tuple[PolicyParameterDefinition, ...]
    rail_bindings: tuple[RailBinding, ...]
    action_references: tuple[ActionReference, ...]
    evaluation_contracts: tuple[str, ...] = ()
    prompt_dependencies: tuple[str, ...] = ()
    execution_contract: tuple[tuple[str, str], ...] = ()
    test_cases: tuple[PolicyTestCaseDefinition, ...] = ()


@dataclass(frozen=True, slots=True)
class PolicyRecord:
    id: str
    name: str
    description: str
    source: PolicySourceKind
    owner: str
    draft: PolicyDraft
    draft_revision: int
    updated_at: str


@dataclass(frozen=True, slots=True)
class PolicyVersion:
    policy_id: str
    version: int
    name: str
    description: str
    source: PolicySourceKind
    owner: str
    colang_version: str
    sources: tuple[PolicySourceFile, ...]
    parameter_schema: tuple[PolicyParameterDefinition, ...]
    rail_bindings: tuple[RailBinding, ...]
    action_references: tuple[ActionReference, ...]
    evaluation_contracts: tuple[str, ...]
    prompt_dependencies: tuple[str, ...]
    execution_contract: tuple[tuple[str, str], ...]
    test_cases: tuple[PolicyTestCaseDefinition, ...]
    checksum: str
    published_at: str


@dataclass(frozen=True, slots=True)
class GuardrailPolicyBinding:
    policy_id: str
    policy_version: str
    action: EnforcementAction | None = None
    parameter_values: tuple[tuple[str, str], ...] = ()
    enabled_rule_ids: tuple[str, ...] = ()
    rule_actions: tuple[tuple[str, str], ...] = ()
    enabled_rails: tuple[RailType, ...] = ()
    reasoning_policy: AutomatedReasoningPolicyBinding | None = None


@dataclass(frozen=True, slots=True)
class RuntimeCapability:
    id: str
    policy_id: str | None
    display_name: str
    description: str
    domain: str
    default_phases: tuple[GuardrailPhase, ...]
    default_action: EnforcementAction
    allowed_actions: tuple[EnforcementAction, ...]
    evaluation_contracts: tuple[str, ...]
    limitations: tuple[str, ...]
    module: PolicyModule


@dataclass(frozen=True, slots=True)
class ResolvedPolicyCapability:
    """Compiler-only capability resolved from a product Policy binding."""

    capability: str
    action: EnforcementAction
    reasoning_policy: AutomatedReasoningPolicyBinding | None = None


@dataclass(frozen=True, slots=True)
class AutomatedReasoningPolicyBinding:
    """Draft-time binding to an externally deployed immutable policy version."""

    policy_id: str
    policy_version: str
    confidence_threshold: float = 0.8


@dataclass(frozen=True, slots=True)
class Guardrail:
    id: str
    name: str
    purpose: str
    allowed_topics: tuple[str, ...]
    restricted_topics: tuple[str, ...]
    safety_level: SafetyLevel
    output_delivery: OutputDeliveryMode
    draft_version: int
    active_version: str | None
    updated_at: str
    policy_bindings: tuple[GuardrailPolicyBinding, ...] = ()
    excluded_test_case_ids: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class GuardrailDeletionImpact:
    guardrail_id: str
    guardrail_name: str
    window_minutes: int
    incoming_request_count: int
    active_deployment_count: int
    requires_confirmation: bool


@dataclass(frozen=True, slots=True)
class GuardrailVersion:
    guardrail_id: str
    version: str
    source_draft_version: int
    compiler_version: str
    plan_checksum: str
    created_at: str
    active: bool
    runtime_engine: str = "nemo"
    runtime_profile: str = ""
    config_checksum: str = ""
    execution_mode: Literal["nemo_only"] = "nemo_only"


@dataclass(frozen=True, slots=True)
class TrafficCondition:
    field: str
    operator: str
    value: str
    key: str = ""


@dataclass(frozen=True, slots=True)
class TrafficScopeExpression:
    combinator: str
    conditions: tuple[TrafficCondition | TrafficScopeExpression, ...]


@dataclass(frozen=True, slots=True)
class Deployment:
    id: str
    name: str
    guardrail_id: str
    guardrail_version: str
    integration_id: str | None
    route_order: int
    traffic_scope: TrafficScopeExpression
    enabled: bool
    updated_at: str


@dataclass(frozen=True, slots=True)
class IntegrationCredential:
    id: str
    key_hint: str
    created_at: str


@dataclass(frozen=True, slots=True)
class IntegrationCredentialSecret:
    id: str
    value: str
    key_hint: str
    created_at: str


@dataclass(frozen=True, slots=True)
class Integration:
    id: str
    adapter_id: str
    protocol: str
    name: str
    description: str
    enabled: bool
    key_hint: str
    credentials: tuple[IntegrationCredential, ...]
    setup_status: IntegrationSetupStatus
    runtime_status: str
    first_seen_at: str | None
    last_seen_at: str | None
    input_seen_at: str | None
    output_seen_at: str | None
    request_count: int
    error_count: int
    last_error_at: str | None
    created_at: str
    updated_at: str


@dataclass(frozen=True, slots=True)
class IntegrationDeletionImpact:
    integration_id: str
    integration_name: str
    window_minutes: int
    incoming_request_count: int
    active_deployment_count: int
    active_credential_count: int
    requires_confirmation: bool


@dataclass(frozen=True, slots=True)
class IntegrationRegistration:
    integration: Integration
    credential: IntegrationCredentialSecret


@dataclass(frozen=True, slots=True)
class GuardrailTestCaseSpec:
    id: str
    name: str
    policy_id: str
    phase: GuardrailPhase
    content: str
    expected_decision: str
    trusted_instruction: str = ""
    target_source: TestTargetSource = "user_input"
    query: str = ""
    grounding_sources: tuple[str, ...] = ()
    expected_reasoning_result: AutomatedReasoningResult | None = None
    case_type: str = "unit"
    required: bool = True
    expected_failure: str | None = None
    concurrency_group: str | None = None
    source_policy_id: str | None = None
    source_policy_version: str | None = None
    source_case_id: str | None = None
    covered_rule_ids: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class GuardrailTestCase:
    id: str
    guardrail_id: str
    name: str
    policy_id: str
    phase: GuardrailPhase
    content: str
    expected_decision: str
    origin: TestCaseOrigin
    updated_at: str
    trusted_instruction: str = ""
    target_source: TestTargetSource = "user_input"
    query: str = ""
    grounding_sources: tuple[str, ...] = ()
    expected_reasoning_result: AutomatedReasoningResult | None = None
    case_type: str = "unit"
    required: bool = True
    expected_failure: str | None = None
    concurrency_group: str | None = None
    source_policy_id: str | None = None
    source_policy_version: str | None = None
    source_case_id: str | None = None
    covered_rule_ids: tuple[str, ...] = ()
    excluded: bool = False


@dataclass(frozen=True, slots=True)
class TestCaseResult:
    case_id: str
    name: str
    policy_id: str
    expected_decision: str
    actual_decision: str
    passed: bool
    evaluator_ids: tuple[str, ...]
    latency_ms: int
    reason: str
    phase: GuardrailPhase = "input"
    input_content: str = ""
    action: EnforcementAction = "pass"
    output_content: str = ""
    findings: tuple[dict[str, object], ...] = ()
    trace: tuple[dict[str, object], ...] = ()
    trusted_instruction: str = ""
    target_source: TestTargetSource = "user_input"
    query: str = ""
    grounding_sources: tuple[str, ...] = ()
    expected_reasoning_result: AutomatedReasoningResult | None = None
    actual_reasoning_result: AutomatedReasoningResult | None = None
    case_type: str = "unit"
    required: bool = True
    expected_failure: str | None = None
    actual_failure: str | None = None
    concurrency_group: str | None = None
    source_policy_id: str | None = None
    source_policy_version: str | None = None
    source_case_id: str | None = None
    covered_rule_ids: tuple[str, ...] = ()
    matched_rule_ids: tuple[str, ...] = ()
    evaluation_contracts: tuple[str, ...] = ()
    escalated: bool = False
    model_invocations: int = 0


# The product name intentionally starts with ``Test``; keep pytest from
# mistaking this data contract for a test class when imported by test modules.
TestCaseResult.__test__ = False


@dataclass(frozen=True, slots=True)
class ValidationMetrics:
    total: int
    passed: int
    compliance_rate: float
    false_positive_rate: float
    false_negative_rate: float
    escalation_rate: float
    p95_latency_ms: int


@dataclass(frozen=True, slots=True)
class ValidationRun:
    id: str
    guardrail_id: str
    guardrail_version: str
    source_draft_version: int
    status: ValidationRunStatus
    metrics: ValidationMetrics
    results: tuple[TestCaseResult, ...]
    created_at: str
    excluded_case_ids: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class EvidenceRecord:
    id: str
    created_at: str
    kind: str
    outcome: str
    guardrail_id: str | None
    deployment_id: str | None
    risk: str | None
    detail: str
    integration_id: str | None = None
    actor_id: str | None = None
    metadata: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True, slots=True)
class RuntimeMetricEvent:
    """Privacy-safe dimensions for one Guardrail runtime decision."""

    id: str
    trace_id: str
    created_at: str
    guardrail_id: str | None
    guardrail_version: str | None
    deployment_id: str | None
    integration_id: str | None
    protocol: str
    phase: str
    outcome: str
    action: str
    risk: str | None
    latency_ms: int
    timed_out: bool
    module_invocations: int
    evaluator_invocations: int
    rail_invocations: int = 0
    action_invocations: int = 0
    model_invocations: int = 0
    queue_latency_ms: int = 0
    cache_hits: int = 0
    cache_misses: int = 0
    runtime_engine: str = ""
    config_checksum: str = ""
    fail_closed: bool = False
    active_concurrency: int = 0
    provider_latency_ms: int = 0
    provider_work_latency_ms: int = 0
    model_wait_latency_ms: int = 0
    slo_breached: bool = False
    detail: str = ""


@dataclass(frozen=True, slots=True)
class RuntimeStepMetricEvent:
    """Privacy-safe timing and outcome for one activated NeMo rail or Action."""

    id: str
    trace_id: str
    created_at: str
    guardrail_id: str
    guardrail_version: str
    deployment_id: str | None
    integration_id: str | None
    protocol: str
    phase: str
    kind: str
    name: str
    capability: str | None
    contract_ref: str | None
    outcome: str
    latency_ms: int
    timed_out: bool
    runtime_engine: str
    config_checksum: str
    policy_id: str | None = None
    policy_version: str | None = None
    rail_type: str | None = None
    flow_name: str | None = None
    action_name: str | None = None
    action_version: str | None = None
    parallel_group: str | None = None
    timeout_ms: int | None = None
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


@dataclass(frozen=True, slots=True)
class RuntimeFindingEvent:
    """One privacy-safe Rule finding attached to a runtime trace."""

    id: str
    trace_id: str
    created_at: str
    guardrail_id: str | None
    guardrail_version: str | None
    deployment_id: str | None
    integration_id: str | None
    phase: str
    severity: Literal["critical", "high", "medium", "low"]
    risk: str
    taxonomy_id: str
    verdict: str
    confidence: float | None
    recommended_action: str
    policy_id: str | None
    rule_id: str | None
    detail: str
    protocol: str | None = None


@dataclass(frozen=True, slots=True)
class RuntimeFindingSummary:
    """Aggregate finding counts for a Guardrail and time window."""

    total: int
    critical: int
    high: int
    medium: int
    low: int
    affected_traces: int
    latest_at: str | None


@dataclass(frozen=True, slots=True)
class DeploymentRuntimeTrace:
    """One Deployment decision with correlated findings and NeMo execution steps."""

    id: str
    created_at: str
    deployment_id: str
    guardrail_id: str | None
    guardrail_version: str | None
    integration_id: str | None
    protocol: str
    phase: str
    outcome: str
    action: str
    risk: str | None
    severity: Literal["critical", "high", "medium", "low"] | None
    latency_ms: int
    timed_out: bool
    runtime_engine: str
    config_checksum: str
    detail: str
    findings: tuple[RuntimeFindingEvent, ...] = ()
    steps: tuple[RuntimeStepMetricEvent, ...] = ()


@dataclass(frozen=True, slots=True)
class GuardrailLoggingSettings:
    guardrail_id: str
    level: LoggingLevel
    updated_at: str
    updated_by: str | None
    retention_days: int
    content_capture_enabled: bool


@dataclass(frozen=True, slots=True)
class RuntimeLogContentBlock:
    id: str
    role: str
    source: str
    text: str
    truncated: bool = False


@dataclass(frozen=True, slots=True)
class RuntimeLogEntry:
    id: str
    trace_id: str
    created_at: str
    phase: Literal["input", "output"]
    outcome: str
    action: str
    risk: str | None
    latency_ms: int
    timed_out: bool
    detail: str
    content_before: tuple[RuntimeLogContentBlock, ...] | None
    content_after: tuple[RuntimeLogContentBlock, ...] | None
    content_available: bool
    findings: tuple[RuntimeFindingEvent, ...] = ()
    steps: tuple[RuntimeStepMetricEvent, ...] = ()


@dataclass(frozen=True, slots=True)
class RuntimeLogInteraction:
    id: str
    created_at: str
    completed_at: str | None
    guardrail_id: str
    guardrail_version: str | None
    deployment_id: str | None
    integration_id: str | None
    protocol: str
    outcome: str
    capture_level: LoggingLevel
    entries: tuple[RuntimeLogEntry, ...]


class ControlPlaneError(RuntimeError):
    pass


class NotFoundError(ControlPlaneError):
    pass


class ValidationError(ControlPlaneError):
    pass


class ConflictError(ControlPlaneError):
    pass


class PlanCompilationError(ControlPlaneError):
    pass


class PlanResolutionError(ControlPlaneError):
    pass


class IntegrationAuthenticationError(ControlPlaneError):
    pass


@dataclass(frozen=True, slots=True)
class TestedGuardrailVersion:
    guardrail: Guardrail
    version: GuardrailVersion
    plan: GuardrailPlanSnapshot
    nemo_config: NeMoConfigSnapshot | None = None
