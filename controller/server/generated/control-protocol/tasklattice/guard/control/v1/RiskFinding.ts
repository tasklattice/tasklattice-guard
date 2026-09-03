// Original file: evaluation.proto

import type { EvaluatorVerdict as _tasklattice_guard_control_v1_EvaluatorVerdict, EvaluatorVerdict__Output as _tasklattice_guard_control_v1_EvaluatorVerdict__Output } from '../../../../tasklattice/guard/control/v1/EvaluatorVerdict.js';
import type { EnforcementAction as _tasklattice_guard_control_v1_EnforcementAction, EnforcementAction__Output as _tasklattice_guard_control_v1_EnforcementAction__Output } from '../../../../tasklattice/guard/control/v1/EnforcementAction.js';
import type { GroundingFilterAssessment as _tasklattice_guard_control_v1_GroundingFilterAssessment, GroundingFilterAssessment__Output as _tasklattice_guard_control_v1_GroundingFilterAssessment__Output } from '../../../../tasklattice/guard/control/v1/GroundingFilterAssessment.js';
import type { GroundingClaimEvidence as _tasklattice_guard_control_v1_GroundingClaimEvidence, GroundingClaimEvidence__Output as _tasklattice_guard_control_v1_GroundingClaimEvidence__Output } from '../../../../tasklattice/guard/control/v1/GroundingClaimEvidence.js';
import type { AutomatedReasoningFinding as _tasklattice_guard_control_v1_AutomatedReasoningFinding, AutomatedReasoningFinding__Output as _tasklattice_guard_control_v1_AutomatedReasoningFinding__Output } from '../../../../tasklattice/guard/control/v1/AutomatedReasoningFinding.js';
import type { ProviderEvidence as _tasklattice_guard_control_v1_ProviderEvidence, ProviderEvidence__Output as _tasklattice_guard_control_v1_ProviderEvidence__Output } from '../../../../tasklattice/guard/control/v1/ProviderEvidence.js';

/**
 * Normalized finding emitted by any local or model-backed evaluator.
 */
export interface RiskFinding {
  'risk'?: (string);
  'taxonomyId'?: (string);
  'verdict'?: (_tasklattice_guard_control_v1_EvaluatorVerdict);
  /**
   * Normalized confidence in [0, 1]; absence means the evaluator did not report one.
   */
  'confidence'?: (number | string);
  /**
   * Bounded operator-readable evidence; it must not be interpreted as a machine code.
   */
  'evidence'?: (string);
  'recommendedAction'?: (_tasklattice_guard_control_v1_EnforcementAction);
  /**
   * Reviewed replacement content for redact/rewrite; absent when none was produced.
   */
  'replacement'?: (string);
  /**
   * Policy provenance; absent for evaluators invoked directly by a built-in plan step.
   */
  'policyId'?: (string);
  /**
   * Rule provenance within policy_id; absent when the finding is policy-wide.
   */
  'ruleId'?: (string);
  'grounding'?: (_tasklattice_guard_control_v1_GroundingFilterAssessment)[];
  'claims'?: (_tasklattice_guard_control_v1_GroundingClaimEvidence)[];
  'reasoning'?: (_tasklattice_guard_control_v1_AutomatedReasoningFinding)[];
  'providerEvidence'?: (_tasklattice_guard_control_v1_ProviderEvidence)[];
  '_confidence'?: "confidence";
  '_replacement'?: "replacement";
  '_policyId'?: "policyId";
  '_ruleId'?: "ruleId";
}

/**
 * Normalized finding emitted by any local or model-backed evaluator.
 */
export interface RiskFinding__Output {
  'risk': (string);
  'taxonomyId': (string);
  'verdict': (_tasklattice_guard_control_v1_EvaluatorVerdict__Output);
  /**
   * Normalized confidence in [0, 1]; absence means the evaluator did not report one.
   */
  'confidence'?: (number);
  /**
   * Bounded operator-readable evidence; it must not be interpreted as a machine code.
   */
  'evidence': (string);
  'recommendedAction': (_tasklattice_guard_control_v1_EnforcementAction__Output);
  /**
   * Reviewed replacement content for redact/rewrite; absent when none was produced.
   */
  'replacement'?: (string);
  /**
   * Policy provenance; absent for evaluators invoked directly by a built-in plan step.
   */
  'policyId'?: (string);
  /**
   * Rule provenance within policy_id; absent when the finding is policy-wide.
   */
  'ruleId'?: (string);
  'grounding': (_tasklattice_guard_control_v1_GroundingFilterAssessment__Output)[];
  'claims': (_tasklattice_guard_control_v1_GroundingClaimEvidence__Output)[];
  'reasoning': (_tasklattice_guard_control_v1_AutomatedReasoningFinding__Output)[];
  'providerEvidence': (_tasklattice_guard_control_v1_ProviderEvidence__Output)[];
  '_confidence'?: "confidence";
  '_replacement'?: "replacement";
  '_policyId'?: "policyId";
  '_ruleId'?: "ruleId";
}
