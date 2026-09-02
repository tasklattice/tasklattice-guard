// Original file: runner_control.proto

import type { RunnerRegistration as _tasklattice_guard_control_v1_RunnerRegistration, RunnerRegistration__Output as _tasklattice_guard_control_v1_RunnerRegistration__Output } from '../../../../tasklattice/guard/control/v1/RunnerRegistration.js';
import type { RunnerHeartbeat as _tasklattice_guard_control_v1_RunnerHeartbeat, RunnerHeartbeat__Output as _tasklattice_guard_control_v1_RunnerHeartbeat__Output } from '../../../../tasklattice/guard/control/v1/RunnerHeartbeat.js';
import type { ArtifactResult as _tasklattice_guard_control_v1_ArtifactResult, ArtifactResult__Output as _tasklattice_guard_control_v1_ArtifactResult__Output } from '../../../../tasklattice/guard/control/v1/ArtifactResult.js';
import type { CompileResult as _tasklattice_guard_control_v1_CompileResult, CompileResult__Output as _tasklattice_guard_control_v1_CompileResult__Output } from '../../../../tasklattice/guard/control/v1/CompileResult.js';
import type { ValidationResult as _tasklattice_guard_control_v1_ValidationResult, ValidationResult__Output as _tasklattice_guard_control_v1_ValidationResult__Output } from '../../../../tasklattice/guard/control/v1/ValidationResult.js';
import type { DesiredStateResult as _tasklattice_guard_control_v1_DesiredStateResult, DesiredStateResult__Output as _tasklattice_guard_control_v1_DesiredStateResult__Output } from '../../../../tasklattice/guard/control/v1/DesiredStateResult.js';
import type { Long } from '@grpc/proto-loader';

/**
 * Runner-to-Controller stream envelope. Registration must be the first body;
 * every later body belongs to the registered runner and boot identity.
 */
export interface RunnerMessage {
  /**
   * Sender-generated correlation/deduplication identifier for this envelope.
   */
  'messageId'?: (string);
  /**
   * UTC Unix epoch time in milliseconds when the envelope was created.
   */
  'sentAtUnixMs'?: (number | string | Long);
  'registration'?: (_tasklattice_guard_control_v1_RunnerRegistration | null);
  'heartbeat'?: (_tasklattice_guard_control_v1_RunnerHeartbeat | null);
  'artifactResult'?: (_tasklattice_guard_control_v1_ArtifactResult | null);
  'compileResult'?: (_tasklattice_guard_control_v1_CompileResult | null);
  'validationResult'?: (_tasklattice_guard_control_v1_ValidationResult | null);
  'desiredStateResult'?: (_tasklattice_guard_control_v1_DesiredStateResult | null);
  'body'?: "registration"|"heartbeat"|"artifactResult"|"compileResult"|"validationResult"|"desiredStateResult";
}

/**
 * Runner-to-Controller stream envelope. Registration must be the first body;
 * every later body belongs to the registered runner and boot identity.
 */
export interface RunnerMessage__Output {
  /**
   * Sender-generated correlation/deduplication identifier for this envelope.
   */
  'messageId': (string);
  /**
   * UTC Unix epoch time in milliseconds when the envelope was created.
   */
  'sentAtUnixMs': (string);
  'registration'?: (_tasklattice_guard_control_v1_RunnerRegistration__Output | null);
  'heartbeat'?: (_tasklattice_guard_control_v1_RunnerHeartbeat__Output | null);
  'artifactResult'?: (_tasklattice_guard_control_v1_ArtifactResult__Output | null);
  'compileResult'?: (_tasklattice_guard_control_v1_CompileResult__Output | null);
  'validationResult'?: (_tasklattice_guard_control_v1_ValidationResult__Output | null);
  'desiredStateResult'?: (_tasklattice_guard_control_v1_DesiredStateResult__Output | null);
  'body'?: "registration"|"heartbeat"|"artifactResult"|"compileResult"|"validationResult"|"desiredStateResult";
}
