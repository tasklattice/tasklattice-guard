// Original file: runtime.proto

import type { EvaluationStage as _tasklattice_guard_control_v1_EvaluationStage, EvaluationStage__Output as _tasklattice_guard_control_v1_EvaluationStage__Output } from '../../../../tasklattice/guard/control/v1/EvaluationStage.js';
import type { GuardrailPhase as _tasklattice_guard_control_v1_GuardrailPhase, GuardrailPhase__Output as _tasklattice_guard_control_v1_GuardrailPhase__Output } from '../../../../tasklattice/guard/control/v1/GuardrailPhase.js';
import type { EnforcementAction as _tasklattice_guard_control_v1_EnforcementAction, EnforcementAction__Output as _tasklattice_guard_control_v1_EnforcementAction__Output } from '../../../../tasklattice/guard/control/v1/EnforcementAction.js';
import type { EscalationMode as _tasklattice_guard_control_v1_EscalationMode, EscalationMode__Output as _tasklattice_guard_control_v1_EscalationMode__Output } from '../../../../tasklattice/guard/control/v1/EscalationMode.js';
import type { StringPair as _tasklattice_guard_control_v1_StringPair, StringPair__Output as _tasklattice_guard_control_v1_StringPair__Output } from '../../../../tasklattice/guard/control/v1/StringPair.js';

/**
 * Evaluator requirement for one risk, stage, and set of runtime phases.
 */
export interface GuardrailPlanStep {
  'id'?: (string);
  'risk'?: (string);
  'stage'?: (_tasklattice_guard_control_v1_EvaluationStage);
  'phases'?: (_tasklattice_guard_control_v1_GuardrailPhase)[];
  'onUnsafe'?: (_tasklattice_guard_control_v1_EnforcementAction);
  'escalation'?: (_tasklattice_guard_control_v1_EscalationMode);
  /**
   * Normalized decision threshold in [0, 1]; absence selects the evaluator default.
   */
  'threshold'?: (number | string);
  /**
   * Ordered plan parameters. Keys are unique within this step.
   */
  'parameters'?: (_tasklattice_guard_control_v1_StringPair)[];
  '_threshold'?: "threshold";
}

/**
 * Evaluator requirement for one risk, stage, and set of runtime phases.
 */
export interface GuardrailPlanStep__Output {
  'id': (string);
  'risk': (string);
  'stage': (_tasklattice_guard_control_v1_EvaluationStage__Output);
  'phases': (_tasklattice_guard_control_v1_GuardrailPhase__Output)[];
  'onUnsafe': (_tasklattice_guard_control_v1_EnforcementAction__Output);
  'escalation': (_tasklattice_guard_control_v1_EscalationMode__Output);
  /**
   * Normalized decision threshold in [0, 1]; absence selects the evaluator default.
   */
  'threshold'?: (number);
  /**
   * Ordered plan parameters. Keys are unique within this step.
   */
  'parameters': (_tasklattice_guard_control_v1_StringPair__Output)[];
  '_threshold'?: "threshold";
}
