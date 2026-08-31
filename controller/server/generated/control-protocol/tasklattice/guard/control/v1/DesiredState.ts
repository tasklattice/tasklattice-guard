// Original file: runner_control.proto

import type { Artifact as _tasklattice_guard_control_v1_Artifact, Artifact__Output as _tasklattice_guard_control_v1_Artifact__Output } from '../../../../tasklattice/guard/control/v1/Artifact.js';
import type { DeploymentRoute as _tasklattice_guard_control_v1_DeploymentRoute, DeploymentRoute__Output as _tasklattice_guard_control_v1_DeploymentRoute__Output } from '../../../../tasklattice/guard/control/v1/DeploymentRoute.js';
import type { IntegrationRuntime as _tasklattice_guard_control_v1_IntegrationRuntime, IntegrationRuntime__Output as _tasklattice_guard_control_v1_IntegrationRuntime__Output } from '../../../../tasklattice/guard/control/v1/IntegrationRuntime.js';
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
  'disabledIntegrationIds'?: (string)[];
  'deployments'?: (_tasklattice_guard_control_v1_DeploymentRoute)[];
  'integrations'?: (_tasklattice_guard_control_v1_IntegrationRuntime)[];
  'guardrailLoggingLevels'?: ({[key: string]: string});
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
  'disabledIntegrationIds': (string)[];
  'deployments': (_tasklattice_guard_control_v1_DeploymentRoute__Output)[];
  'integrations': (_tasklattice_guard_control_v1_IntegrationRuntime__Output)[];
  'guardrailLoggingLevels': ({[key: string]: string});
}
