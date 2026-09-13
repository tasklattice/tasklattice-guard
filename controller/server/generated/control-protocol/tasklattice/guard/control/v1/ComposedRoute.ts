// Original file: routing.proto

import type { TrafficScope as _tasklattice_guard_control_v1_TrafficScope, TrafficScope__Output as _tasklattice_guard_control_v1_TrafficScope__Output } from '../../../../tasklattice/guard/control/v1/TrafficScope.js';
import type { WeightedTarget as _tasklattice_guard_control_v1_WeightedTarget, WeightedTarget__Output as _tasklattice_guard_control_v1_WeightedTarget__Output } from '../../../../tasklattice/guard/control/v1/WeightedTarget.js';

/**
 * One ordered selection rule and its complete weighted distribution.
 */
export interface ComposedRoute {
  'routeId'?: (string);
  'name'?: (string);
  /**
   * normal or fallback; fallback must be enabled and unconditional.
   */
  'kind'?: (string);
  'enabled'?: (boolean);
  /**
   * Explicit Endpoint scope; empty with all_endpoints=false matches no Endpoint.
   */
  'endpointIds'?: (string)[];
  'trafficScope'?: (_tasklattice_guard_control_v1_TrafficScope | null);
  'targets'?: (_tasklattice_guard_control_v1_WeightedTarget)[];
  /**
   * True denotes an unrestricted Endpoint scope.
   */
  'allEndpoints'?: (boolean);
}

/**
 * One ordered selection rule and its complete weighted distribution.
 */
export interface ComposedRoute__Output {
  'routeId': (string);
  'name': (string);
  /**
   * normal or fallback; fallback must be enabled and unconditional.
   */
  'kind': (string);
  'enabled': (boolean);
  /**
   * Explicit Endpoint scope; empty with all_endpoints=false matches no Endpoint.
   */
  'endpointIds': (string)[];
  'trafficScope': (_tasklattice_guard_control_v1_TrafficScope__Output | null);
  'targets': (_tasklattice_guard_control_v1_WeightedTarget__Output)[];
  /**
   * True denotes an unrestricted Endpoint scope.
   */
  'allEndpoints': (boolean);
}
