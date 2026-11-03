// Original file: runner_control.proto

import type { TenantAdmissionOutcomes as _tasklattice_guard_control_v1_TenantAdmissionOutcomes, TenantAdmissionOutcomes__Output as _tasklattice_guard_control_v1_TenantAdmissionOutcomes__Output } from '../../../../tasklattice/guard/control/v1/TenantAdmissionOutcomes.js';
import type { TenantAdmissionHistogram as _tasklattice_guard_control_v1_TenantAdmissionHistogram, TenantAdmissionHistogram__Output as _tasklattice_guard_control_v1_TenantAdmissionHistogram__Output } from '../../../../tasklattice/guard/control/v1/TenantAdmissionHistogram.js';

/**
 * One configured tenant's local gauges and cumulative observations.
 */
export interface TenantAdmissionObservation {
  'tenantId'?: (string);
  /**
   * Currently held local permits; absence is invalid rather than zero.
   */
  'active'?: (number);
  /**
   * Requests currently in the local admission queue; absence is invalid.
   */
  'queued'?: (number);
  /**
   * Positive local permit limit; this is not reserved distributed capacity.
   */
  'limit'?: (number);
  'outcomes'?: (_tasklattice_guard_control_v1_TenantAdmissionOutcomes | null);
  'wait'?: (_tasklattice_guard_control_v1_TenantAdmissionHistogram | null);
  'held'?: (_tasklattice_guard_control_v1_TenantAdmissionHistogram | null);
  '_active'?: "active";
  '_queued'?: "queued";
}

/**
 * One configured tenant's local gauges and cumulative observations.
 */
export interface TenantAdmissionObservation__Output {
  'tenantId': (string);
  /**
   * Currently held local permits; absence is invalid rather than zero.
   */
  'active'?: (number);
  /**
   * Requests currently in the local admission queue; absence is invalid.
   */
  'queued'?: (number);
  /**
   * Positive local permit limit; this is not reserved distributed capacity.
   */
  'limit': (number);
  'outcomes': (_tasklattice_guard_control_v1_TenantAdmissionOutcomes__Output | null);
  'wait': (_tasklattice_guard_control_v1_TenantAdmissionHistogram__Output | null);
  'held': (_tasklattice_guard_control_v1_TenantAdmissionHistogram__Output | null);
  '_active'?: "active";
  '_queued'?: "queued";
}
