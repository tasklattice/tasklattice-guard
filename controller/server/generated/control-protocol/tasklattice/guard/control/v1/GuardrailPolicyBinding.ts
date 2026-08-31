// Original file: runtime.proto

import type { EnforcementAction as _tasklattice_guard_control_v1_EnforcementAction, EnforcementAction__Output as _tasklattice_guard_control_v1_EnforcementAction__Output } from '../../../../tasklattice/guard/control/v1/EnforcementAction.js';
import type { StringPair as _tasklattice_guard_control_v1_StringPair, StringPair__Output as _tasklattice_guard_control_v1_StringPair__Output } from '../../../../tasklattice/guard/control/v1/StringPair.js';
import type { RailType as _tasklattice_guard_control_v1_RailType, RailType__Output as _tasklattice_guard_control_v1_RailType__Output } from '../../../../tasklattice/guard/control/v1/RailType.js';

/**
 * Product configuration binding one policy version into a Guardrail Plan.
 */
export interface GuardrailPolicyBinding {
  'policyId'?: (string);
  'policyVersion'?: (string);
  /**
   * Optional binding-wide override; absence preserves each policy rule's action.
   */
  'action'?: (_tasklattice_guard_control_v1_EnforcementAction);
  /**
   * Ordered values validated against PolicyVersion.parameter_schema.
   */
  'parameterValues'?: (_tasklattice_guard_control_v1_StringPair)[];
  'enabledRuleIds'?: (string)[];
  /**
   * Rule ID to EnforcementAction name; keys must be present in enabled_rule_ids.
   */
  'ruleActions'?: (_tasklattice_guard_control_v1_StringPair)[];
  'enabledRails'?: (_tasklattice_guard_control_v1_RailType)[];
  '_action'?: "action";
}

/**
 * Product configuration binding one policy version into a Guardrail Plan.
 */
export interface GuardrailPolicyBinding__Output {
  'policyId': (string);
  'policyVersion': (string);
  /**
   * Optional binding-wide override; absence preserves each policy rule's action.
   */
  'action'?: (_tasklattice_guard_control_v1_EnforcementAction__Output);
  /**
   * Ordered values validated against PolicyVersion.parameter_schema.
   */
  'parameterValues': (_tasklattice_guard_control_v1_StringPair__Output)[];
  'enabledRuleIds': (string)[];
  /**
   * Rule ID to EnforcementAction name; keys must be present in enabled_rule_ids.
   */
  'ruleActions': (_tasklattice_guard_control_v1_StringPair__Output)[];
  'enabledRails': (_tasklattice_guard_control_v1_RailType__Output)[];
  '_action'?: "action";
}
