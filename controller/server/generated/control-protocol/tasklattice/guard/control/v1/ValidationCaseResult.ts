// Original file: validation.proto

import type { ValidationDecision as _tasklattice_guard_control_v1_ValidationDecision, ValidationDecision__Output as _tasklattice_guard_control_v1_ValidationDecision__Output } from '../../../../tasklattice/guard/control/v1/ValidationDecision.js';
import type { ValidationStage as _tasklattice_guard_control_v1_ValidationStage, ValidationStage__Output as _tasklattice_guard_control_v1_ValidationStage__Output } from '../../../../tasklattice/guard/control/v1/ValidationStage.js';
import type { GuardrailPhase as _tasklattice_guard_control_v1_GuardrailPhase, GuardrailPhase__Output as _tasklattice_guard_control_v1_GuardrailPhase__Output } from '../../../../tasklattice/guard/control/v1/GuardrailPhase.js';
import type { EnforcementAction as _tasklattice_guard_control_v1_EnforcementAction, EnforcementAction__Output as _tasklattice_guard_control_v1_EnforcementAction__Output } from '../../../../tasklattice/guard/control/v1/EnforcementAction.js';
import type { RiskFinding as _tasklattice_guard_control_v1_RiskFinding, RiskFinding__Output as _tasklattice_guard_control_v1_RiskFinding__Output } from '../../../../tasklattice/guard/control/v1/RiskFinding.js';
import type { RuntimeTraceStep as _tasklattice_guard_control_v1_RuntimeTraceStep, RuntimeTraceStep__Output as _tasklattice_guard_control_v1_RuntimeTraceStep__Output } from '../../../../tasklattice/guard/control/v1/RuntimeTraceStep.js';
import type { TargetSource as _tasklattice_guard_control_v1_TargetSource, TargetSource__Output as _tasklattice_guard_control_v1_TargetSource__Output } from '../../../../tasklattice/guard/control/v1/TargetSource.js';
import type { AutomatedReasoningResult as _tasklattice_guard_control_v1_AutomatedReasoningResult, AutomatedReasoningResult__Output as _tasklattice_guard_control_v1_AutomatedReasoningResult__Output } from '../../../../tasklattice/guard/control/v1/AutomatedReasoningResult.js';
import type { ValidationFailure as _tasklattice_guard_control_v1_ValidationFailure, ValidationFailure__Output as _tasklattice_guard_control_v1_ValidationFailure__Output } from '../../../../tasklattice/guard/control/v1/ValidationFailure.js';

/**
 * Observed decision, evidence, and trace for one validation case.
 */
export interface ValidationCaseResult {
  'caseId'?: (string);
  'name'?: (string);
  'policyId'?: (string);
  'expectedDecision'?: (_tasklattice_guard_control_v1_ValidationDecision);
  'actualDecision'?: (_tasklattice_guard_control_v1_ValidationDecision);
  /**
   * True when required business and expected-failure assertions matched.
   */
  'passed'?: (boolean);
  /**
   * Furthest evaluator stage reached, including NONE for routing short-circuits.
   */
  'stageReached'?: (_tasklattice_guard_control_v1_ValidationStage);
  /**
   * End-to-end case execution latency in milliseconds.
   */
  'latencyMs'?: (number);
  /**
   * Human-readable diagnostic detail; consumers must not parse it as a code.
   */
  'reason'?: (string);
  'phase'?: (_tasklattice_guard_control_v1_GuardrailPhase);
  'inputContent'?: (string);
  'action'?: (_tasklattice_guard_control_v1_EnforcementAction);
  'outputContent'?: (string);
  'findings'?: (_tasklattice_guard_control_v1_RiskFinding)[];
  'trace'?: (_tasklattice_guard_control_v1_RuntimeTraceStep)[];
  'trustedInstruction'?: (string);
  'targetSource'?: (_tasklattice_guard_control_v1_TargetSource);
  'query'?: (string);
  'groundingSources'?: (string)[];
  /**
   * Copied expected reasoning assertion; absence means it was not asserted.
   */
  'expectedReasoningResult'?: (_tasklattice_guard_control_v1_AutomatedReasoningResult);
  /**
   * Observed reasoning result; absent when automated reasoning did not run.
   */
  'actualReasoningResult'?: (_tasklattice_guard_control_v1_AutomatedReasoningResult);
  'caseType'?: (string);
  /**
   * Copied from the request so aggregate policy can distinguish diagnostic cases.
   */
  'required'?: (boolean);
  /**
   * Copied expected infrastructure failure; absence means none was expected.
   */
  'expectedFailure'?: (_tasklattice_guard_control_v1_ValidationFailure);
  /**
   * Observed infrastructure failure; absence means execution completed normally.
   */
  'actualFailure'?: (_tasklattice_guard_control_v1_ValidationFailure);
  /**
   * Copied scheduler group; absence means the case had no explicit grouping.
   */
  'concurrencyGroup'?: (string);
  /**
   * Original catalog policy identity for generated cases; absent for custom cases.
   */
  'sourcePolicyId'?: (string);
  /**
   * Original catalog policy version; present only together with source_policy_id.
   */
  'sourcePolicyVersion'?: (string);
  /**
   * Original catalog case ID; absent for custom cases.
   */
  'sourceCaseId'?: (string);
  'coveredRuleIds'?: (string)[];
  'matchedRuleIds'?: (string)[];
  '_expectedReasoningResult'?: "expectedReasoningResult";
  '_actualReasoningResult'?: "actualReasoningResult";
  '_expectedFailure'?: "expectedFailure";
  '_actualFailure'?: "actualFailure";
  '_concurrencyGroup'?: "concurrencyGroup";
  '_sourcePolicyId'?: "sourcePolicyId";
  '_sourcePolicyVersion'?: "sourcePolicyVersion";
  '_sourceCaseId'?: "sourceCaseId";
}

