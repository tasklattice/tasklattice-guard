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
   * Decision-model operating band; unset uses 0.1 and 0.9. Zero is valid.
   */
  'lowerThreshold'?: (number | string);
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
   * Decision-model operating band; unset uses 0.1 and 0.9. Zero is valid.
   */
  'lowerThreshold'?: (number);
  'upperThreshold'?: (number);
  '_lowerThreshold'?: "lowerThreshold";
  '_upperThreshold'?: "upperThreshold";
}
