// Original file: artifact.proto

import type { Artifact as _tasklattice_guard_control_v1_Artifact, Artifact__Output as _tasklattice_guard_control_v1_Artifact__Output } from '../../../../tasklattice/guard/control/v1/Artifact.js';

/**
 * Compiler response. Accepted results must contain an artifact; rejected
 * results must contain a reason and must not be activated by Controller.
 */
export interface CompileResult {
  /**
   * Runner that executed the compile command.
   */
  'runnerId'?: (string);
  /**
   * Must exactly match the originating CompileRequest.compile_id.
   */
  'compileId'?: (string);
  /**
   * True only when compilation produced the complete candidate artifact below.
   */
  'accepted'?: (boolean);
  /**
   * Human-readable rejection detail; empty on successful compilation.
   */
  'reason'?: (string);
  /**
   * Required when accepted is true and absent when accepted is false.
   */
  'artifact'?: (_tasklattice_guard_control_v1_Artifact | null);
  '_artifact'?: "artifact";
}

/**
 * Compiler response. Accepted results must contain an artifact; rejected
 * results must contain a reason and must not be activated by Controller.
 */
export interface CompileResult__Output {
  /**
   * Runner that executed the compile command.
   */
  'runnerId': (string);
  /**
   * Must exactly match the originating CompileRequest.compile_id.
   */
  'compileId': (string);
  /**
   * True only when compilation produced the complete candidate artifact below.
   */
  'accepted': (boolean);
  /**
   * Human-readable rejection detail; empty on successful compilation.
   */
  'reason': (string);
  /**
   * Required when accepted is true and absent when accepted is false.
   */
  'artifact'?: (_tasklattice_guard_control_v1_Artifact__Output | null);
  '_artifact'?: "artifact";
}
