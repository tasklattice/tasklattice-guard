// Original file: evaluation.proto

import type { GroundingFilterType as _tasklattice_guard_control_v1_GroundingFilterType, GroundingFilterType__Output as _tasklattice_guard_control_v1_GroundingFilterType__Output } from '../../../../tasklattice/guard/control/v1/GroundingFilterType.js';

/**
 * Score and threshold evidence for one grounding or relevance check.
 */
export interface GroundingFilterAssessment {
  'type'?: (_tasklattice_guard_control_v1_GroundingFilterType);
  /**
   * Normalized evaluator score in [0, 1].
   */
  'score'?: (number | string);
  /**
   * Detection boundary in [0, 1] applied to score.
   */
  'threshold'?: (number | string);
  /**
   * Evaluator's thresholded outcome, retained to avoid consumer reimplementation.
   */
  'detected'?: (boolean);
}

/**
 * Score and threshold evidence for one grounding or relevance check.
 */
export interface GroundingFilterAssessment__Output {
  'type': (_tasklattice_guard_control_v1_GroundingFilterType__Output);
  /**
   * Normalized evaluator score in [0, 1].
   */
  'score': (number);
  /**
   * Detection boundary in [0, 1] applied to score.
   */
  'threshold': (number);
  /**
   * Evaluator's thresholded outcome, retained to avoid consumer reimplementation.
   */
  'detected': (boolean);
}
