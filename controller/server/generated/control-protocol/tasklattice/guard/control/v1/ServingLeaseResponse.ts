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
  'generation'?: (number | string | Long);
  'snapshotNonce'?: (string);
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
  'generation': (string);
  'snapshotNonce': (string);
  'durationMs': (number);
}
