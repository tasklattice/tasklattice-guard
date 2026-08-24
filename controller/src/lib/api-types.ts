export type SafetyLevel = "balanced" | "strict";
export type OutputDelivery = "interruptible" | "window_buffered" | "full_buffered";
export type TargetSource = "user_input" | "retrieved_content" | "tool_output" | "model_output";

export type GroundingFilterAssessment = {
  type: "grounding" | "relevance";
  score: number;
  threshold: number;
  detected: boolean;
};

export type GroundingClaimEvidence = {
  id: string;
  claim: string;
  support: "supported" | "unsupported" | "uncertain";
  confidence: number;
  source_block_ids: string[];
  rationale: string;
};

export type AutomatedReasoningResult = "valid" | "invalid" | "satisfiable" | "impossible" | "translation_ambiguous" | "too_complex" | "no_translations";

export type AutomatedReasoningFinding = {
  id: string;
  result: AutomatedReasoningResult;
  confidence: number;
  translation?: { premises: string[]; claims: string[]; untranslated: string[] } | null;
  supporting_rules: Array<{ id: string; expression: string; description: string }>;
  contradicting_rules: Array<{ id: string; expression: string; description: string }>;
  claims_true_scenario?: { variable_values: Array<[string, string]> } | null;
  claims_false_scenario?: { variable_values: Array<[string, string]> } | null;
  message: string;
};

export type Collection<T> = { items: T[]; count: number };

export type EnforcementAction = "pass" | "redact" | "rewrite" | "regenerate" | "redirect" | "reject" | "fallback" | "clarify";

export type GuardrailPolicyBinding = {
  policy_id: string;
  policy_version: string;
  action?: EnforcementAction | null;
  parameter_values: Record<string, string>;
  enabled_rule_ids: string[];
  rule_actions: Record<string, EnforcementAction>;
  enabled_rails: NativeRailType[];
  reasoning_policy?: {
    policy_id: string;
    policy_version: string;
    confidence_threshold: number;
  } | null;
};

export type ValidationMetrics = {
  total: number;
  passed: number;
  compliance_rate: number;
  false_positive_rate: number;
  false_negative_rate: number;
  deep_escalation_rate: number;
  p95_latency_ms: number;
};

export type RuntimeFinding = {
  risk: string;
  verdict: string;
  confidence: number;
  evidence: string;
  recommended_action: string;
  replacement?: string | null;
  grounding?: GroundingFilterAssessment[];
  claims?: GroundingClaimEvidence[];
  reasoning?: AutomatedReasoningFinding[];
};

export type RuntimeTraceStep = {
  id: string;
  kind?: string;
  name: string;
  status: string;
  detail: string;
  duration_ms: number;
  parent_id?: string | null;
  stage?: string | null;
  verdict?: string | null;
  route?: string | null;
  risk?: string | null;
  confidence?: number | null;
  policy_id?: string | null;
  policy_version?: string | null;
  rail_type?: string | null;
  flow_name?: string | null;
  action_name?: string | null;
  action_version?: string | null;
  outcome?: string | null;
  engine?: string | null;
};

export type TestCaseResult = {
  case_id: string;
  name: string;
  policy_id: string;
  expected_decision: string;
  actual_decision: string;
  passed: boolean;
  stage_reached: string;
  latency_ms: number;
  reason: string;
  phase: "input" | "output";
  input_content: string;
  action: string;
  output_content: string;
  findings: RuntimeFinding[];
  trace: RuntimeTraceStep[];
  trusted_instruction: string;
  target_source: TargetSource;
  query: string;
  grounding_sources: string[];
  expected_reasoning_result: AutomatedReasoningResult | null;
  actual_reasoning_result: AutomatedReasoningResult | null;
  case_type: "rule_acceptance" | "scenario" | "custom" | string;
  required: boolean;
  expected_failure: string | null;
  actual_failure: string | null;
  concurrency_group: string | null;
  source_policy_id: string | null;
  source_policy_version: string | null;
  source_case_id: string | null;
  covered_rule_ids: string[];
  matched_rule_ids: string[];
};

export type ValidationRun = {
  id: string;
  guardrail_id: string;
  guardrail_version: number | null;
  source_draft_version: number;
  status: "passed" | "failed" | "incomplete";
  metrics: ValidationMetrics;
  results: TestCaseResult[];
  excluded_case_ids: string[];
  created_at: string;
};

