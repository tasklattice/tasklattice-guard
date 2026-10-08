// Original file: validation.proto


/**
 * Runtime fingerprint recorded with validation evidence.
 */
export interface ValidationRuntime {
  'runnerId'?: (string);
  'runnerVersion'?: (string);
  /**
   * NeMo Guardrails version that compiled and executed the candidate.
   */
  'nemoVersion'?: (string);
  /**
   * Applied model configuration revision; empty when none was configured.
   */
  'modelRevisionId'?: (string);
  /**
   * Native model types the compiler bound into the candidate configuration.
   */
  'compilerModelTypes'?: (string)[];
}

/**
 * Runtime fingerprint recorded with validation evidence.
 */
export interface ValidationRuntime__Output {
  'runnerId': (string);
  'runnerVersion': (string);
  /**
   * NeMo Guardrails version that compiled and executed the candidate.
   */
  'nemoVersion': (string);
  /**
   * Applied model configuration revision; empty when none was configured.
   */
  'modelRevisionId': (string);
  /**
   * Native model types the compiler bound into the candidate configuration.
   */
  'compilerModelTypes': (string)[];
}