/**
 * Observed decision, evidence, and trace for one validation case.
 */
export interface ValidationCaseResult__Output {
  'caseId': (string);
  'name': (string);
  'policyId': (string);
  'expectedDecision': (_tasklattice_guard_control_v1_ValidationDecision__Output);
  'actualDecision': (_tasklattice_guard_control_v1_ValidationDecision__Output);
  /**
   * True when required business and expected-failure assertions matched.
   */
  'passed': (boolean);
  /**
   * Furthest evaluator stage reached, including NONE for routing short-circuits.
   */
  'stageReached': (_tasklattice_guard_control_v1_ValidationStage__Output);
  /**
   * End-to-end case execution latency in milliseconds.
   */
  'latencyMs': (number);
  /**
   * Human-readable diagnostic detail; consumers must not parse it as a code.
   */
  'reason': (string);
  'phase': (_tasklattice_guard_control_v1_GuardrailPhase__Output);
  'inputContent': (string);
  'action': (_tasklattice_guard_control_v1_EnforcementAction__Output);
  'outputContent': (string);
  'findings': (_tasklattice_guard_control_v1_RiskFinding__Output)[];
  'trace': (_tasklattice_guard_control_v1_RuntimeTraceStep__Output)[];
  'trustedInstruction': (string);
  'targetSource': (_tasklattice_guard_control_v1_TargetSource__Output);
  'query': (string);
  'groundingSources': (string)[];
  /**
   * Copied expected reasoning assertion; absence means it was not asserted.
   */
  'expectedReasoningResult'?: (_tasklattice_guard_control_v1_AutomatedReasoningResult__Output);
  /**
   * Observed reasoning result; absent when automated reasoning did not run.
   */
  'actualReasoningResult'?: (_tasklattice_guard_control_v1_AutomatedReasoningResult__Output);
  'caseType': (string);
  /**
   * Copied from the request so aggregate policy can distinguish diagnostic cases.
   */
  'required': (boolean);
  /**
   * Copied expected infrastructure failure; absence means none was expected.
   */
  'expectedFailure'?: (_tasklattice_guard_control_v1_ValidationFailure__Output);
  /**
   * Observed infrastructure failure; absence means execution completed normally.
   */
  'actualFailure'?: (_tasklattice_guard_control_v1_ValidationFailure__Output);
  /**
   * Copied scheduler group; absence means the case had no explicit grouping.
   */
  'concurrencyGroup'?: (string);
  /**
   * Original catalog policy identity for generated cases; absent for custom cases.
   */
  'sourcePolicyId'?: (string);
  /**
   * Original catalog policy version; present only together with source_policy_id.
   */
  'sourcePolicyVersion'?: (string);
  /**
   * Original catalog case ID; absent for custom cases.
   */
  'sourceCaseId'?: (string);
  'coveredRuleIds': (string)[];
  'matchedRuleIds': (string)[];
  '_expectedReasoningResult'?: "expectedReasoningResult";
  '_actualReasoningResult'?: "actualReasoningResult";
  '_expectedFailure'?: "expectedFailure";
  '_actualFailure'?: "actualFailure";
  '_concurrencyGroup'?: "concurrencyGroup";
  '_sourcePolicyId'?: "sourcePolicyId";
  '_sourcePolicyVersion'?: "sourcePolicyVersion";
  '_sourceCaseId'?: "sourceCaseId";
}
