// Original file: validation.proto


/**
 * Aggregate metrics computed across all cases in one executed validation run.
 */
export interface ValidationMetrics {
  /**
   * Number of executed cases included in the aggregate.
   */
  'total'?: (number);
  /**
   * Number of cases whose observed outcome matched their expectation.
   */
  'passed'?: (number);
  /**
   * passed / total in [0, 1], or zero when total is zero.
   */
  'complianceRate'?: (number | string);
  /**
   * Safe cases incorrectly blocked or transformed, normalized to [0, 1].
   */
  'falsePositiveRate'?: (number | string);
  /**
   * Unsafe cases incorrectly allowed, normalized to [0, 1].
   */
  'falseNegativeRate'?: (number | string);
  /**
   * Cases reaching the deep-judge stage divided by total, in [0, 1].
   */
  'deepEscalationRate'?: (number | string);
  /**
   * End-to-end case latency p95 in milliseconds.
   */
  'p95LatencyMs'?: (number);
}

/**
 * Aggregate metrics computed across all cases in one executed validation run.
 */
export interface ValidationMetrics__Output {
  /**
   * Number of executed cases included in the aggregate.
   */
  'total': (number);
  /**
   * Number of cases whose observed outcome matched their expectation.
   */
  'passed': (number);
  /**
   * passed / total in [0, 1], or zero when total is zero.
   */
  'complianceRate': (number);
  /**
   * Safe cases incorrectly blocked or transformed, normalized to [0, 1].
   */
  'falsePositiveRate': (number);
  /**
   * Unsafe cases incorrectly allowed, normalized to [0, 1].
   */
  'falseNegativeRate': (number);
  /**
   * Cases reaching the deep-judge stage divided by total, in [0, 1].
   */
  'deepEscalationRate': (number);
  /**
   * End-to-end case latency p95 in milliseconds.
   */
  'p95LatencyMs': (number);
}
