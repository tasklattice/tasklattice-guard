// Original file: evaluation.proto

import type { ClaimSupport as _tasklattice_guard_control_v1_ClaimSupport, ClaimSupport__Output as _tasklattice_guard_control_v1_ClaimSupport__Output } from '../../../../tasklattice/guard/control/v1/ClaimSupport.js';

/**
 * Evidence linking one generated claim to source content.
 */
export interface GroundingClaimEvidence {
  'id'?: (string);
  'claim'?: (string);
  'support'?: (_tasklattice_guard_control_v1_ClaimSupport);
  /**
   * Normalized support confidence in [0, 1].
   */
  'confidence'?: (number | string);
  'sourceBlockIds'?: (string)[];
  'rationale'?: (string);
}

/**
 * Evidence linking one generated claim to source content.
 */
export interface GroundingClaimEvidence__Output {
  'id': (string);
  'claim': (string);
  'support': (_tasklattice_guard_control_v1_ClaimSupport__Output);
  /**
   * Normalized support confidence in [0, 1].
   */
  'confidence': (number);
  'sourceBlockIds': (string)[];
  'rationale': (string);
}
