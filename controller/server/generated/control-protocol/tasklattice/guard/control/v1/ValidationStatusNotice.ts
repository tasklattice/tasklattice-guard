// Original file: runner_control.proto

import type { ValidationStatus as _tasklattice_guard_control_v1_ValidationStatus, ValidationStatus__Output as _tasklattice_guard_control_v1_ValidationStatus__Output } from '../../../../tasklattice/guard/control/v1/ValidationStatus.js';

/**
 * Small terminal notification for cancellation or failure before a report can
 * be encoded. All executed case results travel through ValidationReportChunk.
 */
export interface ValidationStatusNotice {
  'runnerId'?: (string);
  'runId'?: (string);
  /**
   * Only FAILED or CANCELLED; executed case results use the chunk channel.
   */
  'status'?: (_tasklattice_guard_control_v1_ValidationStatus);
  /**
   * Human-readable terminal explanation, truncated by the Runner to 1024 characters.
   */
  'reason'?: (string);
}

/**
 * Small terminal notification for cancellation or failure before a report can
 * be encoded. All executed case results travel through ValidationReportChunk.
 */
export interface ValidationStatusNotice__Output {
  'runnerId': (string);
  'runId': (string);
  /**
   * Only FAILED or CANCELLED; executed case results use the chunk channel.
   */
  'status': (_tasklattice_guard_control_v1_ValidationStatus__Output);
  /**
   * Human-readable terminal explanation, truncated by the Runner to 1024 characters.
   */
  'reason': (string);
}
