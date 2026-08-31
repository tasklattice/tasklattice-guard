// Original file: artifact.proto

import type { EvaluationStage as _tasklattice_guard_control_v1_EvaluationStage, EvaluationStage__Output as _tasklattice_guard_control_v1_EvaluationStage__Output } from '../../../../tasklattice/guard/control/v1/EvaluationStage.js';
import type { GuardrailPhase as _tasklattice_guard_control_v1_GuardrailPhase, GuardrailPhase__Output as _tasklattice_guard_control_v1_GuardrailPhase__Output } from '../../../../tasklattice/guard/control/v1/GuardrailPhase.js';
import type { EnforcementAction as _tasklattice_guard_control_v1_EnforcementAction, EnforcementAction__Output as _tasklattice_guard_control_v1_EnforcementAction__Output } from '../../../../tasklattice/guard/control/v1/EnforcementAction.js';
import type { EscalationMode as _tasklattice_guard_control_v1_EscalationMode, EscalationMode__Output as _tasklattice_guard_control_v1_EscalationMode__Output } from '../../../../tasklattice/guard/control/v1/EscalationMode.js';
import type { StringPair as _tasklattice_guard_control_v1_StringPair, StringPair__Output as _tasklattice_guard_control_v1_StringPair__Output } from '../../../../tasklattice/guard/control/v1/StringPair.js';
import type { PolicyExecutionMode as _tasklattice_guard_control_v1_PolicyExecutionMode, PolicyExecutionMode__Output as _tasklattice_guard_control_v1_PolicyExecutionMode__Output } from '../../../../tasklattice/guard/control/v1/PolicyExecutionMode.js';
import type { FailureMode as _tasklattice_guard_control_v1_FailureMode, FailureMode__Output as _tasklattice_guard_control_v1_FailureMode__Output } from '../../../../tasklattice/guard/control/v1/FailureMode.js';

/**
 * Fully resolved runtime action invocation emitted by the compiler.
 */
export interface ActionBinding {
  'id'?: (string);
  'risk'?: (string);
  'stage'?: (_tasklattice_guard_control_v1_EvaluationStage);
  'phases'?: (_tasklattice_guard_control_v1_GuardrailPhase)[];
  'onUnsafe'?: (_tasklattice_guard_control_v1_EnforcementAction);
  'escalation'?: (_tasklattice_guard_control_v1_EscalationMode);
  /**
   * End-to-end action deadline in milliseconds; must be greater than zero.
   */
  'timeoutMs'?: (number);
  'parameters'?: (_tasklattice_guard_control_v1_StringPair)[];
  /**
   * Source policy identity; absent for built-in plan steps not backed by a policy.
   */
  'policyId'?: (string);
  /**
   * Source policy version; present only together with policy_id.
   */
  'policyVersion'?: (string);
  /**
   * Compiled policy flow; absent for native runtime evaluators.
   */
  'flowName'?: (string);
  /**
   * Registered NeMo Action name; absent when the binding does not invoke an Action.
   */
  'actionName'?: (string);
  /**
   * Registered Action version; present only together with action_name.
   */
  'actionVersion'?: (string);
  /**
   * Scheduler concurrency group; absence means no explicit parallel grouping.
   */
  'parallelGroup'?: (string);
  'executionMode'?: (_tasklattice_guard_control_v1_PolicyExecutionMode);
  /**
   * Decision used when the Action times out or fails.
   */
  'failureMode'?: (_tasklattice_guard_control_v1_FailureMode);
  /**
   * Action binding IDs that must complete before this binding becomes runnable.
   */
  'dependsOn'?: (string)[];
  /**
   * NeMo context variable receiving this Action's result, when one is required.
   */
  'resultVar'?: (string);
  '_policyId'?: "policyId";
  '_policyVersion'?: "policyVersion";
  '_flowName'?: "flowName";
  '_actionName'?: "actionName";
  '_actionVersion'?: "actionVersion";
  '_parallelGroup'?: "parallelGroup";
  '_resultVar'?: "resultVar";
}

/**
 * Fully resolved runtime action invocation emitted by the compiler.
 */
export interface ActionBinding__Output {
  'id': (string);
  'risk': (string);
  'stage': (_tasklattice_guard_control_v1_EvaluationStage__Output);
  'phases': (_tasklattice_guard_control_v1_GuardrailPhase__Output)[];
  'onUnsafe': (_tasklattice_guard_control_v1_EnforcementAction__Output);
  'escalation': (_tasklattice_guard_control_v1_EscalationMode__Output);
  /**
   * End-to-end action deadline in milliseconds; must be greater than zero.
   */
  'timeoutMs': (number);
  'parameters': (_tasklattice_guard_control_v1_StringPair__Output)[];
  /**
   * Source policy identity; absent for built-in plan steps not backed by a policy.
   */
  'policyId'?: (string);
  /**
   * Source policy version; present only together with policy_id.
   */
  'policyVersion'?: (string);
  /**
   * Compiled policy flow; absent for native runtime evaluators.
   */
  'flowName'?: (string);
  /**
   * Registered NeMo Action name; absent when the binding does not invoke an Action.
   */
  'actionName'?: (string);
  /**
   * Registered Action version; present only together with action_name.
   */
  'actionVersion'?: (string);
  /**
   * Scheduler concurrency group; absence means no explicit parallel grouping.
   */
  'parallelGroup'?: (string);
  'executionMode': (_tasklattice_guard_control_v1_PolicyExecutionMode__Output);
  /**
   * Decision used when the Action times out or fails.
   */
  'failureMode': (_tasklattice_guard_control_v1_FailureMode__Output);
  /**
   * Action binding IDs that must complete before this binding becomes runnable.
   */
  'dependsOn': (string)[];
  /**
   * NeMo context variable receiving this Action's result, when one is required.
   */
  'resultVar'?: (string);
  '_policyId'?: "policyId";
  '_policyVersion'?: "policyVersion";
  '_flowName'?: "flowName";
  '_actionName'?: "actionName";
  '_actionVersion'?: "actionVersion";
  '_parallelGroup'?: "parallelGroup";
  '_resultVar'?: "resultVar";
}
