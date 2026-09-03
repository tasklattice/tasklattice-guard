// Original file: runtime.proto

import type { PolicyModule as _tasklattice_guard_control_v1_PolicyModule, PolicyModule__Output as _tasklattice_guard_control_v1_PolicyModule__Output } from '../../../../tasklattice/guard/control/v1/PolicyModule.js';
import type { GuardrailPhase as _tasklattice_guard_control_v1_GuardrailPhase, GuardrailPhase__Output as _tasklattice_guard_control_v1_GuardrailPhase__Output } from '../../../../tasklattice/guard/control/v1/GuardrailPhase.js';
import type { ContentView as _tasklattice_guard_control_v1_ContentView, ContentView__Output as _tasklattice_guard_control_v1_ContentView__Output } from '../../../../tasklattice/guard/control/v1/ContentView.js';
import type { FailureMode as _tasklattice_guard_control_v1_FailureMode, FailureMode__Output as _tasklattice_guard_control_v1_FailureMode__Output } from '../../../../tasklattice/guard/control/v1/FailureMode.js';

/**
 * Dependency-aware execution group within an immutable Guardrail Plan.
 */
export interface GuardrailPlanModule {
  'id'?: (string);
  'module'?: (_tasklattice_guard_control_v1_PolicyModule);
  'phase'?: (_tasklattice_guard_control_v1_GuardrailPhase);
  'stepIds'?: (string)[];
  /**
   * Module IDs that must complete before this module becomes runnable.
   */
  'dependsOn'?: (string)[];
  'inputView'?: (_tasklattice_guard_control_v1_ContentView);
  /**
   * When true, a failure is eligible to prevent release according to failure_mode.
   */
  'requiredForRelease'?: (boolean);
  /**
   * End-to-end module deadline in milliseconds; must be greater than zero.
   */
  'timeoutMs'?: (number);
  /**
   * Decision used when this module cannot produce its required result.
   */
  'failureMode'?: (_tasklattice_guard_control_v1_FailureMode);
}

/**
 * Dependency-aware execution group within an immutable Guardrail Plan.
 */
export interface GuardrailPlanModule__Output {
  'id': (string);
  'module': (_tasklattice_guard_control_v1_PolicyModule__Output);
  'phase': (_tasklattice_guard_control_v1_GuardrailPhase__Output);
  'stepIds': (string)[];
  /**
   * Module IDs that must complete before this module becomes runnable.
   */
  'dependsOn': (string)[];
  'inputView': (_tasklattice_guard_control_v1_ContentView__Output);
  /**
   * When true, a failure is eligible to prevent release according to failure_mode.
   */
  'requiredForRelease': (boolean);
  /**
   * End-to-end module deadline in milliseconds; must be greater than zero.
   */
  'timeoutMs': (number);
  /**
   * Decision used when this module cannot produce its required result.
   */
  'failureMode': (_tasklattice_guard_control_v1_FailureMode__Output);
}
