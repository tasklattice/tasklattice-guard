// Original file: integration.proto


/**
 * Non-secret credential verifier projected from Controller to Runner.
 */
export interface IntegrationCredential {
  /**
   * Stable credential identifier safe to expose in telemetry and audit events.
   */
  'id'?: (string);
  /**
   * Lowercase SHA-256 hex digest of the plaintext credential; plaintext is never sent.
   */
  'sha256'?: (string);
  /**
   * Non-secret suffix/prefix hint suitable for operator display.
   */
  'keyHint'?: (string);
  /**
   * RFC 3339 UTC timestamp at which Controller issued the credential.
   */
  'createdAt'?: (string);
  /**
   * RFC 3339 UTC revocation timestamp; absence means the credential is active.
   */
  'revokedAt'?: (string);
  '_revokedAt'?: "revokedAt";
}

/**
 * Non-secret credential verifier projected from Controller to Runner.
 */
export interface IntegrationCredential__Output {
  /**
   * Stable credential identifier safe to expose in telemetry and audit events.
   */
  'id': (string);
  /**
   * Lowercase SHA-256 hex digest of the plaintext credential; plaintext is never sent.
   */
  'sha256': (string);
  /**
   * Non-secret suffix/prefix hint suitable for operator display.
   */
  'keyHint': (string);
  /**
   * RFC 3339 UTC timestamp at which Controller issued the credential.
   */
  'createdAt': (string);
  /**
   * RFC 3339 UTC revocation timestamp; absence means the credential is active.
   */
  'revokedAt'?: (string);
  '_revokedAt'?: "revokedAt";
}
