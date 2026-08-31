// Original file: common.proto

/**
 * Normalized evaluator result before conflict resolution and enforcement.
 */
export const EvaluatorVerdict = {
  EVALUATOR_VERDICT_UNSPECIFIED: 'EVALUATOR_VERDICT_UNSPECIFIED',
  EVALUATOR_VERDICT_SAFE: 'EVALUATOR_VERDICT_SAFE',
  EVALUATOR_VERDICT_UNSAFE: 'EVALUATOR_VERDICT_UNSAFE',
  EVALUATOR_VERDICT_UNCERTAIN: 'EVALUATOR_VERDICT_UNCERTAIN',
  EVALUATOR_VERDICT_ERROR: 'EVALUATOR_VERDICT_ERROR',
} as const;

/**
 * Normalized evaluator result before conflict resolution and enforcement.
 */
export type EvaluatorVerdict =
  | 'EVALUATOR_VERDICT_UNSPECIFIED'
  | 0
  | 'EVALUATOR_VERDICT_SAFE'
  | 1
  | 'EVALUATOR_VERDICT_UNSAFE'
  | 2
  | 'EVALUATOR_VERDICT_UNCERTAIN'
  | 3
  | 'EVALUATOR_VERDICT_ERROR'
  | 4

/**
 * Normalized evaluator result before conflict resolution and enforcement.
 */
export type EvaluatorVerdict__Output = typeof EvaluatorVerdict[keyof typeof EvaluatorVerdict]
