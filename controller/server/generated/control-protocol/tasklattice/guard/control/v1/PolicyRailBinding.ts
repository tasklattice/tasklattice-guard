// Original file: runtime.proto

import type { RailType as _tasklattice_guard_control_v1_RailType, RailType__Output as _tasklattice_guard_control_v1_RailType__Output } from '../../../../tasklattice/guard/control/v1/RailType.js';
import type { PolicyExecutionMode as _tasklattice_guard_control_v1_PolicyExecutionMode, PolicyExecutionMode__Output as _tasklattice_guard_control_v1_PolicyExecutionMode__Output } from '../../../../tasklattice/guard/control/v1/PolicyExecutionMode.js';
import type { EnforcementAction as _tasklattice_guard_control_v1_EnforcementAction, EnforcementAction__Output as _tasklattice_guard_control_v1_EnforcementAction__Output } from '../../../../tasklattice/guard/control/v1/EnforcementAction.js';
import type { FailureMode as _tasklattice_guard_control_v1_FailureMode, FailureMode__Output as _tasklattice_guard_control_v1_FailureMode__Output } from '../../../../tasklattice/guard/control/v1/FailureMode.js';

/**
 * Resolved execution contract binding a policy flow to one NeMo rail.
 */
export interface PolicyRailBinding {
  'railType'?: (_tasklattice_guard_control_v1_RailType);
  'flowName'?: (string);
  'executionMode'?: (_tasklattice_guard_control_v1_PolicyExecutionMode);
  'onUnsafe'?: (_tasklattice_guard_control_v1_EnforcementAction);
  /**
   * Scheduler concurrency group; absence means no explicit parallel grouping.
   */
  'parallelGroup'?: (string);
  /**
   * Ordering/conflict priority for mutating flows; larger values run later and win.
   */
  'priority'?: (number);
  /**
   * Per-flow deadline in milliseconds; must be greater than zero.
   */
  'timeoutMs'?: (number);
  /**
   * Decision used when this flow cannot produce its required result.
   */
  'failureMode'?: (_tasklattice_guard_control_v1_FailureMode);
  /**
   * Whether failure of this binding is significant to the enclosing policy result.
   */
  'required'?: (boolean);
  /**
   * Flow names that must complete before this binding becomes runnable.
   */
  'dependsOn'?: (string)[];
  '_parallelGroup'?: "parallelGroup";
  '_priority'?: "priority";
}

/**
 * Resolved execution contract binding a policy flow to one NeMo rail.
 */
export interface PolicyRailBinding__Output {
  'railType': (_tasklattice_guard_control_v1_RailType__Output);
  'flowName': (string);
  'executionMode': (_tasklattice_guard_control_v1_PolicyExecutionMode__Output);
  'onUnsafe': (_tasklattice_guard_control_v1_EnforcementAction__Output);
  /**
   * Scheduler concurrency group; absence means no explicit parallel grouping.
   */
  'parallelGroup'?: (string);
  /**
   * Ordering/conflict priority for mutating flows; larger values run later and win.
   */
  'priority'?: (number);
  /**
   * Per-flow deadline in milliseconds; must be greater than zero.
   */
  'timeoutMs': (number);
  /**
   * Decision used when this flow cannot produce its required result.
   */
  'failureMode': (_tasklattice_guard_control_v1_FailureMode__Output);
  /**
   * Whether failure of this binding is significant to the enclosing policy result.
   */
  'required': (boolean);
  /**
   * Flow names that must complete before this binding becomes runnable.
   */
  'dependsOn': (string)[];
  '_parallelGroup'?: "parallelGroup";
  '_priority'?: "priority";
}
