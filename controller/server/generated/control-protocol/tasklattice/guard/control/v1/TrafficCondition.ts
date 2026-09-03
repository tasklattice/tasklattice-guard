// Original file: routing.proto

import type { TrafficOperator as _tasklattice_guard_control_v1_TrafficOperator, TrafficOperator__Output as _tasklattice_guard_control_v1_TrafficOperator__Output } from '../../../../tasklattice/guard/control/v1/TrafficOperator.js';

/**
 * One typed predicate evaluated against Integration request metadata.
 */
export interface TrafficCondition {
  /**
   * Registered request attribute source, for example header, path, or model.
   */
  'field'?: (string);
  /**
   * Source-specific lookup key; empty for scalar fields such as path or model.
   */
  'key'?: (string);
  'operator'?: (_tasklattice_guard_control_v1_TrafficOperator);
  /**
   * Literal comparison operand; GLOB uses Runner's documented glob syntax.
   */
  'value'?: (string);
}

/**
 * One typed predicate evaluated against Integration request metadata.
 */
export interface TrafficCondition__Output {
  /**
   * Registered request attribute source, for example header, path, or model.
   */
  'field': (string);
  /**
   * Source-specific lookup key; empty for scalar fields such as path or model.
   */
  'key': (string);
  'operator': (_tasklattice_guard_control_v1_TrafficOperator__Output);
  /**
   * Literal comparison operand; GLOB uses Runner's documented glob syntax.
   */
  'value': (string);
}
