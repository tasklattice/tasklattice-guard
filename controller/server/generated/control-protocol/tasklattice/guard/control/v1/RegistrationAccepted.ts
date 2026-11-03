// Original file: runner_control.proto

import type { TelemetryUploadAuthorization as _tasklattice_guard_control_v1_TelemetryUploadAuthorization, TelemetryUploadAuthorization__Output as _tasklattice_guard_control_v1_TelemetryUploadAuthorization__Output } from '../../../../tasklattice/guard/control/v1/TelemetryUploadAuthorization.js';
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
  /**
   * Secret dispatched only to this current pool-authenticated control stream.
   */
  'telemetryUploadAuthorization'?: (_tasklattice_guard_control_v1_TelemetryUploadAuthorization | null);
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
  /**
   * Secret dispatched only to this current pool-authenticated control stream.
   */
  'telemetryUploadAuthorization': (_tasklattice_guard_control_v1_TelemetryUploadAuthorization__Output | null);
}
