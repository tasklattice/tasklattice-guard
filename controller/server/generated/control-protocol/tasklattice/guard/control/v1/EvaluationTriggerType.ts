// Original file: common.proto

/**
 * Condition that makes one evaluation step eligible to run.
 */
export const EvaluationTriggerType = {
  EVALUATION_TRIGGER_TYPE_UNSPECIFIED: 'EVALUATION_TRIGGER_TYPE_UNSPECIFIED',
  EVALUATION_TRIGGER_TYPE_ALWAYS: 'EVALUATION_TRIGGER_TYPE_ALWAYS',
  EVALUATION_TRIGGER_TYPE_ON_RESULT: 'EVALUATION_TRIGGER_TYPE_ON_RESULT',
} as const;

/**
 * Condition that makes one evaluation step eligible to run.
 */
export type EvaluationTriggerType =
  | 'EVALUATION_TRIGGER_TYPE_UNSPECIFIED'
  | 0
  | 'EVALUATION_TRIGGER_TYPE_ALWAYS'
  | 1
  | 'EVALUATION_TRIGGER_TYPE_ON_RESULT'
  | 2

/**
 * Condition that makes one evaluation step eligible to run.
 */
export type EvaluationTriggerType__Output = typeof EvaluationTriggerType[keyof typeof EvaluationTriggerType]
