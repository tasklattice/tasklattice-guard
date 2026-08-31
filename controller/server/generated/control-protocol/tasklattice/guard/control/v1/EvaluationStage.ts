// Original file: common.proto

/**
 * Cost/latency tier of an evaluator; implementations may vary within a tier.
 */
export const EvaluationStage = {
  EVALUATION_STAGE_UNSPECIFIED: 'EVALUATION_STAGE_UNSPECIFIED',
  EVALUATION_STAGE_DETERMINISTIC: 'EVALUATION_STAGE_DETERMINISTIC',
  EVALUATION_STAGE_FAST_SEMANTIC: 'EVALUATION_STAGE_FAST_SEMANTIC',
  EVALUATION_STAGE_DEEP_JUDGE: 'EVALUATION_STAGE_DEEP_JUDGE',
} as const;

/**
 * Cost/latency tier of an evaluator; implementations may vary within a tier.
 */
export type EvaluationStage =
  | 'EVALUATION_STAGE_UNSPECIFIED'
  | 0
  | 'EVALUATION_STAGE_DETERMINISTIC'
  | 1
  | 'EVALUATION_STAGE_FAST_SEMANTIC'
  | 2
  | 'EVALUATION_STAGE_DEEP_JUDGE'
  | 3

/**
 * Cost/latency tier of an evaluator; implementations may vary within a tier.
 */
export type EvaluationStage__Output = typeof EvaluationStage[keyof typeof EvaluationStage]
