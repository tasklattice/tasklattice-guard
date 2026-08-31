// Original file: common.proto

/**
 * Expected or observed content decision for one validation case.
 */
export const ValidationDecision = {
  VALIDATION_DECISION_UNSPECIFIED: 'VALIDATION_DECISION_UNSPECIFIED',
  VALIDATION_DECISION_ALLOW: 'VALIDATION_DECISION_ALLOW',
  VALIDATION_DECISION_BLOCK: 'VALIDATION_DECISION_BLOCK',
  VALIDATION_DECISION_TRANSFORM: 'VALIDATION_DECISION_TRANSFORM',
  VALIDATION_DECISION_INTERVENE: 'VALIDATION_DECISION_INTERVENE',
} as const;

/**
 * Expected or observed content decision for one validation case.
 */
export type ValidationDecision =
  | 'VALIDATION_DECISION_UNSPECIFIED'
  | 0
  | 'VALIDATION_DECISION_ALLOW'
  | 1
  | 'VALIDATION_DECISION_BLOCK'
  | 2
  | 'VALIDATION_DECISION_TRANSFORM'
  | 3
  | 'VALIDATION_DECISION_INTERVENE'
  | 4

/**
 * Expected or observed content decision for one validation case.
 */
export type ValidationDecision__Output = typeof ValidationDecision[keyof typeof ValidationDecision]