export type PlaygroundCheckPolicy = {
  id: string;
  name: string;
  risk: string;
  status: "matched" | "not_matched" | "error";
  duration_ms: number;
};

export type PlaygroundCheckFinding = {
  id: string;
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  confidence: number;
  recommended_action: string;
  policy_id: string | null;
  rule_id: string | null;
};

export type PlaygroundCheckResult = {
  check_id: string;
  trace_id: string;
  evidence_id: string | null;
  guardrail: {
    id: string;
    name: string;
    version: number;
    target_kind: "published" | "draft";
    draft_revision: number | null;
    published_at: string | null;
    compiler_version: string;
  };
  phase: "input" | "output";
  decision: "allow" | "transform" | "block";
  action: string;
  output_content: string;
  latency_ms: number;
  reason: string;
  runtime: string;
  triggered_policy: { id: string; name: string } | null;
  triggered_rule: { id: string; name: string } | null;
  policies: PlaygroundCheckPolicy[];
  findings: PlaygroundCheckFinding[];
  trace_summary: { steps: number; matched_steps: number };
  trace: RuntimeTraceStep[];
};

export type PlaygroundModel = {
  id: string;
  provider: string;
  name: string;
  icon: string;
};

export type PlaygroundTarget =
  | { kind: "draft"; draft_revision: number; preview_id?: string }
  | { kind: "published"; version: number };

export type PlaygroundDraftPreview = {
  preview_id: string;
  guardrail_id: string;
  draft_revision: number;
  candidate_version: number;
  compiler_version: string;
  runtime_profile: string;
  expires_at: string;
};

export type PlaygroundInteraction = {
  interaction_id: string;
  state: "completed" | "input_blocked" | "output_blocked";
  user_message: string;
  effective_user_message: string | null;
  assistant_message: string | null;
  model: PlaygroundModel & { latency_ms: number | null };
  input_check: PlaygroundCheckResult;
  output_check: PlaygroundCheckResult | null;
};

export type TestCase = {
  id: string;
  guardrail_id: string;
  name: string;
  policy_id: string;
  phase: "input" | "output";
  content: string;
  expected_decision: "allow" | "block" | "transform" | "intervene";
  origin: "generated" | "custom";
  updated_at: string;
  trusted_instruction: string;
  target_source: TargetSource;
  query: string;
  grounding_sources: string[];
  expected_reasoning_result: AutomatedReasoningResult | null;
  source_policy_id: string | null;
  source_policy_version: string | null;
  source_case_id: string | null;
  covered_rule_ids: string[];
  case_type: string;
  required: boolean;
  excluded: boolean;
};

export type PolicyCoverage = {
  policy_id: string;
  passed: number;
  total: number;
  score: number | null;
};

export type Deployment = {
  id: string;
  name: string;
  guardrail_id: string;
  guardrail_version: number;
  integration_id: string | null;
  route_order: number;
  traffic_scope: TrafficScopeExpression;
  enabled: boolean;
  is_default: boolean;
  system_managed: boolean;
  updated_at: string;
};

export type DeploymentDeletionImpact = {
  deployment_id: string;
  deployment_name: string;
  window_minutes: number;
  incoming_request_count: number;
  last_request_at: string | null;
  active_deployment_count: number;
  telemetry_fresh: boolean;
  telemetry_watermark: string | null;
  requires_second_confirmation: boolean;
  requires_confirmation: boolean;
};

export type DeploymentTraceFinding = {
  id: string;
  trace_id: string;
  created_at: string;
  guardrail_id: string | null;
  guardrail_version: number | null;
  deployment_id: string | null;
  integration_id: string | null;
  phase: string;
  severity: "critical" | "high" | "medium" | "low";
  risk: string;
  verdict: string;
  confidence: number;
  recommended_action: string;
  policy_id: string | null;
  rule_id: string | null;
  detail: string;
  protocol?: string | null;
};

export type RuntimeFindingSummary = {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  affected_traces: number;
  latest_at: string | null;
};

export type GuardrailFindingPage = {
  items: DeploymentTraceFinding[];
  count: number;
  summary: RuntimeFindingSummary;
  collection_status?: "collected" | "not_collected" | "no_events";
};

