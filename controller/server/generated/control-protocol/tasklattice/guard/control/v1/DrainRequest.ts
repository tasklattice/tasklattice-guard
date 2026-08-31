// Original file: runner_control.proto

import type { Long } from '@grpc/proto-loader';

/**
 * Graceful shutdown command with an absolute admission deadline.
 */
export interface DrainRequest {
  /**
   * Operator-visible explanation for the drain.
   */
  'reason'?: (string);
  /**
   * UTC Unix epoch deadline in milliseconds after which new work must be rejected.
   */
  'deadlineUnixMs'?: (number | string | Long);
}

/**
 * Graceful shutdown command with an absolute admission deadline.
 */
export interface DrainRequest__Output {
  /**
   * Operator-visible explanation for the drain.
   */
  'reason': (string);
  /**
   * UTC Unix epoch deadline in milliseconds after which new work must be rejected.
   */
  'deadlineUnixMs': (string);
}
