// Original file: runner_control.proto

import type { Long } from '@grpc/proto-loader';

/**
 * An explicit rejection never authorizes serving. Even a grant is protocol
 * groundwork until Runner enforcement and move coordination are integrated.
 */
export interface ServingLeaseResponse {
  'nonce'?: (string);
  'granted'?: (boolean);
  'epoch'?: (number | string | Long);
  /**
   * Exact challenged desired-state generation; a different value grants nothing.
   */
  'generation'?: (number | string | Long);
  'snapshotNonce'?: (string);
  /**
   * Positive bounded lease duration in milliseconds, measured from the local challenge start.
   */
  'durationMs'?: (number);
}

/**
 * An explicit rejection never authorizes serving. Even a grant is protocol
 * groundwork until Runner enforcement and move coordination are integrated.
 */
export interface ServingLeaseResponse__Output {
  'nonce': (string);
  'granted': (boolean);
  'epoch': (string);
  /**
   * Exact challenged desired-state generation; a different value grants nothing.
   */
  'generation': (string);
  'snapshotNonce': (string);
  /**
   * Positive bounded lease duration in milliseconds, measured from the local challenge start.
   */
  'durationMs': (number);
}
