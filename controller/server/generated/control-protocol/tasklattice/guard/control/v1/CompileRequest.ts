// Original file: artifact.proto

import type { GuardrailPlan as _tasklattice_guard_control_v1_GuardrailPlan, GuardrailPlan__Output as _tasklattice_guard_control_v1_GuardrailPlan__Output } from '../../../../tasklattice/guard/control/v1/GuardrailPlan.js';
import type { Long } from '@grpc/proto-loader';

/**
 * Command sent to a compiler-capable GuardRails 0 Runner.
 */
export interface CompileRequest {
  /**
   * Idempotency/correlation ID for exactly one requested compilation.
   */
  'compileId'?: (string);
  'guardrailId'?: (string);
  /**
   * Candidate immutable version that the result must preserve.
   */
  'guardrailVersion'?: (string);
  /**
   * Desired-state generation reserved by Controller for this candidate.
   */
  'generation'?: (number | string | Long);
  'plan'?: (_tasklattice_guard_control_v1_GuardrailPlan | null);
  /**
   * Extensible runtime registry identifier, not a model or Provider name.
   */
  'runtimeProfile'?: (string);
}

/**
 * Command sent to a compiler-capable GuardRails 0 Runner.
 */
export interface CompileRequest__Output {
  /**
   * Idempotency/correlation ID for exactly one requested compilation.
   */
  'compileId': (string);
  'guardrailId': (string);
  /**
   * Candidate immutable version that the result must preserve.
   */
  'guardrailVersion': (string);
  /**
   * Desired-state generation reserved by Controller for this candidate.
   */
  'generation': (string);
  'plan': (_tasklattice_guard_control_v1_GuardrailPlan__Output | null);
  /**
   * Extensible runtime registry identifier, not a model or Provider name.
   */
  'runtimeProfile': (string);
}
