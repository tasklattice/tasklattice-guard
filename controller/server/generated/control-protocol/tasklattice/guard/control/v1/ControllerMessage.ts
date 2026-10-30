// Original file: runner_control.proto

import type { RegistrationAccepted as _tasklattice_guard_control_v1_RegistrationAccepted, RegistrationAccepted__Output as _tasklattice_guard_control_v1_RegistrationAccepted__Output } from '../../../../tasklattice/guard/control/v1/RegistrationAccepted.js';
import type { DesiredState as _tasklattice_guard_control_v1_DesiredState, DesiredState__Output as _tasklattice_guard_control_v1_DesiredState__Output } from '../../../../tasklattice/guard/control/v1/DesiredState.js';
import type { DrainRequest as _tasklattice_guard_control_v1_DrainRequest, DrainRequest__Output as _tasklattice_guard_control_v1_DrainRequest__Output } from '../../../../tasklattice/guard/control/v1/DrainRequest.js';
import type { ValidationRequest as _tasklattice_guard_control_v1_ValidationRequest, ValidationRequest__Output as _tasklattice_guard_control_v1_ValidationRequest__Output } from '../../../../tasklattice/guard/control/v1/ValidationRequest.js';
import type { CapabilityValidationRequest as _tasklattice_guard_control_v1_CapabilityValidationRequest, CapabilityValidationRequest__Output as _tasklattice_guard_control_v1_CapabilityValidationRequest__Output } from '../../../../tasklattice/guard/control/v1/CapabilityValidationRequest.js';
import type { ArtifactAdmissionRequest as _tasklattice_guard_control_v1_ArtifactAdmissionRequest, ArtifactAdmissionRequest__Output as _tasklattice_guard_control_v1_ArtifactAdmissionRequest__Output } from '../../../../tasklattice/guard/control/v1/ArtifactAdmissionRequest.js';
import type { GuardrailProtectionState as _tasklattice_guard_control_v1_GuardrailProtectionState, GuardrailProtectionState__Output as _tasklattice_guard_control_v1_GuardrailProtectionState__Output } from '../../../../tasklattice/guard/control/v1/GuardrailProtectionState.js';
import type { CompileRequest as _tasklattice_guard_control_v1_CompileRequest, CompileRequest__Output as _tasklattice_guard_control_v1_CompileRequest__Output } from '../../../../tasklattice/guard/control/v1/CompileRequest.js';
import type { ValidationCancelRequest as _tasklattice_guard_control_v1_ValidationCancelRequest, ValidationCancelRequest__Output as _tasklattice_guard_control_v1_ValidationCancelRequest__Output } from '../../../../tasklattice/guard/control/v1/ValidationCancelRequest.js';
import type { ValidationReportAck as _tasklattice_guard_control_v1_ValidationReportAck, ValidationReportAck__Output as _tasklattice_guard_control_v1_ValidationReportAck__Output } from '../../../../tasklattice/guard/control/v1/ValidationReportAck.js';
import type { ValidationReportChunkAck as _tasklattice_guard_control_v1_ValidationReportChunkAck, ValidationReportChunkAck__Output as _tasklattice_guard_control_v1_ValidationReportChunkAck__Output } from '../../../../tasklattice/guard/control/v1/ValidationReportChunkAck.js';
import type { Long } from '@grpc/proto-loader';

/**
 * Controller-to-Runner stream envelope containing commands and desired state.
 */
export interface ControllerMessage {
  /**
   * Sender-generated correlation/deduplication identifier for this envelope.
   */
  'messageId'?: (string);
  /**
   * UTC Unix epoch time in milliseconds when the envelope was created.
   */
  'sentAtUnixMs'?: (number | string | Long);
  'registrationAccepted'?: (_tasklattice_guard_control_v1_RegistrationAccepted | null);
  'desiredState'?: (_tasklattice_guard_control_v1_DesiredState | null);
  'drainRequest'?: (_tasklattice_guard_control_v1_DrainRequest | null);
  'validationRequest'?: (_tasklattice_guard_control_v1_ValidationRequest | null);
  'capabilityValidationRequest'?: (_tasklattice_guard_control_v1_CapabilityValidationRequest | null);
  'artifactAdmissionRequest'?: (_tasklattice_guard_control_v1_ArtifactAdmissionRequest | null);
  'protectionState'?: (_tasklattice_guard_control_v1_GuardrailProtectionState | null);
  'artifactCompilationRequest'?: (_tasklattice_guard_control_v1_CompileRequest | null);
  'validationCancelRequest'?: (_tasklattice_guard_control_v1_ValidationCancelRequest | null);
  'validationReportAck'?: (_tasklattice_guard_control_v1_ValidationReportAck | null);
  'validationReportChunkAck'?: (_tasklattice_guard_control_v1_ValidationReportChunkAck | null);
  'body'?: "registrationAccepted"|"desiredState"|"drainRequest"|"validationRequest"|"capabilityValidationRequest"|"artifactAdmissionRequest"|"protectionState"|"artifactCompilationRequest"|"validationCancelRequest"|"validationReportAck"|"validationReportChunkAck";
}

/**
 * Controller-to-Runner stream envelope containing commands and desired state.
 */
export interface ControllerMessage__Output {
  /**
   * Sender-generated correlation/deduplication identifier for this envelope.
   */
  'messageId': (string);
  /**
   * UTC Unix epoch time in milliseconds when the envelope was created.
   */
  'sentAtUnixMs': (string);
  'registrationAccepted'?: (_tasklattice_guard_control_v1_RegistrationAccepted__Output | null);
  'desiredState'?: (_tasklattice_guard_control_v1_DesiredState__Output | null);
  'drainRequest'?: (_tasklattice_guard_control_v1_DrainRequest__Output | null);
  'validationRequest'?: (_tasklattice_guard_control_v1_ValidationRequest__Output | null);
  'capabilityValidationRequest'?: (_tasklattice_guard_control_v1_CapabilityValidationRequest__Output | null);
  'artifactAdmissionRequest'?: (_tasklattice_guard_control_v1_ArtifactAdmissionRequest__Output | null);
  'protectionState'?: (_tasklattice_guard_control_v1_GuardrailProtectionState__Output | null);
  'artifactCompilationRequest'?: (_tasklattice_guard_control_v1_CompileRequest__Output | null);
  'validationCancelRequest'?: (_tasklattice_guard_control_v1_ValidationCancelRequest__Output | null);
  'validationReportAck'?: (_tasklattice_guard_control_v1_ValidationReportAck__Output | null);
  'validationReportChunkAck'?: (_tasklattice_guard_control_v1_ValidationReportChunkAck__Output | null);
  'body'?: "registrationAccepted"|"desiredState"|"drainRequest"|"validationRequest"|"capabilityValidationRequest"|"artifactAdmissionRequest"|"protectionState"|"artifactCompilationRequest"|"validationCancelRequest"|"validationReportAck"|"validationReportChunkAck";
}
