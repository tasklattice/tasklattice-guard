// Original file: runner_control.proto


/**
 * Outcome of an ArtifactAdmissionRequest on one Runner.
 */
export interface ArtifactAdmissionResult {
  'runnerId'?: (string);
  /**
   * Must exactly match the originating ArtifactAdmissionRequest.request_id.
   */
  'requestId'?: (string);
  /**
   * True only when verification and a full runtime build succeeded.
   */
  'admitted'?: (boolean);
  /**
   * Human-readable rejection detail; empty when admitted.
   */
  'reason'?: (string);
  /**
   * NeMo Guardrails version the check ran against.
   */
  'nemoVersion'?: (string);
  /**
   * Applied model configuration revision; empty when none was configured.
   */
  'modelRevisionId'?: (string);
}

/**
 * Outcome of an ArtifactAdmissionRequest on one Runner.
 */
export interface ArtifactAdmissionResult__Output {
  'runnerId': (string);
  /**
   * Must exactly match the originating ArtifactAdmissionRequest.request_id.
   */
  'requestId': (string);
  /**
   * True only when verification and a full runtime build succeeded.
   */
  'admitted': (boolean);
  /**
   * Human-readable rejection detail; empty when admitted.
   */
  'reason': (string);
  /**
   * NeMo Guardrails version the check ran against.
   */
  'nemoVersion': (string);
  /**
   * Applied model configuration revision; empty when none was configured.
   */
  'modelRevisionId': (string);
}
