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
  /**
   * Explicit composed Router binding; empty rejects public traffic.
   */
  'routerId'?: (string);
  /**
   * F5 Scan default when the request omits flagOnly. Absence preserves true.
   */
  'scanFlagOnlyDefault'?: (boolean);
  /**
   * Whether requests must authenticate with an Endpoint credential.
   */
  'credentialRequired'?: (boolean);
  /**
   * Controller-assigned owner; absent on legacy Controllers. Callers must
   * authenticate the Endpoint against the same snapshot before using it.
   */
  'projectId'?: (string);
  /**
   * Opaque Controller-persisted allocation/snapshot provenance. Internal only;
   * public request headers and response assignments must never carry it.
   */
  'telemetryContextId'?: (string);
  '_scanFlagOnlyDefault'?: "scanFlagOnlyDefault";
  '_projectId'?: "projectId";
  '_telemetryContextId'?: "telemetryContextId";
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
  /**
   * Explicit composed Router binding; empty rejects public traffic.
   */
  'routerId': (string);
  /**
   * F5 Scan default when the request omits flagOnly. Absence preserves true.
   */
  'scanFlagOnlyDefault'?: (boolean);
  /**
   * Whether requests must authenticate with an Endpoint credential.
   */
  'credentialRequired': (boolean);
  /**
   * Controller-assigned owner; absent on legacy Controllers. Callers must
   * authenticate the Endpoint against the same snapshot before using it.
   */
  'projectId'?: (string);
  /**
   * Opaque Controller-persisted allocation/snapshot provenance. Internal only;
   * public request headers and response assignments must never carry it.
   */
  'telemetryContextId'?: (string);
  '_scanFlagOnlyDefault'?: "scanFlagOnlyDefault";
  '_projectId'?: "projectId";
  '_telemetryContextId'?: "telemetryContextId";
}