export type DeploymentTraceStep = {
  id: string;
  trace_id: string;
  created_at: string;
  guardrail_id: string;
  guardrail_version: number;
  deployment_id: string | null;
  integration_id: string | null;
  protocol: string;
  phase: string;
  kind: "rail" | "action" | string;
  name: string;
  risk: string | null;
  stage: string | null;
  outcome: string;
  latency_ms: number;
  timed_out: boolean;
  runtime_engine: string;
  config_checksum: string;
  policy_id: string | null;
  policy_version: string | null;
  rail_type: string | null;
  flow_name: string | null;
  action_name: string | null;
  action_version: string | null;
  parallel_group: string | null;
  timeout_ms: number | null;
  provider_latency_ms: number;
};

export type DeploymentRuntimeTrace = {
  id: string;
  created_at: string;
  deployment_id: string;
  guardrail_id: string | null;
  guardrail_version: number | null;
  integration_id: string | null;
  protocol: string;
  phase: string;
  outcome: string;
  action: string;
  risk: string | null;
  severity: DeploymentTraceFinding["severity"] | null;
  latency_ms: number;
  timed_out: boolean;
  runtime_engine: string;
  config_checksum: string;
  detail: string;
  findings: DeploymentTraceFinding[];
  steps: DeploymentTraceStep[];
  evidence_status?: "collected" | "not_collected";
};

export type TrafficScopeSource = "field" | "header" | "jwt_claim";
export type TrafficScopeOperator = "equals" | "contains" | "starts_with" | "glob";

export type TrafficCondition = {
  field: string;
  key?: string;
  operator: TrafficScopeOperator;
  value: string;
};

export type TrafficScopeExpression = {
  combinator: "and" | "or";
  conditions: Array<TrafficCondition | TrafficScopeExpression>;
};

export type TrafficScopeField = {
  id: string;
  group: "request" | "authentication" | "http" | "model" | "litellm" | "a2a";
  source: TrafficScopeSource;
  key: string;
  operators: TrafficScopeOperator[];
  values: string[];
  custom_key?: boolean;
};

export type Guardrail = {
  id: string;
  name: string;
  purpose: string;
  allowed_topics: string[];
  restricted_topics: string[];
  policy_bindings: GuardrailPolicyBinding[];
  safety_level: SafetyLevel;
  output_delivery: OutputDelivery;
  updated_at: string;
  status: "needs_validation" | "ready" | "protected";
  latest_validation_run: ValidationRun | null;
  deployment_count: number;
  test_case_count: number;
  excluded_test_case_count: number;
  excluded_test_case_ids: string[];
  draft_revision?: number;
  tested_current: boolean;
  published_current: boolean;
  published_version_count?: number;
  is_default: boolean;
  system_managed: boolean;
  local_only: boolean;
  coverage: PolicyCoverage[];
};

export type GuardrailDeletionImpact = {
  guardrail_id: string;
  guardrail_name: string;
  window_minutes: number;
  incoming_request_count: number;
  last_request_at: string | null;
  active_deployment_count: number;
  telemetry_fresh: boolean;
  telemetry_watermark: string | null;
  requires_second_confirmation: boolean;
  requires_confirmation: boolean;
};

export type DeleteConfirmation = {
  reason: string;
  confirm_recent_traffic: boolean;
  confirmation_name?: string;
};

export type GuardrailVersion = {
  guardrail_id: string;
  version: number;
  source_draft_version: number;
  compiler_version: string;
  plan_checksum: string;
  created_at: string;
  active: boolean;
  runtime_engine: "iorails" | "llmrails" | string;
  config_checksum: string;
  execution_mode: "nemo_only";
  compile_status?: "compiling" | "ready" | "failed";
  failure_reason?: string | null;
};

export type GuardrailVersionArtifact = {
  path: string;
  language: "yaml" | "colang" | "json" | string;
  content: string;
};

export type GuardrailVersionDetail = GuardrailVersion & {
  safety_level: SafetyLevel;
  output_delivery: OutputDelivery;
  runtime_profile: string;
  colang_version: string;
  rails: Array<{ rail_type: NativeRailType; flow: string }>;
  actions: Array<{
    name: string;
    version: string | null;
    flow: string | null;
    phases: Array<"input" | "output">;
    timeout_ms: number;
    failure_mode: string;
  }>;
  models: string[];
  features: string[];
  dependencies: Array<{ kind: string; name: string; version: string }>;
  estimated_critical_path_ms: number;
  policy_bindings: Array<{
    policy_id: string;
    policy_version: string;
    action: string | null;
    enabled_rule_ids: string[];
    enabled_rails: NativeRailType[];
  }>;
  artifacts: GuardrailVersionArtifact[];
};

