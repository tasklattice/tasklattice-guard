// Original file: runner_control.proto

import type { RunnerLoad as _tasklattice_guard_control_v1_RunnerLoad, RunnerLoad__Output as _tasklattice_guard_control_v1_RunnerLoad__Output } from '../../../../tasklattice/guard/control/v1/RunnerLoad.js';
import type { Long } from '@grpc/proto-loader';

/**
 * Monotonic liveness, convergence, and load observation for one Runner boot.
 */
export interface RunnerHeartbeat {
  'runnerId'?: (string);
  'bootId'?: (string);
  /**
   * Strictly increasing within one boot; stale or duplicate values are ignored.
   */
  'sequence'?: (number | string | Long);
  /**
   * Last atomically activated desired-state generation at observation time.
   */
  'appliedGeneration'?: (number | string | Long);
  'load'?: (_tasklattice_guard_control_v1_RunnerLoad | null);
}

/**
 * Monotonic liveness, convergence, and load observation for one Runner boot.
 */
export interface RunnerHeartbeat__Output {
  'runnerId': (string);
  'bootId': (string);
  /**
   * Strictly increasing within one boot; stale or duplicate values are ignored.
   */
  'sequence': (string);
  /**
   * Last atomically activated desired-state generation at observation time.
   */
  'appliedGeneration': (string);
  'load': (_tasklattice_guard_control_v1_RunnerLoad__Output | null);
}
