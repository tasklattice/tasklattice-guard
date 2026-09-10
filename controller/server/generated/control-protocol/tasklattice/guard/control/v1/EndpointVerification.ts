// Original file: endpoint.proto

import type { EndpointCredential as _tasklattice_guard_control_v1_EndpointCredential, EndpointCredential__Output as _tasklattice_guard_control_v1_EndpointCredential__Output } from '../../../../tasklattice/guard/control/v1/EndpointCredential.js';

/**
 * Complete set of active and recently revoked credentials for an Endpoint.
 */
export interface EndpointVerification {
  /**
   * Full verifier snapshot; Runner replaces its previous set atomically.
   */
  'credentials'?: (_tasklattice_guard_control_v1_EndpointCredential)[];
}

/**
 * Complete set of active and recently revoked credentials for an Endpoint.
 */
export interface EndpointVerification__Output {
  /**
   * Full verifier snapshot; Runner replaces its previous set atomically.
   */
  'credentials': (_tasklattice_guard_control_v1_EndpointCredential__Output)[];
}
