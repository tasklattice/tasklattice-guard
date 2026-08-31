// Original file: runtime.proto


/**
 * Version-pinned reasoning policy and its decision threshold.
 */
export interface AutomatedReasoningPolicy {
  'id'?: (string);
  'policyId'?: (string);
  'policyVersion'?: (string);
  /**
   * Minimum normalized confidence in [0, 1] required to apply the result.
   */
  'confidenceThreshold'?: (number | string);
}

/**
 * Version-pinned reasoning policy and its decision threshold.
 */
export interface AutomatedReasoningPolicy__Output {
  'id': (string);
  'policyId': (string);
  'policyVersion': (string);
  /**
   * Minimum normalized confidence in [0, 1] required to apply the result.
   */
  'confidenceThreshold': (number);
}
