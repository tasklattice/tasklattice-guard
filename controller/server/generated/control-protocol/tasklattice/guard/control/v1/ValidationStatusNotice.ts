// Original file: runner_control.proto

import type { ValidationStatus as _tasklattice_guard_control_v1_ValidationStatus, ValidationStatus__Output as _tasklattice_guard_control_v1_ValidationStatus__Output } from '../../../../tasklattice/guard/control/v1/ValidationStatus.js';

/**
 * Small terminal notification for cancellation or failure before a report can
 * be encoded. All executed case results travel through ValidationReportChunk.
 */
export interface ValidationStatusNotice {
  'runnerId'?: (string);
  'runId'?: (string);
  'status'?: (_tasklattice_guard_control_v1_ValidationStatus);
  'reason'?: (string);
}

/**
 * Small terminal notification for cancellation or failure before a report can
 * be encoded. All executed case results travel through ValidationReportChunk.
 */
export interface ValidationStatusNotice__Output {
  'runnerId': (string);
  'runId': (string);
  'status': (_tasklattice_guard_control_v1_ValidationStatus__Output);
  'reason': (string);
}
