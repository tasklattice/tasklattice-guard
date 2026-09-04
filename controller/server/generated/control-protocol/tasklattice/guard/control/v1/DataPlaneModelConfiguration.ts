// Original file: model.proto

import type { ModelRuntime as _tasklattice_guard_control_v1_ModelRuntime, ModelRuntime__Output as _tasklattice_guard_control_v1_ModelRuntime__Output } from '../../../../tasklattice/guard/control/v1/ModelRuntime.js';
import type { ModelAssignment as _tasklattice_guard_control_v1_ModelAssignment, ModelAssignment__Output as _tasklattice_guard_control_v1_ModelAssignment__Output } from '../../../../tasklattice/guard/control/v1/ModelAssignment.js';

/**
 * Complete data-plane projection of one validated Model configuration
 * revision. Only model-backed detectors needed by Runner are included.
 */
export interface DataPlaneModelConfiguration {
  'revisionId'?: (string);
  'revision'?: (number);
  'runtimes'?: (_tasklattice_guard_control_v1_ModelRuntime)[];
  'assignments'?: (_tasklattice_guard_control_v1_ModelAssignment)[];
}

/**
 * Complete data-plane projection of one validated Model configuration
 * revision. Only model-backed detectors needed by Runner are included.
 */
export interface DataPlaneModelConfiguration__Output {
  'revisionId': (string);
  'revision': (number);
  'runtimes': (_tasklattice_guard_control_v1_ModelRuntime__Output)[];
  'assignments': (_tasklattice_guard_control_v1_ModelAssignment__Output)[];
}
