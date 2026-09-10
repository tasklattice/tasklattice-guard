// Original file: model.proto


/**
 * Synthetic test metadata only; no customer prompts or credentials are returned.
 */
export interface CapabilityValidationCase {
  'id'?: (string);
  'expectedDecision'?: (string);
  'actualDecision'?: (string);
  'passed'?: (boolean);
  'inputContent'?: (string);
  'outputContent'?: (string);
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
  'inputContent': (string);
  'outputContent': (string);
  'reason': (string);
}
