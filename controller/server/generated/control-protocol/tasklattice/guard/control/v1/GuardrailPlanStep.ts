// Original file: runtime.proto

import type { GuardrailPhase as _tasklattice_guard_control_v1_GuardrailPhase, GuardrailPhase__Output as _tasklattice_guard_control_v1_GuardrailPhase__Output } from '../../../../tasklattice/guard/control/v1/GuardrailPhase.js';
import type { EnforcementAction as _tasklattice_guard_control_v1_EnforcementAction, EnforcementAction__Output as _tasklattice_guard_control_v1_EnforcementAction__Output } from '../../../../tasklattice/guard/control/v1/EnforcementAction.js';
import type { EvaluationTrigger as _tasklattice_guard_control_v1_EvaluationTrigger, EvaluationTrigger__Output as _tasklattice_guard_control_v1_EvaluationTrigger__Output } from '../../../../tasklattice/guard/control/v1/EvaluationTrigger.js';
import type { StringPair as _tasklattice_guard_control_v1_StringPair, StringPair__Output as _tasklattice_guard_control_v1_StringPair__Output } from '../../../../tasklattice/guard/control/v1/StringPair.js';

/**
 * Evaluator requirement for one capability and set of runtime phases.
 */
export interface GuardrailPlanStep {
  'id'?: (string);
  'capability'?: (string);
  /**
   * Stable product evaluation contract, independent of model implementation.
   */
  'contractRef'?: (string);
  'phases'?: (_tasklattice_guard_control_v1_GuardrailPhase)[];
  'onUnsafe'?: (_tasklattice_guard_control_v1_EnforcementAction);
  'trigger'?: (_tasklattice_guard_control_v1_EvaluationTrigger | null);
  /**
   * Ordered plan parameters. Keys are unique within this step.
   */
  'parameters'?: (_tasklattice_guard_control_v1_StringPair)[];
}

/**
 * Evaluator requirement for one capability and set of runtime phases.
 */
export interface GuardrailPlanStep__Output {
  'id': (string);
  'capability': (string);
  /**
   * Stable product evaluation contract, independent of model implementation.
   */
  'contractRef': (string);
  'phases': (_tasklattice_guard_control_v1_GuardrailPhase__Output)[];
  'onUnsafe': (_tasklattice_guard_control_v1_EnforcementAction__Output);
  'trigger': (_tasklattice_guard_control_v1_EvaluationTrigger__Output | null);
  /**
   * Ordered plan parameters. Keys are unique within this step.
   */
  'parameters': (_tasklattice_guard_control_v1_StringPair__Output)[];
}
