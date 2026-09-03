// Original file: evaluation.proto

import type { EvaluatorVerdict as _tasklattice_guard_control_v1_EvaluatorVerdict, EvaluatorVerdict__Output as _tasklattice_guard_control_v1_EvaluatorVerdict__Output } from '../../../../tasklattice/guard/control/v1/EvaluatorVerdict.js';
import type { RouteDecision as _tasklattice_guard_control_v1_RouteDecision, RouteDecision__Output as _tasklattice_guard_control_v1_RouteDecision__Output } from '../../../../tasklattice/guard/control/v1/RouteDecision.js';
import type { RailType as _tasklattice_guard_control_v1_RailType, RailType__Output as _tasklattice_guard_control_v1_RailType__Output } from '../../../../tasklattice/guard/control/v1/RailType.js';

/**
 * Stable execution trace envelope. Provider-specific diagnostic text stays in
 * evidence/detail while scheduling and model timing remain strongly typed.
 */
export interface RuntimeTraceStep {
  'id'?: (string);
  /**
   * Extensible trace-node category; consumers must tolerate unknown values.
   */
  'kind'?: (string);
  'name'?: (string);
  /**
   * Extensible execution status; structured verdict/route fields carry decisions.
   */
  'status'?: (string);
  'detail'?: (string);
  /**
   * Wall-clock duration of this trace node in milliseconds.
   */
  'durationMs'?: (number);
  /**
   * Parent trace-node ID; absence identifies a root node.
   */
  'parentId'?: (string);
  /**
   * Bounded evidence captured for this node; absence means none was retained.
   */
  'evidence'?: (string);
  /**
   * Stable evaluation contract active for this node, when applicable.
   */
  'contractRef'?: (string);
  /**
   * Normalized evaluator verdict when this node performed evaluation.
   */
  'verdict'?: (_tasklattice_guard_control_v1_EvaluatorVerdict);
  /**
   * Coordinator route when this node made a routing decision.
   */
  'route'?: (_tasklattice_guard_control_v1_RouteDecision);
  /**
   * Product capability ID when this node is capability-specific.
   */
  'capability'?: (string);
  /**
   * Normalized confidence in [0, 1], when reported by this node.
   */
  'confidence'?: (number | string);
  /**
   * Content-block correlation ID when evaluation used a structured content view.
   */
  'contentBlockId'?: (string);
  /**
   * GuardrailPlanModule.id when this node belongs to a plan module.
   */
  'moduleId'?: (string);
  /**
   * Guardrail identity when this node is scoped to one Guardrail.
   */
  'guardrailId'?: (string);
  /**
   * Immutable Guardrail version associated with this trace node.
   */
  'guardrailVersion'?: (number);
  /**
   * Policy provenance when this node executes a programmable policy.
   */
  'policyId'?: (string);
  /**
   * Policy version; present only together with policy_id.
   */
  'policyVersion'?: (string);
  /**
   * NeMo rail surface when this node executes a rail binding.
   */
  'railType'?: (_tasklattice_guard_control_v1_RailType);
  /**
   * Compiled policy flow name when this node executes a flow.
   */
  'flowName'?: (string);
  /**
   * Registered Action name when this node invokes an Action.
   */
  'actionName'?: (string);
  /**
   * Registered Action version; present only together with action_name.
   */
  'actionVersion'?: (string);
  /**
   * Extensible node-specific outcome; not a substitute for verdict or route.
   */
  'outcome'?: (string);
  /**
   * Configured node deadline in milliseconds, when a deadline applies.
   */
  'timeoutMs'?: (number);
  /**
   * True when this node ended because its configured deadline expired.
   */
  'timedOut'?: (boolean);
  /**
   * Scheduler concurrency group when this node ran in an explicit parallel group.
   */
  'parallelGroup'?: (string);
  /**
   * Runtime engine registry ID, for example iorails or llmrails.
   */
  'engine'?: (string);
  /**
   * Extensible runtime registry identifier active for this node.
   */
  'runtimeProfile'?: (string);
  /**
   * Artifact/config checksum active while this node executed.
   */
  'configChecksum'?: (string);
  /**
   * Provider-reported or measured aggregate latency in milliseconds.
   */
  'providerLatencyMs'?: (number);
  /**
   * Sum of individual Provider/model call durations; may exceed wall time under concurrency.
   */
  'providerWorkMs'?: (number);
  /**
   * Union wall time spent waiting on Provider/model calls in milliseconds.
   */
  'modelWaitMs'?: (number);
  /**
   * Provider registry ID when this node made a remote/local model call.
   */
  'providerName'?: (string);
  /**
   * Exact model identifier used for the call.
   */
  'modelName'?: (string);
  /**
   * Extensible model operation identifier, such as classify or generate.
   */
  'modelOperation'?: (string);
  /**
   * Bounded normalized/native model result summary, when retained.
   */
  'modelResult'?: (string);
  /**
   * Stable technical error category; absence means no model error was observed.
   */
  'errorType'?: (string);
  /**
   * Milliseconds from model-call start to first token; absent for non-streaming calls.
   */
  'modelTimeToFirstTokenMs'?: (number);
  /**
   * Provider-reported input token count, or zero when unavailable.
   */
  'modelInputTokens'?: (number);
  /**
   * Provider-reported output token count, or zero when unavailable.
   */
  'modelOutputTokens'?: (number);
  /**
   * Number of retries after the initial model attempt.
   */
  'modelRetries'?: (number);
  /**
   * Total retry backoff time in milliseconds.
   */
  'modelBackoffMs'?: (number);
  /**
   * Milliseconds from the request trace origin to the first model-call start.
   */
  'startedOffsetMs'?: (number);
  /**
   * Milliseconds from the request trace origin to the last model-call finish.
   */
  'finishedOffsetMs'?: (number);
  /**
   * Concrete evaluator implementation invoked for this node.
   */
  'evaluatorId'?: (string);
  /**
   * Versioned implementation profile used by a model-backed evaluator.
   */
  'profileRef'?: (string);
  '_parentId'?: "parentId";
  '_evidence'?: "evidence";
  '_contractRef'?: "contractRef";
  '_verdict'?: "verdict";
  '_route'?: "route";
  '_capability'?: "capability";
  '_confidence'?: "confidence";
  '_contentBlockId'?: "contentBlockId";
  '_moduleId'?: "moduleId";
  '_guardrailId'?: "guardrailId";
  '_guardrailVersion'?: "guardrailVersion";
  '_policyId'?: "policyId";
  '_policyVersion'?: "policyVersion";
  '_railType'?: "railType";
  '_flowName'?: "flowName";
  '_actionName'?: "actionName";
  '_actionVersion'?: "actionVersion";
  '_outcome'?: "outcome";
  '_timeoutMs'?: "timeoutMs";
  '_parallelGroup'?: "parallelGroup";
  '_engine'?: "engine";
  '_runtimeProfile'?: "runtimeProfile";
  '_configChecksum'?: "configChecksum";
  '_providerName'?: "providerName";
  '_modelName'?: "modelName";
  '_modelOperation'?: "modelOperation";
  '_modelResult'?: "modelResult";
  '_errorType'?: "errorType";
  '_modelTimeToFirstTokenMs'?: "modelTimeToFirstTokenMs";
  '_startedOffsetMs'?: "startedOffsetMs";
  '_finishedOffsetMs'?: "finishedOffsetMs";
  '_evaluatorId'?: "evaluatorId";
  '_profileRef'?: "profileRef";
}

