// Original file: runner_control.proto

import type { IntegrationVerification as _tasklattice_guard_control_v1_IntegrationVerification, IntegrationVerification__Output as _tasklattice_guard_control_v1_IntegrationVerification__Output } from '../../../../tasklattice/guard/control/v1/IntegrationVerification.js';

/**
 * Runtime-only Integration projection; it contains no plaintext credential.
 */
export interface IntegrationRuntime {
  'integrationId'?: (string);
  /**
   * Adapter IDs are an extensible registry, not a closed enum.
   */
  'adapter'?: (string);
  'verification'?: (_tasklattice_guard_control_v1_IntegrationVerification | null);
}

/**
 * Runtime-only Integration projection; it contains no plaintext credential.
 */
export interface IntegrationRuntime__Output {
  'integrationId': (string);
  /**
   * Adapter IDs are an extensible registry, not a closed enum.
   */
  'adapter': (string);
  'verification': (_tasklattice_guard_control_v1_IntegrationVerification__Output | null);
}
