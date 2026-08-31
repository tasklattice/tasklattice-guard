// Original file: validation.proto

/**
 * How far a validation case actually progressed. NONE is a valid observed
 * outcome, unlike an unspecified Guardrail Plan evaluation stage.
 */
export const ValidationStage = {
  VALIDATION_STAGE_NONE: 'VALIDATION_STAGE_NONE',
  VALIDATION_STAGE_DETERMINISTIC: 'VALIDATION_STAGE_DETERMINISTIC',
  VALIDATION_STAGE_FAST_SEMANTIC: 'VALIDATION_STAGE_FAST_SEMANTIC',
  VALIDATION_STAGE_DEEP_JUDGE: 'VALIDATION_STAGE_DEEP_JUDGE',
} as const;

/**
 * How far a validation case actually progressed. NONE is a valid observed
 * outcome, unlike an unspecified Guardrail Plan evaluation stage.
 */
export type ValidationStage =
  | 'VALIDATION_STAGE_NONE'
  | 0
  | 'VALIDATION_STAGE_DETERMINISTIC'
  | 1
  | 'VALIDATION_STAGE_FAST_SEMANTIC'
  | 2
  | 'VALIDATION_STAGE_DEEP_JUDGE'
  | 3

/**
 * How far a validation case actually progressed. NONE is a valid observed
 * outcome, unlike an unspecified Guardrail Plan evaluation stage.
 */
export type ValidationStage__Output = typeof ValidationStage[keyof typeof ValidationStage]