export type PolicyTagNamespace =
  | "capability"
  | "collection"
  | "domain"
  | "framework"
  | "implementation"
  | "jurisdiction"
  | "rail";

export type PolicyTag = {
  id: string;
  namespace: PolicyTagNamespace;
  value: string;
  label: string;
  source: "declared" | "derived";
};

export type PolicyRuleImplementation = {
  engine: string;
  form: "regex" | "keyword" | "category" | "code_block" | "competitor_intent" | "colang_flow";
  binding_id: string;
  implementation_rule_id: string;
  detector: string | null;
  flow_name: string | null;
  action_name: string | null;
};

export type PolicyRule = {
  id: string;
  name: string;
  description: string;
  form: "regex" | "keyword" | "category" | "code_block" | "competitor_intent" | "colang_flow";
  effect: string;
  stages: NativeRailType[];
  implementation: PolicyRuleImplementation;
  expression: string | null;
  context_expression: string | null;
  context_max_gap_words?: number | null;
  allow_word_numbers?: boolean;
  redaction: string | null;
  severity_threshold: string | null;
  identifiers: string[];
  conditions: string[];
  keywords: Array<[string, string]>;
  always_block: Array<[string, string]>;
  exceptions: string[];
  phrase_patterns: string[];
};

export type PolicyTestCase = {
  id: string;
  name: string;
  description: string;
  stage: NativeRailType;
  content: string;
  expected_decision: "allow" | "block" | "transform" | "intervene";
  covered_rule_ids: string[];
  group: string;
  kind: "rule_acceptance" | "scenario";
  required: boolean;
  parameter_names: string[];
};

export type PolicyParameter = {
  name: string;
  label?: string;
  kind: string;
  required: boolean;
  placeholder?: string;
  default?: string | null;
  description: string;
};

export type Policy = {
  implementation: "rules" | "nemo_native";
  id: string;
  name: string;
  description: string;
  source: "built_in" | "custom";
  version: string;
  tags: PolicyTag[];
  parameters: PolicyParameter[];
  stages: NativeRailType[];
  effects: string[];
  forms: PolicyRule["form"][];
  rules: PolicyRule[];
  test_cases: PolicyTestCase[];
  test_count: number;
  safety_level: SafetyLevel;
  output_delivery: OutputDelivery;
  draft_revision?: number;
  owner?: string;
  updated_at?: string;
  implementation_detail?: ProgrammablePolicy;
};

