// Original file: routing.proto


/**
 * A fixed immutable Guardrail version within a Route distribution.
 */
export interface WeightedTarget {
  'targetId'?: (string);
  'guardrailId'?: (string);
  /**
   * Fixed immutable Guardrail version; latest and empty are invalid.
   */
  'guardrailVersion'?: (string);
  'artifactId'?: (string);
  /**
   * Integer basis points in [0,10000]; each Route must total exactly 10000.
   */
  'weightBps'?: (number);
}

/**
 * A fixed immutable Guardrail version within a Route distribution.
 */
export interface WeightedTarget__Output {
  'targetId': (string);
  'guardrailId': (string);
  /**
   * Fixed immutable Guardrail version; latest and empty are invalid.
   */
  'guardrailVersion': (string);
  'artifactId': (string);
  /**
   * Integer basis points in [0,10000]; each Route must total exactly 10000.
   */
  'weightBps': (number);
}
