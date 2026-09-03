// Original file: validation.proto

import type { GuardrailPlan as _tasklattice_guard_control_v1_GuardrailPlan, GuardrailPlan__Output as _tasklattice_guard_control_v1_GuardrailPlan__Output } from '../../../../tasklattice/guard/control/v1/GuardrailPlan.js';
import type { ValidationTestCase as _tasklattice_guard_control_v1_ValidationTestCase, ValidationTestCase__Output as _tasklattice_guard_control_v1_ValidationTestCase__Output } from '../../../../tasklattice/guard/control/v1/ValidationTestCase.js';

/**
 * Command to execute an immutable candidate plan against its test cases.
 */
export interface ValidationRequest {
  /**
   * Idempotency/correlation ID for exactly one validation run.
   */
  'runId'?: (string);
  'guardrailId'?: (string);
  /**
   * Candidate Guardrail version evaluated without publishing or activation.
   */
  'candidateVersion'?: (number);
  /**
   * Draft revision whose plan and test cases are frozen in this request.
   */
  'sourceDraftRevision'?: (number);
  'plan'?: (_tasklattice_guard_control_v1_GuardrailPlan | null);
  /**
   * Extensible runtime registry identifier used to compile/execute the candidate.
   */
  'runtimeProfile'?: (string);
  'testCases'?: (_tasklattice_guard_control_v1_ValidationTestCase)[];
}

/**
 * Command to execute an immutable candidate plan against its test cases.
 */
export interface ValidationRequest__Output {
  /**
   * Idempotency/correlation ID for exactly one validation run.
   */
  'runId': (string);
  'guardrailId': (string);
  /**
   * Candidate Guardrail version evaluated without publishing or activation.
   */
  'candidateVersion': (number);
  /**
   * Draft revision whose plan and test cases are frozen in this request.
   */
  'sourceDraftRevision': (number);
  'plan': (_tasklattice_guard_control_v1_GuardrailPlan__Output | null);
  /**
   * Extensible runtime registry identifier used to compile/execute the candidate.
   */
  'runtimeProfile': (string);
  'testCases': (_tasklattice_guard_control_v1_ValidationTestCase__Output)[];
}
