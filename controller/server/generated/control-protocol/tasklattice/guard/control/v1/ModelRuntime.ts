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
}
