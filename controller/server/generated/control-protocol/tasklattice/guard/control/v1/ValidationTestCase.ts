// Original file: validation.proto

import type { GuardrailPhase as _tasklattice_guard_control_v1_GuardrailPhase, GuardrailPhase__Output as _tasklattice_guard_control_v1_GuardrailPhase__Output } from '../../../../tasklattice/guard/control/v1/GuardrailPhase.js';
import type { ValidationDecision as _tasklattice_guard_control_v1_ValidationDecision, ValidationDecision__Output as _tasklattice_guard_control_v1_ValidationDecision__Output } from '../../../../tasklattice/guard/control/v1/ValidationDecision.js';
import type { TargetSource as _tasklattice_guard_control_v1_TargetSource, TargetSource__Output as _tasklattice_guard_control_v1_TargetSource__Output } from '../../../../tasklattice/guard/control/v1/TargetSource.js';
import type { AutomatedReasoningResult as _tasklattice_guard_control_v1_AutomatedReasoningResult, AutomatedReasoningResult__Output as _tasklattice_guard_control_v1_AutomatedReasoningResult__Output } from '../../../../tasklattice/guard/control/v1/AutomatedReasoningResult.js';
import type { ValidationFailure as _tasklattice_guard_control_v1_ValidationFailure, ValidationFailure__Output as _tasklattice_guard_control_v1_ValidationFailure__Output } from '../../../../tasklattice/guard/control/v1/ValidationFailure.js';

/**
 * Immutable validation input and expected business/infrastructure outcome.
 */
export interface ValidationTestCase {
  /**
   * Stable case identifier within the validation request.
   */
  'id'?: (string);
  'name'?: (string);
  'policyId'?: (string);
  'phase'?: (_tasklattice_guard_control_v1_GuardrailPhase);
  'content'?: (string);
  /**
   * Business decision required for this case to pass.
   */
  'expectedDecision'?: (_tasklattice_guard_control_v1_ValidationDecision);
  /**
   * Trusted system instruction used to evaluate indirect prompt injection.
   */
  'trustedInstruction'?: (string);
  'targetSource'?: (_tasklattice_guard_control_v1_TargetSource);
  /**
   * User query associated with retrieved/tool/model content, when applicable.
   */
  'query'?: (string);
  /**
   * Source blocks used by grounding and relevance evaluation.
   */
  'groundingSources'?: (string)[];
  /**
   * Required automated-reasoning outcome; absence means it is not asserted.
   */
  'expectedReasoningResult'?: (_tasklattice_guard_control_v1_AutomatedReasoningResult);
  /**
   * Extensible test category identifier; not a closed protocol enum.
   */
  'caseType'?: (string);
  /**
   * False marks a diagnostic case that does not fail the overall run.
   */
  'required'?: (boolean);
  /**
   * Expected infrastructure failure; absence means successful execution is expected.
   */
  'expectedFailure'?: (_tasklattice_guard_control_v1_ValidationFailure);
  /**
   * Cases in the same non-empty group are eligible for concurrent execution.
   */
  'concurrencyGroup'?: (string);
  /**
   * Original catalog policy identity for generated cases; absent for custom cases.
   */
  'sourcePolicyId'?: (string);
  /**
   * Original catalog policy version; present only together with source_policy_id.
   */
  'sourcePolicyVersion'?: (string);
  /**
   * Original catalog case ID; absent for custom cases.
   */
  'sourceCaseId'?: (string);
  'coveredRuleIds'?: (string)[];
  '_expectedReasoningResult'?: "expectedReasoningResult";
  '_expectedFailure'?: "expectedFailure";
  '_concurrencyGroup'?: "concurrencyGroup";
  '_sourcePolicyId'?: "sourcePolicyId";
  '_sourcePolicyVersion'?: "sourcePolicyVersion";
  '_sourceCaseId'?: "sourceCaseId";
}

/**
 * Immutable validation input and expected business/infrastructure outcome.
 */
export interface ValidationTestCase__Output {
  /**
   * Stable case identifier within the validation request.
   */
  'id': (string);
  'name': (string);
  'policyId': (string);
  'phase': (_tasklattice_guard_control_v1_GuardrailPhase__Output);
  'content': (string);
  /**
   * Business decision required for this case to pass.
   */
  'expectedDecision': (_tasklattice_guard_control_v1_ValidationDecision__Output);
  /**
   * Trusted system instruction used to evaluate indirect prompt injection.
   */
  'trustedInstruction': (string);
  'targetSource': (_tasklattice_guard_control_v1_TargetSource__Output);
  /**
   * User query associated with retrieved/tool/model content, when applicable.
   */
  'query': (string);
  /**
   * Source blocks used by grounding and relevance evaluation.
   */
  'groundingSources': (string)[];
  /**
   * Required automated-reasoning outcome; absence means it is not asserted.
   */
  'expectedReasoningResult'?: (_tasklattice_guard_control_v1_AutomatedReasoningResult__Output);
  /**
   * Extensible test category identifier; not a closed protocol enum.
   */
  'caseType': (string);
  /**
   * False marks a diagnostic case that does not fail the overall run.
   */
  'required': (boolean);
  /**
   * Expected infrastructure failure; absence means successful execution is expected.
   */
  'expectedFailure'?: (_tasklattice_guard_control_v1_ValidationFailure__Output);
  /**
   * Cases in the same non-empty group are eligible for concurrent execution.
   */
  'concurrencyGroup'?: (string);
  /**
   * Original catalog policy identity for generated cases; absent for custom cases.
   */
  'sourcePolicyId'?: (string);
  /**
   * Original catalog policy version; present only together with source_policy_id.
   */
  'sourcePolicyVersion'?: (string);
  /**
   * Original catalog case ID; absent for custom cases.
   */
  'sourceCaseId'?: (string);
  'coveredRuleIds': (string)[];
  '_expectedReasoningResult'?: "expectedReasoningResult";
  '_expectedFailure'?: "expectedFailure";
  '_concurrencyGroup'?: "concurrencyGroup";
  '_sourcePolicyId'?: "sourcePolicyId";
  '_sourcePolicyVersion'?: "sourcePolicyVersion";
  '_sourceCaseId'?: "sourceCaseId";
}
