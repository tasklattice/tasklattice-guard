// Original file: common.proto

/**
 * Business outcome of an executed validation run.
 */
export const ValidationStatus = {
  VALIDATION_STATUS_UNSPECIFIED: 'VALIDATION_STATUS_UNSPECIFIED',
  VALIDATION_STATUS_PASSED: 'VALIDATION_STATUS_PASSED',
  VALIDATION_STATUS_FAILED: 'VALIDATION_STATUS_FAILED',
  VALIDATION_STATUS_CANCELLED: 'VALIDATION_STATUS_CANCELLED',
} as const;

/**
 * Business outcome of an executed validation run.
 */
export type ValidationStatus =
  | 'VALIDATION_STATUS_UNSPECIFIED'
  | 0
  | 'VALIDATION_STATUS_PASSED'
  | 1
  | 'VALIDATION_STATUS_FAILED'
  | 2
  | 'VALIDATION_STATUS_CANCELLED'
  | 3

/**
 * Business outcome of an executed validation run.
 */
export type ValidationStatus__Output = typeof ValidationStatus[keyof typeof ValidationStatus]
