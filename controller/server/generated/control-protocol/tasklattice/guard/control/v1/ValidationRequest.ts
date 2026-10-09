// Original file: validation.proto

import type { GuardrailPlan as _tasklattice_guard_control_v1_GuardrailPlan, GuardrailPlan__Output as _tasklattice_guard_control_v1_GuardrailPlan__Output } from '../../../../tasklattice/guard/control/v1/GuardrailPlan.js';
import type { ValidationTestCase as _tasklattice_guard_control_v1_ValidationTestCase, ValidationTestCase__Output as _tasklattice_guard_control_v1_ValidationTestCase__Output } from '../../../../tasklattice/guard/control/v1/ValidationTestCase.js';
import type { Artifact as _tasklattice_guard_control_v1_Artifact, Artifact__Output as _tasklattice_guard_control_v1_Artifact__Output } from '../../../../tasklattice/guard/control/v1/Artifact.js';

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
  'candidateVersion'?: (string);
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
  /**
   * A released version to test as it is: when set, the Runner verifies this
   * signed Artifact and runs the cases against it without compiling; `plan`
   * is not used. Absent for a draft, which is compiled into a candidate.
   */
  'artifact'?: (_tasklattice_guard_control_v1_Artifact | null);
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
  'candidateVersion': (string);
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
  /**
   * A released version to test as it is: when set, the Runner verifies this
   * signed Artifact and runs the cases against it without compiling; `plan`
   * is not used. Absent for a draft, which is compiled into a candidate.
   */
  'artifact': (_tasklattice_guard_control_v1_Artifact__Output | null);
}
