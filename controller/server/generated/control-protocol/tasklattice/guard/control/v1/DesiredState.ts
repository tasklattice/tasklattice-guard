// Original file: runner_control.proto

import type { Artifact as _tasklattice_guard_control_v1_Artifact, Artifact__Output as _tasklattice_guard_control_v1_Artifact__Output } from '../../../../tasklattice/guard/control/v1/Artifact.js';
import type { RouterRoute as _tasklattice_guard_control_v1_RouterRoute, RouterRoute__Output as _tasklattice_guard_control_v1_RouterRoute__Output } from '../../../../tasklattice/guard/control/v1/RouterRoute.js';
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
  'routers'?: (_tasklattice_guard_control_v1_RouterRoute)[];
  'endpoints'?: (_tasklattice_guard_control_v1_EndpointRuntime)[];
  'guardrailLoggingLevels'?: ({[key: string]: string});
  'modelConfiguration'?: (_tasklattice_guard_control_v1_DataPlaneModelConfiguration | null);
  'routerRevisions'?: (_tasklattice_guard_control_v1_RouterRevision)[];
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
  'routers': (_tasklattice_guard_control_v1_RouterRoute__Output)[];
  'endpoints': (_tasklattice_guard_control_v1_EndpointRuntime__Output)[];
  'guardrailLoggingLevels': ({[key: string]: string});
  'modelConfiguration': (_tasklattice_guard_control_v1_DataPlaneModelConfiguration__Output | null);
  'routerRevisions': (_tasklattice_guard_control_v1_RouterRevision__Output)[];
}
