// Original file: common.proto

/**
 * Whether the detector target condition matched, independently of enforcement.
 * UNKNOWN is a valid inconclusive check; ERROR is a detector execution failure.
 */
export const EvaluatorVerdict = {
  EVALUATOR_VERDICT_UNSPECIFIED: 'EVALUATOR_VERDICT_UNSPECIFIED',
  EVALUATOR_VERDICT_NOT_MATCHED: 'EVALUATOR_VERDICT_NOT_MATCHED',
  EVALUATOR_VERDICT_MATCHED: 'EVALUATOR_VERDICT_MATCHED',
  EVALUATOR_VERDICT_UNKNOWN: 'EVALUATOR_VERDICT_UNKNOWN',
  EVALUATOR_VERDICT_ERROR: 'EVALUATOR_VERDICT_ERROR',
} as const;

/**
 * Whether the detector target condition matched, independently of enforcement.
 * UNKNOWN is a valid inconclusive check; ERROR is a detector execution failure.
 */
export type EvaluatorVerdict =
  | 'EVALUATOR_VERDICT_UNSPECIFIED'
  | 0
  | 'EVALUATOR_VERDICT_NOT_MATCHED'
  | 1
  | 'EVALUATOR_VERDICT_MATCHED'
  | 2
  | 'EVALUATOR_VERDICT_UNKNOWN'
  | 3
  | 'EVALUATOR_VERDICT_ERROR'
  | 4

/**
 * Whether the detector target condition matched, independently of enforcement.
 * UNKNOWN is a valid inconclusive check; ERROR is a detector execution failure.
 */
export type EvaluatorVerdict__Output = typeof EvaluatorVerdict[keyof typeof EvaluatorVerdict]
