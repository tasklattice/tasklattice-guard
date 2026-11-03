// Original file: runner_control.proto

import type { TenantAdmissionObservation as _tasklattice_guard_control_v1_TenantAdmissionObservation, TenantAdmissionObservation__Output as _tasklattice_guard_control_v1_TenantAdmissionObservation__Output } from '../../../../tasklattice/guard/control/v1/TenantAdmissionObservation.js';

/**
 * Bounded diagnostic snapshot for at most64 configured tenants and65536 bytes.
 * Missing, invalid or oversized observations remain unavailable to monitoring.
 */
export interface TenantAdmissionSnapshot {
  'version'?: (number);
  /**
   * Explicit availability; absence is invalid and must never become false/zero data.
   */
  'available'?: (boolean);
  /**
   * Present only when unavailable; a bounded diagnostic reason, never private content.
   */
  'reason'?: (string);
  /**
   * Present only when available; positive total local permit capacity.
   */
  'capacity'?: (number);
  /**
   * Process-local monotonic seconds at observation; absence is invalid.
   */
  'monotonicSeconds'?: (number | string);
  'tenants'?: (_tasklattice_guard_control_v1_TenantAdmissionObservation)[];
  '_available'?: "available";
  '_reason'?: "reason";
  '_capacity'?: "capacity";
  '_monotonicSeconds'?: "monotonicSeconds";
}

/**
 * Bounded diagnostic snapshot for at most64 configured tenants and65536 bytes.
 * Missing, invalid or oversized observations remain unavailable to monitoring.
 */
export interface TenantAdmissionSnapshot__Output {
  'version': (number);
  /**
   * Explicit availability; absence is invalid and must never become false/zero data.
   */
  'available'?: (boolean);
  /**
   * Present only when unavailable; a bounded diagnostic reason, never private content.
   */
  'reason'?: (string);
  /**
   * Present only when available; positive total local permit capacity.
   */
  'capacity'?: (number);
  /**
   * Process-local monotonic seconds at observation; absence is invalid.
   */
  'monotonicSeconds'?: (number);
  'tenants': (_tasklattice_guard_control_v1_TenantAdmissionObservation__Output)[];
  '_available'?: "available";
  '_reason'?: "reason";
  '_capacity'?: "capacity";
  '_monotonicSeconds'?: "monotonicSeconds";
}
