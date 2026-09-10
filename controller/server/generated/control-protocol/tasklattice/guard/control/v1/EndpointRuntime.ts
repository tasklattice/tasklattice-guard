// Original file: runner_control.proto

import type { EndpointVerification as _tasklattice_guard_control_v1_EndpointVerification, EndpointVerification__Output as _tasklattice_guard_control_v1_EndpointVerification__Output } from '../../../../tasklattice/guard/control/v1/EndpointVerification.js';

/**
 * Runtime-only Endpoint projection; it contains no plaintext credential.
 */
export interface EndpointRuntime {
  'endpointId'?: (string);
  /**
   * Adapter IDs are an extensible registry, not a closed enum.
   */
  'adapter'?: (string);
  'verification'?: (_tasklattice_guard_control_v1_EndpointVerification | null);
}

/**
 * Runtime-only Endpoint projection; it contains no plaintext credential.
 */
export interface EndpointRuntime__Output {
  'endpointId': (string);
  /**
   * Adapter IDs are an extensible registry, not a closed enum.
   */
  'adapter': (string);
  'verification': (_tasklattice_guard_control_v1_EndpointVerification__Output | null);
}
