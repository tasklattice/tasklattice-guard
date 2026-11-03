// Original file: runner_control.proto

import type { RunnerLoad as _tasklattice_guard_control_v1_RunnerLoad, RunnerLoad__Output as _tasklattice_guard_control_v1_RunnerLoad__Output } from '../../../../tasklattice/guard/control/v1/RunnerLoad.js';
import type { TenantAdmissionSnapshot as _tasklattice_guard_control_v1_TenantAdmissionSnapshot, TenantAdmissionSnapshot__Output as _tasklattice_guard_control_v1_TenantAdmissionSnapshot__Output } from '../../../../tasklattice/guard/control/v1/TenantAdmissionSnapshot.js';
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
  'appliedProtectionGeneration'?: (number | string | Long);
  /**
   * Optional bounded process-local admission measurements, not quota authority.
   */
  'tenantAdmissionSnapshot'?: (_tasklattice_guard_control_v1_TenantAdmissionSnapshot | null);
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
  'appliedProtectionGeneration': (string);
  /**
   * Optional bounded process-local admission measurements, not quota authority.
   */
  'tenantAdmissionSnapshot': (_tasklattice_guard_control_v1_TenantAdmissionSnapshot__Output | null);
}
