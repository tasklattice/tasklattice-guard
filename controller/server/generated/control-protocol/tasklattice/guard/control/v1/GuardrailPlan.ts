// Original file: runtime.proto

import type { SafetyLevel as _tasklattice_guard_control_v1_SafetyLevel, SafetyLevel__Output as _tasklattice_guard_control_v1_SafetyLevel__Output } from '../../../../tasklattice/guard/control/v1/SafetyLevel.js';
import type { OutputDeliveryMode as _tasklattice_guard_control_v1_OutputDeliveryMode, OutputDeliveryMode__Output as _tasklattice_guard_control_v1_OutputDeliveryMode__Output } from '../../../../tasklattice/guard/control/v1/OutputDeliveryMode.js';
import type { GuardrailPlanStep as _tasklattice_guard_control_v1_GuardrailPlanStep, GuardrailPlanStep__Output as _tasklattice_guard_control_v1_GuardrailPlanStep__Output } from '../../../../tasklattice/guard/control/v1/GuardrailPlanStep.js';
import type { GuardrailPlanModule as _tasklattice_guard_control_v1_GuardrailPlanModule, GuardrailPlanModule__Output as _tasklattice_guard_control_v1_GuardrailPlanModule__Output } from '../../../../tasklattice/guard/control/v1/GuardrailPlanModule.js';
import type { AutomatedReasoningPolicy as _tasklattice_guard_control_v1_AutomatedReasoningPolicy, AutomatedReasoningPolicy__Output as _tasklattice_guard_control_v1_AutomatedReasoningPolicy__Output } from '../../../../tasklattice/guard/control/v1/AutomatedReasoningPolicy.js';
import type { PolicyVersion as _tasklattice_guard_control_v1_PolicyVersion, PolicyVersion__Output as _tasklattice_guard_control_v1_PolicyVersion__Output } from '../../../../tasklattice/guard/control/v1/PolicyVersion.js';
import type { GuardrailPolicyBinding as _tasklattice_guard_control_v1_GuardrailPolicyBinding, GuardrailPolicyBinding__Output as _tasklattice_guard_control_v1_GuardrailPolicyBinding__Output } from '../../../../tasklattice/guard/control/v1/GuardrailPolicyBinding.js';

/**
 * Immutable Controller-produced plan compiled and executed by Runner.
 */
export interface GuardrailPlan {
  /**
   * Stable Controller resource identifier.
   */
  'guardrailId'?: (string);
  /**
   * Immutable, monotonically increasing version within guardrail_id.
   */
  'guardrailVersion'?: (number);
  /**
   * Compiler contract version expected to understand this plan shape.
   */
  'compilerVersion'?: (string);
  'safetyLevel'?: (_tasklattice_guard_control_v1_SafetyLevel);
  'outputDelivery'?: (_tasklattice_guard_control_v1_OutputDeliveryMode);
  /**
   * Evaluator requirements referenced by modules below.
   */
  'steps'?: (_tasklattice_guard_control_v1_GuardrailPlanStep)[];
  /**
   * Dependency-aware execution graph; module IDs and dependencies are plan-local.
   */
  'modules'?: (_tasklattice_guard_control_v1_GuardrailPlanModule)[];
  'reasoningPolicies'?: (_tasklattice_guard_control_v1_AutomatedReasoningPolicy)[];
  /**
   * Complete immutable policy snapshots needed to compile without Controller access.
   */
  'policyVersions'?: (_tasklattice_guard_control_v1_PolicyVersion)[];
  'policyBindings'?: (_tasklattice_guard_control_v1_GuardrailPolicyBinding)[];
}

/**
 * Immutable Controller-produced plan compiled and executed by Runner.
 */
export interface GuardrailPlan__Output {
  /**
   * Stable Controller resource identifier.
   */
  'guardrailId': (string);
  /**
   * Immutable, monotonically increasing version within guardrail_id.
   */
  'guardrailVersion': (number);
  /**
   * Compiler contract version expected to understand this plan shape.
   */
  'compilerVersion': (string);
  'safetyLevel': (_tasklattice_guard_control_v1_SafetyLevel__Output);
  'outputDelivery': (_tasklattice_guard_control_v1_OutputDeliveryMode__Output);
  /**
   * Evaluator requirements referenced by modules below.
   */
  'steps': (_tasklattice_guard_control_v1_GuardrailPlanStep__Output)[];
  /**
   * Dependency-aware execution graph; module IDs and dependencies are plan-local.
   */
  'modules': (_tasklattice_guard_control_v1_GuardrailPlanModule__Output)[];
  'reasoningPolicies': (_tasklattice_guard_control_v1_AutomatedReasoningPolicy__Output)[];
  /**
   * Complete immutable policy snapshots needed to compile without Controller access.
   */
  'policyVersions': (_tasklattice_guard_control_v1_PolicyVersion__Output)[];
  'policyBindings': (_tasklattice_guard_control_v1_GuardrailPolicyBinding__Output)[];
}
