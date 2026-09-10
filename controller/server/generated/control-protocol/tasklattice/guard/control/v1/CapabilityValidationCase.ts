// Original file: model.proto


/**
 * Synthetic test metadata only; no customer prompts or credentials are returned.
 */
export interface CapabilityValidationCase {
  'id'?: (string);
  'expectedDecision'?: (string);
  'actualDecision'?: (string);
  'passed'?: (boolean);
  /**
   * Synthetic sample evaluated by the selected Rail.
   */
  'inputContent'?: (string);
  /**
   * JSON-encoded Runner decision, action, texts, reason, and findings.
   */
  'outputContent'?: (string);
  /**
   * Human-readable Runner diagnostic; empty when no reason was returned.
   * Display only: consumers must not parse this text as a decision code.
   */
  'reason'?: (string);
}

/**
 * Synthetic test metadata only; no customer prompts or credentials are returned.
 */
export interface CapabilityValidationCase__Output {
  'id': (string);
  'expectedDecision': (string);
  'actualDecision': (string);
  'passed': (boolean);
  /**
   * Synthetic sample evaluated by the selected Rail.
   */
  'inputContent': (string);
  /**
   * JSON-encoded Runner decision, action, texts, reason, and findings.
   */
  'outputContent': (string);
  /**
   * Human-readable Runner diagnostic; empty when no reason was returned.
   * Display only: consumers must not parse this text as a decision code.
   */
  'reason': (string);
}
