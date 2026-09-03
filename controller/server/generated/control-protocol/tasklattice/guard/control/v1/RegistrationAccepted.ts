// Original file: runner_control.proto

import type { Long } from '@grpc/proto-loader';

/**
 * Registration acknowledgement and heartbeat contract returned by Controller.
 */
export interface RegistrationAccepted {
  /**
   * Current authoritative Controller generation for the registered pool.
   */
  'desiredGeneration'?: (number | string | Long);
  /**
   * Maximum interval in seconds between Runner heartbeats.
   */
  'heartbeatIntervalSeconds'?: (number);
}

/**
 * Registration acknowledgement and heartbeat contract returned by Controller.
 */
export interface RegistrationAccepted__Output {
  /**
   * Current authoritative Controller generation for the registered pool.
   */
  'desiredGeneration': (string);
  /**
   * Maximum interval in seconds between Runner heartbeats.
   */
  'heartbeatIntervalSeconds': (number);
}
