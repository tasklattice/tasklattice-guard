// Original file: artifact.proto

import type { GuardrailPlan as _tasklattice_guard_control_v1_GuardrailPlan, GuardrailPlan__Output as _tasklattice_guard_control_v1_GuardrailPlan__Output } from '../../../../tasklattice/guard/control/v1/GuardrailPlan.js';
import type { Long } from '@grpc/proto-loader';

/**
 * Input to the offline Artifact compiler (validation candidates, fixtures and
 * tooling). It is not a control-channel command.
 */
export interface CompileRequest {
  /**
   * Correlation ID for exactly one requested compilation.
   */
  'compileId'?: (string);
  'guardrailId'?: (string);
  /**
   * Candidate immutable version that the result must preserve.
   */
  'guardrailVersion'?: (string);
  /**
   * Delivery generation copied into the Artifact envelope; zero for candidates.
   */
  'generation'?: (number | string | Long);
  'plan'?: (_tasklattice_guard_control_v1_GuardrailPlan | null);
  /**
   * Extensible runtime registry identifier, not a model or Provider name.
   */
  'runtimeProfile'?: (string);
}

/**
 * Input to the offline Artifact compiler (validation candidates, fixtures and
 * tooling). It is not a control-channel command.
 */
export interface CompileRequest__Output {
  /**
   * Correlation ID for exactly one requested compilation.
   */
  'compileId': (string);
  'guardrailId': (string);
  /**
   * Candidate immutable version that the result must preserve.
   */
  'guardrailVersion': (string);
  /**
   * Delivery generation copied into the Artifact envelope; zero for candidates.
   */
  'generation': (string);
  'plan': (_tasklattice_guard_control_v1_GuardrailPlan__Output | null);
  /**
   * Extensible runtime registry identifier, not a model or Provider name.
   */
  'runtimeProfile': (string);
}
