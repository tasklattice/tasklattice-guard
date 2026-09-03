// Original file: evaluation.proto

import type { AutomatedReasoningResult as _tasklattice_guard_control_v1_AutomatedReasoningResult, AutomatedReasoningResult__Output as _tasklattice_guard_control_v1_AutomatedReasoningResult__Output } from '../../../../tasklattice/guard/control/v1/AutomatedReasoningResult.js';
import type { AutomatedReasoningTranslation as _tasklattice_guard_control_v1_AutomatedReasoningTranslation, AutomatedReasoningTranslation__Output as _tasklattice_guard_control_v1_AutomatedReasoningTranslation__Output } from '../../../../tasklattice/guard/control/v1/AutomatedReasoningTranslation.js';
import type { AutomatedReasoningRuleEvidence as _tasklattice_guard_control_v1_AutomatedReasoningRuleEvidence, AutomatedReasoningRuleEvidence__Output as _tasklattice_guard_control_v1_AutomatedReasoningRuleEvidence__Output } from '../../../../tasklattice/guard/control/v1/AutomatedReasoningRuleEvidence.js';
import type { AutomatedReasoningScenario as _tasklattice_guard_control_v1_AutomatedReasoningScenario, AutomatedReasoningScenario__Output as _tasklattice_guard_control_v1_AutomatedReasoningScenario__Output } from '../../../../tasklattice/guard/control/v1/AutomatedReasoningScenario.js';

/**
 * Normalized automated-reasoning evidence for one checked claim set.
 */
export interface AutomatedReasoningFinding {
  'id'?: (string);
  'result'?: (_tasklattice_guard_control_v1_AutomatedReasoningResult);
  /**
   * Normalized confidence in [0, 1] for the translated reasoning result.
   */
  'confidence'?: (number | string);
  /**
   * Structured translation when the evaluator reached translation successfully.
   */
  'translation'?: (_tasklattice_guard_control_v1_AutomatedReasoningTranslation | null);
  'supportingRules'?: (_tasklattice_guard_control_v1_AutomatedReasoningRuleEvidence)[];
  'contradictingRules'?: (_tasklattice_guard_control_v1_AutomatedReasoningRuleEvidence)[];
  /**
   * Witness assignment under which the claims are true, when one was produced.
   */
  'claimsTrueScenario'?: (_tasklattice_guard_control_v1_AutomatedReasoningScenario | null);
  /**
   * Counterexample assignment under which the claims are false, when one was produced.
   */
  'claimsFalseScenario'?: (_tasklattice_guard_control_v1_AutomatedReasoningScenario | null);
  'message'?: (string);
  '_translation'?: "translation";
  '_claimsTrueScenario'?: "claimsTrueScenario";
  '_claimsFalseScenario'?: "claimsFalseScenario";
}

/**
 * Normalized automated-reasoning evidence for one checked claim set.
 */
export interface AutomatedReasoningFinding__Output {
  'id': (string);
  'result': (_tasklattice_guard_control_v1_AutomatedReasoningResult__Output);
  /**
   * Normalized confidence in [0, 1] for the translated reasoning result.
   */
  'confidence': (number);
  /**
   * Structured translation when the evaluator reached translation successfully.
   */
  'translation'?: (_tasklattice_guard_control_v1_AutomatedReasoningTranslation__Output | null);
  'supportingRules': (_tasklattice_guard_control_v1_AutomatedReasoningRuleEvidence__Output)[];
  'contradictingRules': (_tasklattice_guard_control_v1_AutomatedReasoningRuleEvidence__Output)[];
  /**
   * Witness assignment under which the claims are true, when one was produced.
   */
  'claimsTrueScenario'?: (_tasklattice_guard_control_v1_AutomatedReasoningScenario__Output | null);
  /**
   * Counterexample assignment under which the claims are false, when one was produced.
   */
  'claimsFalseScenario'?: (_tasklattice_guard_control_v1_AutomatedReasoningScenario__Output | null);
  'message': (string);
  '_translation'?: "translation";
  '_claimsTrueScenario'?: "claimsTrueScenario";
  '_claimsFalseScenario'?: "claimsFalseScenario";
}
