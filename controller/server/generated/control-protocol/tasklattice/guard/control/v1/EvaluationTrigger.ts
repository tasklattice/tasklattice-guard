// Original file: runtime.proto

import type { EvaluationTriggerType as _tasklattice_guard_control_v1_EvaluationTriggerType, EvaluationTriggerType__Output as _tasklattice_guard_control_v1_EvaluationTriggerType__Output } from '../../../../tasklattice/guard/control/v1/EvaluationTriggerType.js';
import type { EvaluatorVerdict as _tasklattice_guard_control_v1_EvaluatorVerdict, EvaluatorVerdict__Output as _tasklattice_guard_control_v1_EvaluatorVerdict__Output } from '../../../../tasklattice/guard/control/v1/EvaluatorVerdict.js';

/**
 * Explicit condition for executing one evaluation contract.
 */
export interface EvaluationTrigger {
  'type'?: (_tasklattice_guard_control_v1_EvaluationTriggerType);
  /**
   * Required for ON_RESULT and absent for ALWAYS.
   */
  'stepRef'?: (string);
  /**
   * Verdicts from step_ref that make this step eligible.
   */
  'verdicts'?: (_tasklattice_guard_control_v1_EvaluatorVerdict)[];
  '_stepRef'?: "stepRef";
}

/**
 * Explicit condition for executing one evaluation contract.
 */
export interface EvaluationTrigger__Output {
  'type': (_tasklattice_guard_control_v1_EvaluationTriggerType__Output);
  /**
   * Required for ON_RESULT and absent for ALWAYS.
   */
  'stepRef'?: (string);
  /**
   * Verdicts from step_ref that make this step eligible.
   */
  'verdicts': (_tasklattice_guard_control_v1_EvaluatorVerdict__Output)[];
  '_stepRef'?: "stepRef";
}
