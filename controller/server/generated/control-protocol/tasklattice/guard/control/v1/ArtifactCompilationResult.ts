// Original file: runner_control.proto

import type { Artifact as _tasklattice_guard_control_v1_Artifact, Artifact__Output as _tasklattice_guard_control_v1_Artifact__Output } from '../../../../tasklattice/guard/control/v1/Artifact.js';

/**
 * Offline compilation only. No model calls, runtime loading or test execution.
 */
export interface ArtifactCompilationResult {
  /**
   * Correlates this reply with the requesting Controller command.
   */
  'compileId'?: (string);
  /**
   * Must match the registered stream and its process boot.
   */
  'runnerId'?: (string);
  /**
   * Unsigned compiled content on success; absent on failure.
   */
  'artifact'?: (_tasklattice_guard_control_v1_Artifact | null);
  /**
   * Nonempty compilation failure; never a test verdict.
   */
  'error'?: (string);
}

/**
 * Offline compilation only. No model calls, runtime loading or test execution.
 */
export interface ArtifactCompilationResult__Output {
  /**
   * Correlates this reply with the requesting Controller command.
   */
  'compileId': (string);
  /**
   * Must match the registered stream and its process boot.
   */
  'runnerId': (string);
  /**
   * Unsigned compiled content on success; absent on failure.
   */
  'artifact': (_tasklattice_guard_control_v1_Artifact__Output | null);
  /**
   * Nonempty compilation failure; never a test verdict.
   */
  'error': (string);
}
