// Original file: routing.proto

import type { TrafficCombinator as _tasklattice_guard_control_v1_TrafficCombinator, TrafficCombinator__Output as _tasklattice_guard_control_v1_TrafficCombinator__Output } from '../../../../tasklattice/guard/control/v1/TrafficCombinator.js';
import type { TrafficCondition as _tasklattice_guard_control_v1_TrafficCondition, TrafficCondition__Output as _tasklattice_guard_control_v1_TrafficCondition__Output } from '../../../../tasklattice/guard/control/v1/TrafficCondition.js';
import type { TrafficScope as _tasklattice_guard_control_v1_TrafficScope, TrafficScope__Output as _tasklattice_guard_control_v1_TrafficScope__Output } from '../../../../tasklattice/guard/control/v1/TrafficScope.js';

/**
 * Conditions and nested groups are intentionally separate: AND/OR evaluation
 * is commutative, so the protocol does not encode presentation ordering.
 */
export interface TrafficScope {
  /**
   * Boolean operator applied across both conditions and nested groups.
   */
  'combinator'?: (_tasklattice_guard_control_v1_TrafficCombinator);
  'conditions'?: (_tasklattice_guard_control_v1_TrafficCondition)[];
  'groups'?: (_tasklattice_guard_control_v1_TrafficScope)[];
}

/**
 * Conditions and nested groups are intentionally separate: AND/OR evaluation
 * is commutative, so the protocol does not encode presentation ordering.
 */
export interface TrafficScope__Output {
  /**
   * Boolean operator applied across both conditions and nested groups.
   */
  'combinator': (_tasklattice_guard_control_v1_TrafficCombinator__Output);
  'conditions': (_tasklattice_guard_control_v1_TrafficCondition__Output)[];
  'groups': (_tasklattice_guard_control_v1_TrafficScope__Output)[];
}
