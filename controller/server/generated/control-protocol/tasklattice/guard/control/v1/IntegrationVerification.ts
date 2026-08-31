// Original file: integration.proto

import type { IntegrationCredential as _tasklattice_guard_control_v1_IntegrationCredential, IntegrationCredential__Output as _tasklattice_guard_control_v1_IntegrationCredential__Output } from '../../../../tasklattice/guard/control/v1/IntegrationCredential.js';

/**
 * Complete set of active and recently revoked credentials for an Integration.
 */
export interface IntegrationVerification {
  /**
   * Full verifier snapshot; Runner replaces its previous set atomically.
   */
  'credentials'?: (_tasklattice_guard_control_v1_IntegrationCredential)[];
}

/**
 * Complete set of active and recently revoked credentials for an Integration.
 */
export interface IntegrationVerification__Output {
  /**
   * Full verifier snapshot; Runner replaces its previous set atomically.
   */
  'credentials': (_tasklattice_guard_control_v1_IntegrationCredential__Output)[];
}
