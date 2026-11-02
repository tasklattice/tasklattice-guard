// Original file: runner_control.proto


/**
 * ACK only after this chunk commits; a replay receives the same acknowledgement.
 */
export interface ValidationReportChunkAck {
  'runId'?: (string);
  'uploadId'?: (string);
  /**
   * Zero-based sequence of the durably committed or permanently rejected chunk.
   */
  'sequence'?: (number);
  /**
   * Nonempty only after a permanent rejection has been durably recorded.
   */
  'rejectionCode'?: (string);
}

/**
 * ACK only after this chunk commits; a replay receives the same acknowledgement.
 */
export interface ValidationReportChunkAck__Output {
  'runId': (string);
  'uploadId': (string);
  /**
   * Zero-based sequence of the durably committed or permanently rejected chunk.
   */
  'sequence': (number);
  /**
   * Nonempty only after a permanent rejection has been durably recorded.
   */
  'rejectionCode': (string);
}
