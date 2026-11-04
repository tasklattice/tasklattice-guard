// Original file: runner_control.proto

import type { ProjectAdmissionOutcomes as _tasklattice_guard_control_v1_ProjectAdmissionOutcomes, ProjectAdmissionOutcomes__Output as _tasklattice_guard_control_v1_ProjectAdmissionOutcomes__Output } from '../../../../tasklattice/guard/control/v1/ProjectAdmissionOutcomes.js';
import type { ProjectAdmissionHistogram as _tasklattice_guard_control_v1_ProjectAdmissionHistogram, ProjectAdmissionHistogram__Output as _tasklattice_guard_control_v1_ProjectAdmissionHistogram__Output } from '../../../../tasklattice/guard/control/v1/ProjectAdmissionHistogram.js';

/**
 * One configured project's local gauges and cumulative observations.
 */
export interface ProjectAdmissionObservation {
  'projectId'?: (string);
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
  'outcomes'?: (_tasklattice_guard_control_v1_ProjectAdmissionOutcomes | null);
  'wait'?: (_tasklattice_guard_control_v1_ProjectAdmissionHistogram | null);
  'held'?: (_tasklattice_guard_control_v1_ProjectAdmissionHistogram | null);
  '_active'?: "active";
  '_queued'?: "queued";
}

/**
 * One configured project's local gauges and cumulative observations.
 */
export interface ProjectAdmissionObservation__Output {
  'projectId': (string);
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
  'outcomes': (_tasklattice_guard_control_v1_ProjectAdmissionOutcomes__Output | null);
  'wait': (_tasklattice_guard_control_v1_ProjectAdmissionHistogram__Output | null);
  'held': (_tasklattice_guard_control_v1_ProjectAdmissionHistogram__Output | null);
  '_active'?: "active";
  '_queued'?: "queued";
}