export type NativeRailType = "input" | "output" | "retrieval" | "dialog" | "execution";
export type PolicyRailType = Extract<NativeRailType, "input" | "output">;
export type PolicySourceFile = { path: string; content: string };
export type PolicyDraftParameter = {
  name: string;
  kind: "string" | "number" | "boolean" | "secret";
  required: boolean;
  default: string | null;
  description: string;
};
export type PolicyRailBinding = {
  rail_type: PolicyRailType;
  flow_name: string;
  execution_mode: "detect" | "mutate";
  on_unsafe: "pass" | "redact" | "rewrite" | "regenerate" | "redirect" | "reject" | "fallback" | "clarify";
  parallel_group: string | null;
  priority: number | null;
  timeout_ms: number;
  failure_mode: "fail_open" | "fail_closed";
  required: boolean;
  depends_on: string[];
};
export type PolicyActionReference = { name: string; version: string };
export type PolicyDraftTestCase = {
  id: string;
  description: string;
  name: string;
  rail_type: PolicyRailType;
  content: string;
  expected_decision: "allow" | "block" | "transform";
  covered_rule_ids: string[];
  case_type: "unit" | "input_rail" | "output_rail" | "timeout" | "provider_failure" | "concurrency";
  required: boolean;
  expected_failure: "timeout" | "provider_failure" | null;
  concurrency_group: string | null;
  trusted_instruction: string;
  use_guardrail_instruction: boolean;
  for_each: "allowed_topics" | "restricted_topics" | null;
  target_source: TargetSource;
  query: string;
  grounding_sources: string[];
  expected_reasoning_result: AutomatedReasoningResult | null;
};
export type ProgrammablePolicyDraft = {
  colang_version: "1.0" | "2.x";
  sources: PolicySourceFile[];
  parameter_schema: PolicyDraftParameter[];
  rail_bindings: PolicyRailBinding[];
  action_references: PolicyActionReference[];
  model_dependencies: string[];
  prompt_dependencies: string[];
  execution_contract: Array<[string, string]>;
  test_cases: PolicyDraftTestCase[];
};
export type ProgrammablePolicyVersion = Omit<ProgrammablePolicyDraft, "execution_contract"> & {
  policy_id: string;
  version: string;
  name: string;
  description: string;
  source: "built_in" | "custom";
  owner: string;
  execution_contract: Array<[string, string]>;
  checksum: string;
  published_at: string;
};
export type ProgrammablePolicy = {
  implementation: "nemo_native";
  id: string;
  name: string;
  description: string;
  source: "built_in" | "custom";
  owner: string;
  draft: ProgrammablePolicyDraft;
  draft_revision: number;
  updated_at: string;
  versions?: ProgrammablePolicyVersion[];
};
export type ActionDefinition = {
  name: string;
  version: string;
  input_schema: Array<[string, string]>;
  output_schema: Array<[string, string]>;
  supported_rails: NativeRailType[];
  timeout_ms: number;
  failure_mode: "fail_open" | "fail_closed";
  side_effects: boolean;
  concurrent: boolean;
  network_access: boolean;
  secret_names: string[];
  provider_ready: boolean;
};
export type PolicyValidation = {
  valid: boolean;
  policy_id: string;
  draft_revision: number;
  colang_version: string;
  rails: NativeRailType[];
};
export type PolicyDraftValidationRun = {
  id?: string;
  policy_id?: string;
  draft_revision?: number;
  status: "not_run" | "queued" | "running" | "passed" | "failed";
  results?: Array<{
    name: string;
    case_type: PolicyDraftTestCase["case_type"];
    required: boolean;
    rail_type: PolicyRailType;
    concurrency_group: string | null;
    expected_decision: string;
    expected_failure: PolicyDraftTestCase["expected_failure"];
    actual_decision: string;
    actual_failure?: PolicyDraftTestCase["expected_failure"];
    passed: boolean;
    latency_ms: number;
    reason: string;
    covered_rule_ids: string[];
    matched_rule_ids: string[];
    trace: Array<Record<string, unknown>>;
  }>;
  created_at?: string;
};
export type GuardrailCompilePreview = {
  guardrail_id: string;
  candidate_version: number;
  engine: string;
  colang_version: string;
  compiler_version: string;
  checksum: string;
  rails: Array<{ rail_type: NativeRailType; flow: string }>;
  parallel_groups: string[];
  actions: Array<{ name: string; version: string; flow: string; timeout_ms: number; failure_mode: string }>;
  models: string[];
  dependency_manifest: Array<{ kind: string; name: string; version: string }>;
  estimated_critical_path_ms: number;
};

export type IntegrationAdapterId = "litellm-generic-guardrail" | "generic-http-guard" | "a2a-guard";
export type IntegrationProtocol = "litellm" | "http" | "a2a";
export type IntegrationSetupStatus = "applying" | "awaiting_callback" | "verified" | "disabled";

export type IntegrationSetup = {
  api_base_url: string;
  callback_url: string;
  auth_header: string;
  credential_env_var: string;
  api_base_env_var: string;
  recommended_modes: string[];
  default_on: boolean;
  fail_on_error: boolean;
  unreachable_fallback: "fail_closed" | "fail_open";
  yaml_template: string;
};

export type IntegrationCredential = {
  id: string;
  key_hint: string;
  created_at: string;
};

export type OneTimeIntegrationCredential = IntegrationCredential & {
  value: string;
};

export type Integration = {
  id: string;
  adapter_id: IntegrationAdapterId;
  protocol: IntegrationProtocol;
  name: string;
  description: string;
  enabled: boolean;
  key_hint: string;
  credentials: IntegrationCredential[];
  setup_status: IntegrationSetupStatus;
  desired_generation?: number;
  runtime_status: string;
  first_seen_at: string | null;
  input_seen_at: string | null;
  output_seen_at: string | null;
  last_seen_at: string | null;
  last_error_at: string | null;
  request_count: number;
  error_count: number;
  setup: IntegrationSetup;
  created_at: string;
  updated_at: string;
};

export type IntegrationDeletionImpact = {
  integration_id: string;
  integration_name: string;
  window_minutes: number;
  incoming_request_count: number;
  last_request_at: string | null;
  active_deployment_count: number;
  active_credential_count: number;
  telemetry_fresh: boolean;
  telemetry_watermark: string | null;
  requires_second_confirmation: boolean;
  requires_confirmation: boolean;
};

