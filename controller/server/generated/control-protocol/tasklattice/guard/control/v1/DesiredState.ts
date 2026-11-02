// Original file: runner_control.proto

import type { Artifact as _tasklattice_guard_control_v1_Artifact, Artifact__Output as _tasklattice_guard_control_v1_Artifact__Output } from '../../../../tasklattice/guard/control/v1/Artifact.js';
import type { EndpointRuntime as _tasklattice_guard_control_v1_EndpointRuntime, EndpointRuntime__Output as _tasklattice_guard_control_v1_EndpointRuntime__Output } from '../../../../tasklattice/guard/control/v1/EndpointRuntime.js';
import type { DataPlaneModelConfiguration as _tasklattice_guard_control_v1_DataPlaneModelConfiguration, DataPlaneModelConfiguration__Output as _tasklattice_guard_control_v1_DataPlaneModelConfiguration__Output } from '../../../../tasklattice/guard/control/v1/DataPlaneModelConfiguration.js';
import type { RouterRevision as _tasklattice_guard_control_v1_RouterRevision, RouterRevision__Output as _tasklattice_guard_control_v1_RouterRevision__Output } from '../../../../tasklattice/guard/control/v1/RouterRevision.js';
import type { Long } from '@grpc/proto-loader';

/**
 * Complete generation snapshot a Runner verifies, prewarms, and activates atomically.
 */
export interface DesiredState {
  /**
   * Authoritative snapshot generation; activation is atomic across all fields.
   */
  'generation'?: (number | string | Long);
  /**
   * Complete artifact set required by this pool at generation.
   */
  'artifacts'?: (_tasklattice_guard_control_v1_Artifact)[];
  'disabledGuardrailIds'?: (string)[];
  'disabledEndpointIds'?: (string)[];
  'endpoints'?: (_tasklattice_guard_control_v1_EndpointRuntime)[];
  'guardrailLoggingLevels'?: ({[key: string]: string});
  'modelConfiguration'?: (_tasklattice_guard_control_v1_DataPlaneModelConfiguration | null);
  'routerRevisions'?: (_tasklattice_guard_control_v1_RouterRevision)[];
  /**
   * Optional per-dispatch challenge, understood only by capable Runners.
   * An ACK is evidence of this snapshot on this stream, not a serving lease.
   */
  'snapshotNonce'?: (string);
  /**
   * Epoch persisted with this exact dispatch. Required by experimental lease
   * consumers; never inferred from a Runner's cached state or defaulted to 0.
   */
  'allocationEpoch'?: (number | string | Long);
  /**
   * Controller-assigned group of this exact dispatched pool snapshot.
   */
  'allocationGroupId'?: (string);
  '_snapshotNonce'?: "snapshotNonce";
  '_allocationEpoch'?: "allocationEpoch";
  '_allocationGroupId'?: "allocationGroupId";
}

/**
 * Complete generation snapshot a Runner verifies, prewarms, and activates atomically.
 */
export interface DesiredState__Output {
  /**
   * Authoritative snapshot generation; activation is atomic across all fields.
   */
  'generation': (string);
  /**
   * Complete artifact set required by this pool at generation.
   */
  'artifacts': (_tasklattice_guard_control_v1_Artifact__Output)[];
  'disabledGuardrailIds': (string)[];
  'disabledEndpointIds': (string)[];
  'endpoints': (_tasklattice_guard_control_v1_EndpointRuntime__Output)[];
  'guardrailLoggingLevels': ({[key: string]: string});
  'modelConfiguration': (_tasklattice_guard_control_v1_DataPlaneModelConfiguration__Output | null);
  'routerRevisions': (_tasklattice_guard_control_v1_RouterRevision__Output)[];
  /**
   * Optional per-dispatch challenge, understood only by capable Runners.
   * An ACK is evidence of this snapshot on this stream, not a serving lease.
   */
  'snapshotNonce'?: (string);
  /**
   * Epoch persisted with this exact dispatch. Required by experimental lease
   * consumers; never inferred from a Runner's cached state or defaulted to 0.
   */
  'allocationEpoch'?: (string);
  /**
   * Controller-assigned group of this exact dispatched pool snapshot.
   */
  'allocationGroupId'?: (string);
  '_snapshotNonce'?: "snapshotNonce";
  '_allocationEpoch'?: "allocationEpoch";
  '_allocationGroupId'?: "allocationGroupId";
}
