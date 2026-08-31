// Original file: common.proto

/**
 * Infrastructure failure expected or observed during one validation case.
 */
export const ValidationFailure = {
  VALIDATION_FAILURE_UNSPECIFIED: 'VALIDATION_FAILURE_UNSPECIFIED',
  VALIDATION_FAILURE_TIMEOUT: 'VALIDATION_FAILURE_TIMEOUT',
  VALIDATION_FAILURE_PROVIDER_FAILURE: 'VALIDATION_FAILURE_PROVIDER_FAILURE',
} as const;

/**
 * Infrastructure failure expected or observed during one validation case.
 */
export type ValidationFailure =
  | 'VALIDATION_FAILURE_UNSPECIFIED'
  | 0
  | 'VALIDATION_FAILURE_TIMEOUT'
  | 1
  | 'VALIDATION_FAILURE_PROVIDER_FAILURE'
  | 2

/**
 * Infrastructure failure expected or observed during one validation case.
 */
export type ValidationFailure__Output = typeof ValidationFailure[keyof typeof ValidationFailure]
