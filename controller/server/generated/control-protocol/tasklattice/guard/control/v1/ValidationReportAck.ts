// Original file: runner_control.proto


/**
 * Sent only after the report transaction commits (or an idempotent replay).
 */
export interface ValidationReportAck {
  'runId'?: (string);
}

/**
 * Sent only after the report transaction commits (or an idempotent replay).
 */
export interface ValidationReportAck__Output {
  'runId': (string);
}
