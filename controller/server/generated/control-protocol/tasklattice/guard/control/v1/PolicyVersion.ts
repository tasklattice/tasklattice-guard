// Original file: runtime.proto

import type { PolicySource as _tasklattice_guard_control_v1_PolicySource, PolicySource__Output as _tasklattice_guard_control_v1_PolicySource__Output } from '../../../../tasklattice/guard/control/v1/PolicySource.js';
import type { StringPair as _tasklattice_guard_control_v1_StringPair, StringPair__Output as _tasklattice_guard_control_v1_StringPair__Output } from '../../../../tasklattice/guard/control/v1/StringPair.js';
import type { PolicyRailBinding as _tasklattice_guard_control_v1_PolicyRailBinding, PolicyRailBinding__Output as _tasklattice_guard_control_v1_PolicyRailBinding__Output } from '../../../../tasklattice/guard/control/v1/PolicyRailBinding.js';
import type { PolicyActionReference as _tasklattice_guard_control_v1_PolicyActionReference, PolicyActionReference__Output as _tasklattice_guard_control_v1_PolicyActionReference__Output } from '../../../../tasklattice/guard/control/v1/PolicyActionReference.js';

/**
 * Immutable programmable-policy snapshot embedded in a Guardrail Plan.
 */
export interface PolicyVersion {
  'policyId'?: (string);
  'version'?: (string);
  'name'?: (string);
  'source'?: (string);
  'colangVersion'?: (string);
  'sources'?: (_tasklattice_guard_control_v1_PolicySource)[];
  'parameterSchema'?: (_tasklattice_guard_control_v1_StringPair)[];
  'railBindings'?: (_tasklattice_guard_control_v1_PolicyRailBinding)[];
  'actionReferences'?: (_tasklattice_guard_control_v1_PolicyActionReference)[];
  'evaluationContracts'?: (string)[];
  'promptDependencies'?: (string)[];
  'executionContract'?: (_tasklattice_guard_control_v1_StringPair)[];
  'testCases'?: (_tasklattice_guard_control_v1_StringPair)[];
  /**
   * Lowercase SHA-256 hex digest of the canonical immutable policy snapshot.
   */
  'checksum'?: (string);
}

/**
 * Immutable programmable-policy snapshot embedded in a Guardrail Plan.
 */
export interface PolicyVersion__Output {
  'policyId': (string);
  'version': (string);
  'name': (string);
  'source': (string);
  'colangVersion': (string);
  'sources': (_tasklattice_guard_control_v1_PolicySource__Output)[];
  'parameterSchema': (_tasklattice_guard_control_v1_StringPair__Output)[];
  'railBindings': (_tasklattice_guard_control_v1_PolicyRailBinding__Output)[];
  'actionReferences': (_tasklattice_guard_control_v1_PolicyActionReference__Output)[];
  'evaluationContracts': (string)[];
  'promptDependencies': (string)[];
  'executionContract': (_tasklattice_guard_control_v1_StringPair__Output)[];
  'testCases': (_tasklattice_guard_control_v1_StringPair__Output)[];
  /**
   * Lowercase SHA-256 hex digest of the canonical immutable policy snapshot.
   */
  'checksum': (string);
}