export type IntegrationRegistration = {
  integration: Integration;
  credential: OneTimeIntegrationCredential;
};

export type EvidenceRecord = {
  id: string;
  created_at: string;
  kind: string;
  outcome: string;
  guardrail_id: string | null;
  deployment_id: string | null;
  integration_id: string | null;
  risk: string | null;
  detail: string;
  actor_id: string | null;
  metadata: Record<string, string>;
};

export type LoggingLevel = "info" | "debug" | "trace";

export type GuardrailLoggingSettings = {
  guardrail_id: string;
  level: LoggingLevel;
  updated_at: string;
  updated_by: string | null;
  retention_days: number;
  content_capture_enabled: boolean;
};

export type RuntimeLogContentBlock = {
  id: string;
  role: string;
  source: string;
  text: string;
  truncated: boolean;
};

export type RuntimeLogEntry = {
  id: string;
  trace_id: string;
  created_at: string;
  phase: "input" | "output";
  outcome: "allow" | "transform" | "block" | "error" | string;
  action: string;
  risk: string | null;
  latency_ms: number;
  timed_out: boolean;
  detail: string;
  content_before: RuntimeLogContentBlock[] | null;
  content_after: RuntimeLogContentBlock[] | null;
  content_available: boolean;
  findings: DeploymentTraceFinding[];
  steps: DeploymentTraceStep[];
};

export type RuntimeLogInteraction = {
  id: string;
  created_at: string;
  completed_at: string | null;
  guardrail_id: string;
  guardrail_version: number | null;
  deployment_id: string | null;
  integration_id: string | null;
  protocol: string;
  outcome: "allow" | "transform" | "block" | "error" | string;
  capture_level: LoggingLevel;
  entries: RuntimeLogEntry[];
};

export type RuntimeLogPage = Collection<RuntimeLogInteraction> & {
  next_cursor: string | null;
};

export type MetricWindow = "1h" | "24h" | "7d" | "15d" | "30d";

export type MetricTrendPoint = {
  timestamp: string;
  total: number;
  allowed: number;
  blocked: number;
  transformed: number;
  errored: number;
  timed_out: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  p99_latency_ms: number;
};

export type MetricTrendSeries = {
  name: string;
  points: MetricTrendPoint[];
};

export type SystemStatus = {
  status: "healthy" | "degraded";
  status_reason: "runtime_ready" | "integration_degraded" | "default_runner_unavailable";
  active_deployments: number;
  enabled_integrations: number;
  total_integrations: number;
  capabilities: {
    deterministic: boolean;
    fast_semantic: boolean;
    specialized_evaluators: string[];
    generic_runtime_llm: false;
    automated_reasoning: boolean;
  };
};

