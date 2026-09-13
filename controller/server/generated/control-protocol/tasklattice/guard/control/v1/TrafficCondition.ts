// Original file: routing.proto

import type { TrafficOperator as _tasklattice_guard_control_v1_TrafficOperator, TrafficOperator__Output as _tasklattice_guard_control_v1_TrafficOperator__Output } from '../../../../tasklattice/guard/control/v1/TrafficOperator.js';

/**
 * One typed predicate evaluated against Endpoint request metadata.
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
  /**
   * Explicit HTTP source: endpoint_request or business_request; empty for non-HTTP fields.
   */
  'requestSource'?: (string);
  /**
   * Operands for IN and NOT_IN; scalar operators use value instead.
   */
  'values'?: (string)[];
  /**
   * Absence means case-sensitive; false uses ASCII-only case folding.
   */
  'caseSensitive'?: (boolean);
  '_caseSensitive'?: "caseSensitive";
}

/**
 * One typed predicate evaluated against Endpoint request metadata.
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
  /**
   * Explicit HTTP source: endpoint_request or business_request; empty for non-HTTP fields.
   */
  'requestSource': (string);
  /**
   * Operands for IN and NOT_IN; scalar operators use value instead.
   */
  'values': (string)[];
  /**
   * Absence means case-sensitive; false uses ASCII-only case folding.
   */
  'caseSensitive'?: (boolean);
  '_caseSensitive'?: "caseSensitive";
}
