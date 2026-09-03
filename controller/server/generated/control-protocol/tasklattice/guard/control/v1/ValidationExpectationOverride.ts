// Original file: validation.proto

import type { ValidationDecision as _tasklattice_guard_control_v1_ValidationDecision, ValidationDecision__Output as _tasklattice_guard_control_v1_ValidationDecision__Output } from '../../../../tasklattice/guard/control/v1/ValidationDecision.js';
import type { ValidationExpectedMatch as _tasklattice_guard_control_v1_ValidationExpectedMatch, ValidationExpectedMatch__Output as _tasklattice_guard_control_v1_ValidationExpectedMatch__Output } from '../../../../tasklattice/guard/control/v1/ValidationExpectedMatch.js';

/**
 * An explicit, version-pinned replacement for a source case's composition expectation.
 */
export interface ValidationExpectationOverride {
  'sourcePolicyVersion'?: (string);
  /**
   * Required human-readable review rationale, retained in Validation evidence.
   */
  'reason'?: (string);
  'expectedDecision'?: (_tasklattice_guard_control_v1_ValidationDecision);
  /**
   * Exact complete output; presence distinguishes asserting empty output from no assertion.
   */
  'expectedOutputContent'?: (string);
  'expectedMatches'?: (_tasklattice_guard_control_v1_ValidationExpectedMatch)[];
  '_expectedOutputContent'?: "expectedOutputContent";
}

/**
 * An explicit, version-pinned replacement for a source case's composition expectation.
 */
export interface ValidationExpectationOverride__Output {
  'sourcePolicyVersion': (string);
  /**
   * Required human-readable review rationale, retained in Validation evidence.
   */
  'reason': (string);
  'expectedDecision': (_tasklattice_guard_control_v1_ValidationDecision__Output);
  /**
   * Exact complete output; presence distinguishes asserting empty output from no assertion.
   */
  'expectedOutputContent'?: (string);
  'expectedMatches': (_tasklattice_guard_control_v1_ValidationExpectedMatch__Output)[];
  '_expectedOutputContent'?: "expectedOutputContent";
}
