// Original file: common.proto

/**
 * Product safety preset used when compiling a Guardrail Plan.
 */
export const SafetyLevel = {
  SAFETY_LEVEL_UNSPECIFIED: 'SAFETY_LEVEL_UNSPECIFIED',
  SAFETY_LEVEL_BALANCED: 'SAFETY_LEVEL_BALANCED',
  SAFETY_LEVEL_STRICT: 'SAFETY_LEVEL_STRICT',
} as const;

/**
 * Product safety preset used when compiling a Guardrail Plan.
 */
export type SafetyLevel =
  | 'SAFETY_LEVEL_UNSPECIFIED'
  | 0
  | 'SAFETY_LEVEL_BALANCED'
  | 1
  | 'SAFETY_LEVEL_STRICT'
  | 2

/**
 * Product safety preset used when compiling a Guardrail Plan.
 */
export type SafetyLevel__Output = typeof SafetyLevel[keyof typeof SafetyLevel]
