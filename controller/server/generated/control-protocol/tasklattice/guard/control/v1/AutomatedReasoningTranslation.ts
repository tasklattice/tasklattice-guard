// Original file: evaluation.proto


/**
 * Structured translation from natural-language policy and claims.
 */
export interface AutomatedReasoningTranslation {
  'premises'?: (string)[];
  'claims'?: (string)[];
  'untranslated'?: (string)[];
}

/**
 * Structured translation from natural-language policy and claims.
 */
export interface AutomatedReasoningTranslation__Output {
  'premises': (string)[];
  'claims': (string)[];
  'untranslated': (string)[];
}
