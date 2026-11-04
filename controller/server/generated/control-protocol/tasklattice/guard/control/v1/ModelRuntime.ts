// Original file: model.proto


/**
 * One physical model endpoint. Credentials are resolved through the
 * authenticated Controller credential lease and are never persisted in the
 * desired-state snapshot.
 */
export interface ModelRuntime {
  'id'?: (string);
  'providerId'?: (string);
  'providerName'?: (string);
  'baseUrl'?: (string);
  'credentialRef'?: (string);
  'model'?: (string);
  'profileRef'?: (string);
  'timeoutSeconds'?: (number);
  'maxTokens'?: (number);
  /**
   * Explicit Provider-scoped opt-in. False retains HTTPS certificate checks.
   */
  'skipTlsVerify'?: (boolean);
  /**
   * Concurrent active model RPCs per Runner process; unset uses 2.
   */
  'maxConcurrency'?: (number);
  /**
   * Total attempts on explicit rate-limit rejection, including the initial call.
   */
  'rateLimitAttempts'?: (number);
  /**
   * Inclusive negative decision boundary; unset uses 0.1. Zero is valid.
   * Must be nonnegative and less than upper_threshold.
   */
  'lowerThreshold'?: (number | string);
  /**
   * Inclusive positive decision boundary; unset uses 0.9.
   * Must exceed lower_threshold and be at most 1.
   */
  'upperThreshold'?: (number | string);
  '_lowerThreshold'?: "lowerThreshold";
  '_upperThreshold'?: "upperThreshold";
}

/**
 * One physical model endpoint. Credentials are resolved through the
 * authenticated Controller credential lease and are never persisted in the
 * desired-state snapshot.
 */
export interface ModelRuntime__Output {
  'id': (string);
  'providerId': (string);
  'providerName': (string);
  'baseUrl': (string);
  'credentialRef': (string);
  'model': (string);
  'profileRef': (string);
  'timeoutSeconds': (number);
  'maxTokens': (number);
  /**
   * Explicit Provider-scoped opt-in. False retains HTTPS certificate checks.
   */
  'skipTlsVerify': (boolean);
  /**
   * Concurrent active model RPCs per Runner process; unset uses 2.
   */
  'maxConcurrency': (number);
  /**
   * Total attempts on explicit rate-limit rejection, including the initial call.
   */
  'rateLimitAttempts': (number);
  /**
   * Inclusive negative decision boundary; unset uses 0.1. Zero is valid.
   * Must be nonnegative and less than upper_threshold.
   */
  'lowerThreshold'?: (number);
  /**
   * Inclusive positive decision boundary; unset uses 0.9.
   * Must exceed lower_threshold and be at most 1.
   */
  'upperThreshold'?: (number);
  '_lowerThreshold'?: "lowerThreshold";
  '_upperThreshold'?: "upperThreshold";
}
