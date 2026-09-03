// Original file: artifact.proto


/**
 * Prompt template embedded in an immutable compiled artifact.
 */
export interface PromptDefinition {
  /**
   * NeMo prompt task identifier.
   */
  'task'?: (string);
  'content'?: (string);
  /**
   * Registered output parser name; absence uses the task default.
   */
  'outputParser'?: (string);
  /**
   * Generation limit; absence delegates to the configured model/provider default.
   */
  'maxTokens'?: (number);
  '_outputParser'?: "outputParser";
  '_maxTokens'?: "maxTokens";
}

/**
 * Prompt template embedded in an immutable compiled artifact.
 */
export interface PromptDefinition__Output {
  /**
   * NeMo prompt task identifier.
   */
  'task': (string);
  'content': (string);
  /**
   * Registered output parser name; absence uses the task default.
   */
  'outputParser'?: (string);
  /**
   * Generation limit; absence delegates to the configured model/provider default.
   */
  'maxTokens'?: (number);
  '_outputParser'?: "outputParser";
  '_maxTokens'?: "maxTokens";
}