export type Metrics = {
  data_availability?: {
    runtime_events: "complete" | "truncated";
    execution_evidence: "collected" | "partial" | "not_collected";
    returned_events: number;
    matching_events: number;
  };
  window: MetricWindow;
  window_start: string;
  scope: {
    guardrail_id: string | null;
    guardrail_name: string | null;
  };
  comparison: {
    previous_total_decisions: number;
    request_delta_pct: number | null;
    previous_intervention_rate: number | null;
    intervention_rate_delta_pp: number | null;
    previous_runtime_p95_ms: number | null;
    runtime_p95_delta_ms: number | null;
    previous_error_rate: number | null;
    error_rate_delta_pp: number | null;
  };
  total_decisions: number;
  allowed: number;
  blocked: number;
  intervened: number;
  errors: number;
  block_rate: number;
  intervention_rate: number;
  error_rate: number;
  timeout_count: number;
  rail_invocations: number;
  action_invocations: number;
  model_invocations: number;
  cache_hits: number;
  cache_misses: number;
  cache_hit_rate: number;
  queue_p50_ms: number;
  queue_p95_ms: number;
  queue_p99_ms: number;
  provider_p50_ms: number;
  provider_p95_ms: number;
  provider_p99_ms: number;
  fail_closed_count: number;
  peak_active_concurrency: number;
  slo_breach_count: number;
  runtime_engine_counts: Array<{ runtime_engine: string; count: number }>;
  rail_metrics: RuntimeComponentMetric[];
  action_metrics: RuntimeComponentMetric[];
  runtime_p50_ms: number;
  runtime_p95_ms: number;
  runtime_p99_ms: number;
  latency_slo: {
    p95_budget_ms: number;
    p99_budget_ms: number;
    p95_status: "healthy" | "breached";
    p99_status: "healthy" | "breached";
  };
  latest_validation_p95_ms: number;
  active_deployments: number;
  total_deployments: number;
  guardrails_needing_test: number;
  total_guardrails: number;
  degraded_integrations: number;
  total_integrations: number;
  risk_counts: Array<{ risk: string; count: number }>;
  guardrail_distribution: Array<{
    guardrail_id: string;
    name: string;
    total: number;
    share: number;
    allowed: number;
    blocked: number;
    intervened: number;
    errors: number;
    block_rate: number;
    intervention_rate: number;
    error_rate: number;
    p50_latency_ms: number;
    p95_latency_ms: number;
    p99_latency_ms: number;
    timeout_count: number;
    rail_invocations: number;
    action_invocations: number;
    model_invocations: number;
    cache_hits: number;
    cache_misses: number;
    queue_p95_ms: number;
    rail_p95_ms: number;
    action_p95_ms: number;
    provider_p95_ms: number;
    fail_closed_count: number;
    peak_active_concurrency: number;
    slo_breach_count: number;
    runtime_engines: string[];
    config_checksums: string[];
    versions: number[];
  }>;
  caller_distribution: Array<{
    integration_id: string | null;
    integration_name: string;
    deployment_id: string | null;
    deployment_name: string;
    protocol: string;
    requests: number;
    share: number;
    allowed: number;
    blocked: number;
    intervened: number;
    errors: number;
    intervention_rate: number;
    error_rate: number;
    p95_latency_ms: number;
    guardrail_versions: number[];
  }>;
  version_distribution: Array<{
    guardrail_id: string;
    guardrail_name: string;
    guardrail_version: number;
    requests: number;
    share: number;
    p95_latency_ms: number;
    errors: number;
    slo_breaches: number;
  }>;
  policy_distribution: Array<{
    policy_id: string;
    policy_version: number | null;
    invocations: number;
    hit_share: number;
    hits_per_request: number;
    passed: number;
    intervened: number;
    errors: number;
    timeouts: number;
    p50_latency_ms: number;
    p95_latency_ms: number;
    p99_latency_ms: number;
    provider_p95_ms: number;
    rail_types: string[];
    parallel_groups: string[];
  }>;
  unassigned_requests: number;
  interval: "1m" | "15m" | "1h" | "6h" | "1d";
  trend: MetricTrendPoint[];
  trend_series: {
    none: MetricTrendSeries[];
    guardrail: MetricTrendSeries[];
  };
  system_status: "healthy" | "degraded";
};

export type RuntimeComponentMetric = {
  name: string;
  risk: string | null;
  policy_id: string | null;
  policy_version: number | null;
  rail_type: string | null;
  flow_name: string | null;
  action_name: string | null;
  action_version: string | null;
  parallel_group: string | null;
  invocations: number;
  passed: number;
  intervened: number;
  uncertain: number;
  errors: number;
  timeouts: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  p99_latency_ms: number;
  provider_p50_ms: number;
  provider_p95_ms: number;
  provider_p99_ms: number;
};

export type IdentityRole = "admin" | "member";
export type IdentityUser = {
  id: string;
  display_name: string;
  email: string;
  role: IdentityRole;
  enabled: boolean;
  preferred_language: "en" | "zh-CN";
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
};
export type AuthStatus = { authenticated: boolean; user: IdentityUser | null };
export type IntentAnalysisStatus = {
  available: boolean;
  provider: string | null;
  model: string | null;
  document_analysis_available: boolean;
};
export type IntentAnalysis = { summary: string; allowed_topics: string[]; restricted_topics: string[]; review_notes: string[] };
export type ComplianceDocumentSource = {
  id: string;
  name: string;
  format: "doc" | "docx" | "txt";
  size_bytes: number;
  sha256: string;
  character_count: number;
  section_count: number;
};
export type ComplianceRequirement = {
  title: string;
  description: string;
  effect: "allow" | "block" | "transform" | "review";
  source_refs: string[];
};
export type ComplianceDocumentAnalysis = IntentAnalysis & {
  requirements: ComplianceRequirement[];
  recommended_policy_ids: string[];
  sources: ComplianceDocumentSource[];
};