/**
 * Stable execution trace envelope. Provider-specific diagnostic text stays in
 * evidence/detail while scheduling and model timing remain strongly typed.
 */
export interface RuntimeTraceStep__Output {
  'id': (string);
  /**
   * Extensible trace-node category; consumers must tolerate unknown values.
   */
  'kind': (string);
  'name': (string);
  /**
   * Extensible execution status; structured verdict/route fields carry decisions.
   */
  'status': (string);
  'detail': (string);
  /**
   * Wall-clock duration of this trace node in milliseconds.
   */
  'durationMs': (number);
  /**
   * Parent trace-node ID; absence identifies a root node.
   */
  'parentId'?: (string);
  /**
   * Bounded evidence captured for this node; absence means none was retained.
   */
  'evidence'?: (string);
  /**
   * Stable evaluation contract active for this node, when applicable.
   */
  'contractRef'?: (string);
  /**
   * Normalized evaluator verdict when this node performed evaluation.
   */
  'verdict'?: (_tasklattice_guard_control_v1_EvaluatorVerdict__Output);
  /**
   * Coordinator route when this node made a routing decision.
   */
  'route'?: (_tasklattice_guard_control_v1_RouteDecision__Output);
  /**
   * Product capability ID when this node is capability-specific.
   */
  'capability'?: (string);
  /**
   * Normalized confidence in [0, 1], when reported by this node.
   */
  'confidence'?: (number);
  /**
   * Content-block correlation ID when evaluation used a structured content view.
   */
  'contentBlockId'?: (string);
  /**
   * GuardrailPlanModule.id when this node belongs to a plan module.
   */
  'moduleId'?: (string);
  /**
   * Guardrail identity when this node is scoped to one Guardrail.
   */
  'guardrailId'?: (string);
  /**
   * Immutable Guardrail version associated with this trace node.
   */
  'guardrailVersion'?: (number);
  /**
   * Policy provenance when this node executes a programmable policy.
   */
  'policyId'?: (string);
  /**
   * Policy version; present only together with policy_id.
   */
  'policyVersion'?: (string);
  /**
   * NeMo rail surface when this node executes a rail binding.
   */
  'railType'?: (_tasklattice_guard_control_v1_RailType__Output);
  /**
   * Compiled policy flow name when this node executes a flow.
   */
  'flowName'?: (string);
  /**
   * Registered Action name when this node invokes an Action.
   */
  'actionName'?: (string);
  /**
   * Registered Action version; present only together with action_name.
   */
  'actionVersion'?: (string);
  /**
   * Extensible node-specific outcome; not a substitute for verdict or route.
   */
  'outcome'?: (string);
  /**
   * Configured node deadline in milliseconds, when a deadline applies.
   */
  'timeoutMs'?: (number);
  /**
   * True when this node ended because its configured deadline expired.
   */
  'timedOut': (boolean);
  /**
   * Scheduler concurrency group when this node ran in an explicit parallel group.
   */
  'parallelGroup'?: (string);
  /**
   * Runtime engine registry ID, for example iorails or llmrails.
   */
  'engine'?: (string);
  /**
   * Extensible runtime registry identifier active for this node.
   */
  'runtimeProfile'?: (string);
  /**
   * Artifact/config checksum active while this node executed.
   */
  'configChecksum'?: (string);
  /**
   * Provider-reported or measured aggregate latency in milliseconds.
   */
  'providerLatencyMs': (number);
  /**
   * Sum of individual Provider/model call durations; may exceed wall time under concurrency.
   */
  'providerWorkMs': (number);
  /**
   * Union wall time spent waiting on Provider/model calls in milliseconds.
   */
  'modelWaitMs': (number);
  /**
   * Provider registry ID when this node made a remote/local model call.
   */
  'providerName'?: (string);
  /**
   * Exact model identifier used for the call.
   */
  'modelName'?: (string);
  /**
   * Extensible model operation identifier, such as classify or generate.
   */
  'modelOperation'?: (string);
  /**
   * Bounded normalized/native model result summary, when retained.
   */
  'modelResult'?: (string);
  /**
   * Stable technical error category; absence means no model error was observed.
   */
  'errorType'?: (string);
  /**
   * Milliseconds from model-call start to first token; absent for non-streaming calls.
   */
  'modelTimeToFirstTokenMs'?: (number);
  /**
   * Provider-reported input token count, or zero when unavailable.
   */
  'modelInputTokens': (number);
  /**
   * Provider-reported output token count, or zero when unavailable.
   */
  'modelOutputTokens': (number);
  /**
   * Number of retries after the initial model attempt.
   */
  'modelRetries': (number);
  /**
   * Total retry backoff time in milliseconds.
   */
  'modelBackoffMs': (number);
  /**
   * Milliseconds from the request trace origin to the first model-call start.
   */
  'startedOffsetMs'?: (number);
  /**
   * Milliseconds from the request trace origin to the last model-call finish.
   */
  'finishedOffsetMs'?: (number);
  /**
   * Concrete evaluator implementation invoked for this node.
   */
  'evaluatorId'?: (string);
  /**
   * Versioned implementation profile used by a model-backed evaluator.
   */
  'profileRef'?: (string);
  '_parentId'?: "parentId";
  '_evidence'?: "evidence";
  '_contractRef'?: "contractRef";
  '_verdict'?: "verdict";
  '_route'?: "route";
  '_capability'?: "capability";
  '_confidence'?: "confidence";
  '_contentBlockId'?: "contentBlockId";
  '_moduleId'?: "moduleId";
  '_guardrailId'?: "guardrailId";
  '_guardrailVersion'?: "guardrailVersion";
  '_policyId'?: "policyId";
  '_policyVersion'?: "policyVersion";
  '_railType'?: "railType";
  '_flowName'?: "flowName";
  '_actionName'?: "actionName";
  '_actionVersion'?: "actionVersion";
  '_outcome'?: "outcome";
  '_timeoutMs'?: "timeoutMs";
  '_parallelGroup'?: "parallelGroup";
  '_engine'?: "engine";
  '_runtimeProfile'?: "runtimeProfile";
  '_configChecksum'?: "configChecksum";
  '_providerName'?: "providerName";
  '_modelName'?: "modelName";
  '_modelOperation'?: "modelOperation";
  '_modelResult'?: "modelResult";
  '_errorType'?: "errorType";
  '_modelTimeToFirstTokenMs'?: "modelTimeToFirstTokenMs";
  '_startedOffsetMs'?: "startedOffsetMs";
  '_finishedOffsetMs'?: "finishedOffsetMs";
  '_evaluatorId'?: "evaluatorId";
  '_profileRef'?: "profileRef";
}
