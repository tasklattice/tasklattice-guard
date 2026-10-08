// Original file: runner_control.proto

import type { Artifact as _tasklattice_guard_control_v1_Artifact, Artifact__Output as _tasklattice_guard_control_v1_Artifact__Output } from '../../../../tasklattice/guard/control/v1/Artifact.js';

/**
 * Dry-run load check: verify a signed Artifact and build its runtime with the
 * Runner's current software, Actions and model configuration, then discard it.
 * Nothing is activated or served.
 */
export interface ArtifactAdmissionRequest {
  /**
   * Correlation ID echoed by the result.
   */
  'requestId'?: (string);
  'artifact'?: (_tasklattice_guard_control_v1_Artifact | null);
}

/**
 * Dry-run load check: verify a signed Artifact and build its runtime with the
 * Runner's current software, Actions and model configuration, then discard it.
 * Nothing is activated or served.
 */
export interface ArtifactAdmissionRequest__Output {
  /**
   * Correlation ID echoed by the result.
   */
  'requestId': (string);
  'artifact': (_tasklattice_guard_control_v1_Artifact__Output | null);
}
