// Original file: runner_control.proto

import type { ProjectAdmissionObservation as _tasklattice_guard_control_v1_ProjectAdmissionObservation, ProjectAdmissionObservation__Output as _tasklattice_guard_control_v1_ProjectAdmissionObservation__Output } from '../../../../tasklattice/guard/control/v1/ProjectAdmissionObservation.js';

/**
 * Bounded diagnostic snapshot for at most64 configured projects and65536 bytes.
 * Missing, invalid or oversized observations remain unavailable to monitoring.
 */
export interface ProjectAdmissionSnapshot {
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
  'projects'?: (_tasklattice_guard_control_v1_ProjectAdmissionObservation)[];
  '_available'?: "available";
  '_reason'?: "reason";
  '_capacity'?: "capacity";
  '_monotonicSeconds'?: "monotonicSeconds";
}

/**
 * Bounded diagnostic snapshot for at most64 configured projects and65536 bytes.
 * Missing, invalid or oversized observations remain unavailable to monitoring.
 */
export interface ProjectAdmissionSnapshot__Output {
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
  'projects': (_tasklattice_guard_control_v1_ProjectAdmissionObservation__Output)[];
  '_available'?: "available";
  '_reason'?: "reason";
  '_capacity'?: "capacity";
  '_monotonicSeconds'?: "monotonicSeconds";
}
