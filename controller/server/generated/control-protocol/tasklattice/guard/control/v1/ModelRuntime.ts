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
   * Concurrent active model RPCs per Runner process. Zero from older controllers means 2.
   */
  'maxConcurrency'?: (number);
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
   * Concurrent active model RPCs per Runner process. Zero from older controllers means 2.
   */
  'maxConcurrency': (number);
}
