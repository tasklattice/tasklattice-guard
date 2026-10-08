// Original file: runner_control.proto

import type { RegistrationAccepted as _tasklattice_guard_control_v1_RegistrationAccepted, RegistrationAccepted__Output as _tasklattice_guard_control_v1_RegistrationAccepted__Output } from '../../../../tasklattice/guard/control/v1/RegistrationAccepted.js';
import type { DesiredState as _tasklattice_guard_control_v1_DesiredState, DesiredState__Output as _tasklattice_guard_control_v1_DesiredState__Output } from '../../../../tasklattice/guard/control/v1/DesiredState.js';
import type { DrainRequest as _tasklattice_guard_control_v1_DrainRequest, DrainRequest__Output as _tasklattice_guard_control_v1_DrainRequest__Output } from '../../../../tasklattice/guard/control/v1/DrainRequest.js';
import type { ValidationRequest as _tasklattice_guard_control_v1_ValidationRequest, ValidationRequest__Output as _tasklattice_guard_control_v1_ValidationRequest__Output } from '../../../../tasklattice/guard/control/v1/ValidationRequest.js';
import type { CapabilityValidationRequest as _tasklattice_guard_control_v1_CapabilityValidationRequest, CapabilityValidationRequest__Output as _tasklattice_guard_control_v1_CapabilityValidationRequest__Output } from '../../../../tasklattice/guard/control/v1/CapabilityValidationRequest.js';
import type { ArtifactAdmissionRequest as _tasklattice_guard_control_v1_ArtifactAdmissionRequest, ArtifactAdmissionRequest__Output as _tasklattice_guard_control_v1_ArtifactAdmissionRequest__Output } from '../../../../tasklattice/guard/control/v1/ArtifactAdmissionRequest.js';
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
  'body'?: "registrationAccepted"|"desiredState"|"drainRequest"|"validationRequest"|"capabilityValidationRequest"|"artifactAdmissionRequest";
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
  'body'?: "registrationAccepted"|"desiredState"|"drainRequest"|"validationRequest"|"capabilityValidationRequest"|"artifactAdmissionRequest";
}
