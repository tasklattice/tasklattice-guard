// Original file: runner_control.proto


/**
 * Idempotent stop by immutable test run ID; handled outside the ordinary command queue.
 */
export interface ValidationCancelRequest {
  'runId'?: (string);
}

/**
 * Idempotent stop by immutable test run ID; handled outside the ordinary command queue.
 */
export interface ValidationCancelRequest__Output {
  'runId': (string);
}
