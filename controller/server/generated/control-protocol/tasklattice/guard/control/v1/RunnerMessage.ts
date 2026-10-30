// Original file: runner_control.proto

import type { RunnerRegistration as _tasklattice_guard_control_v1_RunnerRegistration, RunnerRegistration__Output as _tasklattice_guard_control_v1_RunnerRegistration__Output } from '../../../../tasklattice/guard/control/v1/RunnerRegistration.js';
import type { RunnerHeartbeat as _tasklattice_guard_control_v1_RunnerHeartbeat, RunnerHeartbeat__Output as _tasklattice_guard_control_v1_RunnerHeartbeat__Output } from '../../../../tasklattice/guard/control/v1/RunnerHeartbeat.js';
import type { ArtifactResult as _tasklattice_guard_control_v1_ArtifactResult, ArtifactResult__Output as _tasklattice_guard_control_v1_ArtifactResult__Output } from '../../../../tasklattice/guard/control/v1/ArtifactResult.js';
import type { DesiredStateResult as _tasklattice_guard_control_v1_DesiredStateResult, DesiredStateResult__Output as _tasklattice_guard_control_v1_DesiredStateResult__Output } from '../../../../tasklattice/guard/control/v1/DesiredStateResult.js';
import type { CapabilityValidationResult as _tasklattice_guard_control_v1_CapabilityValidationResult, CapabilityValidationResult__Output as _tasklattice_guard_control_v1_CapabilityValidationResult__Output } from '../../../../tasklattice/guard/control/v1/CapabilityValidationResult.js';
import type { ValidationProgress as _tasklattice_guard_control_v1_ValidationProgress, ValidationProgress__Output as _tasklattice_guard_control_v1_ValidationProgress__Output } from '../../../../tasklattice/guard/control/v1/ValidationProgress.js';
import type { ArtifactAdmissionResult as _tasklattice_guard_control_v1_ArtifactAdmissionResult, ArtifactAdmissionResult__Output as _tasklattice_guard_control_v1_ArtifactAdmissionResult__Output } from '../../../../tasklattice/guard/control/v1/ArtifactAdmissionResult.js';
import type { GuardrailProtectionResult as _tasklattice_guard_control_v1_GuardrailProtectionResult, GuardrailProtectionResult__Output as _tasklattice_guard_control_v1_GuardrailProtectionResult__Output } from '../../../../tasklattice/guard/control/v1/GuardrailProtectionResult.js';
import type { ArtifactCompilationResult as _tasklattice_guard_control_v1_ArtifactCompilationResult, ArtifactCompilationResult__Output as _tasklattice_guard_control_v1_ArtifactCompilationResult__Output } from '../../../../tasklattice/guard/control/v1/ArtifactCompilationResult.js';
import type { ValidationReportChunk as _tasklattice_guard_control_v1_ValidationReportChunk, ValidationReportChunk__Output as _tasklattice_guard_control_v1_ValidationReportChunk__Output } from '../../../../tasklattice/guard/control/v1/ValidationReportChunk.js';
import type { ValidationStatusNotice as _tasklattice_guard_control_v1_ValidationStatusNotice, ValidationStatusNotice__Output as _tasklattice_guard_control_v1_ValidationStatusNotice__Output } from '../../../../tasklattice/guard/control/v1/ValidationStatusNotice.js';
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
  'desiredStateResult'?: (_tasklattice_guard_control_v1_DesiredStateResult | null);
  'capabilityValidationResult'?: (_tasklattice_guard_control_v1_CapabilityValidationResult | null);
  'validationProgress'?: (_tasklattice_guard_control_v1_ValidationProgress | null);
  'artifactAdmissionResult'?: (_tasklattice_guard_control_v1_ArtifactAdmissionResult | null);
  'protectionResult'?: (_tasklattice_guard_control_v1_GuardrailProtectionResult | null);
  'artifactCompilationResult'?: (_tasklattice_guard_control_v1_ArtifactCompilationResult | null);
  'validationReportChunk'?: (_tasklattice_guard_control_v1_ValidationReportChunk | null);
  'validationStatusNotice'?: (_tasklattice_guard_control_v1_ValidationStatusNotice | null);
  'body'?: "registration"|"heartbeat"|"artifactResult"|"desiredStateResult"|"capabilityValidationResult"|"validationProgress"|"artifactAdmissionResult"|"protectionResult"|"artifactCompilationResult"|"validationReportChunk"|"validationStatusNotice";
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
  'desiredStateResult'?: (_tasklattice_guard_control_v1_DesiredStateResult__Output | null);
  'capabilityValidationResult'?: (_tasklattice_guard_control_v1_CapabilityValidationResult__Output | null);
  'validationProgress'?: (_tasklattice_guard_control_v1_ValidationProgress__Output | null);
  'artifactAdmissionResult'?: (_tasklattice_guard_control_v1_ArtifactAdmissionResult__Output | null);
  'protectionResult'?: (_tasklattice_guard_control_v1_GuardrailProtectionResult__Output | null);
  'artifactCompilationResult'?: (_tasklattice_guard_control_v1_ArtifactCompilationResult__Output | null);
  'validationReportChunk'?: (_tasklattice_guard_control_v1_ValidationReportChunk__Output | null);
  'validationStatusNotice'?: (_tasklattice_guard_control_v1_ValidationStatusNotice__Output | null);
  'body'?: "registration"|"heartbeat"|"artifactResult"|"desiredStateResult"|"capabilityValidationResult"|"validationProgress"|"artifactAdmissionResult"|"protectionResult"|"artifactCompilationResult"|"validationReportChunk"|"validationStatusNotice";
}
