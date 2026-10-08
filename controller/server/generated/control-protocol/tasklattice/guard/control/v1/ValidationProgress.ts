// Original file: validation.proto

import type { ValidationExecutionPhase as _tasklattice_guard_control_v1_ValidationExecutionPhase, ValidationExecutionPhase__Output as _tasklattice_guard_control_v1_ValidationExecutionPhase__Output } from '../../../../tasklattice/guard/control/v1/ValidationExecutionPhase.js';

/**
 * Actual execution observations. Completion is confirmed separately by ValidationResult.
 */
export interface ValidationProgress {
  'runnerId'?: (string);
  'runId'?: (string);
  'phase'?: (_tasklattice_guard_control_v1_ValidationExecutionPhase);
  'completedCases'?: (number);
  'passedCases'?: (number);
}

/**
 * Actual execution observations. Completion is confirmed separately by ValidationResult.
 */
export interface ValidationProgress__Output {
  'runnerId': (string);
  'runId': (string);
  'phase': (_tasklattice_guard_control_v1_ValidationExecutionPhase__Output);
  'completedCases': (number);
  'passedCases': (number);
}
