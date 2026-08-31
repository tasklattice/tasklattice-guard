// Original file: common.proto

/**
 * Decision taken when required evaluation infrastructure cannot produce a verdict.
 */
export const FailureMode = {
  FAILURE_MODE_UNSPECIFIED: 'FAILURE_MODE_UNSPECIFIED',
  FAILURE_MODE_FAIL_OPEN: 'FAILURE_MODE_FAIL_OPEN',
  FAILURE_MODE_FAIL_CLOSED: 'FAILURE_MODE_FAIL_CLOSED',
} as const;

/**
 * Decision taken when required evaluation infrastructure cannot produce a verdict.
 */
export type FailureMode =
  | 'FAILURE_MODE_UNSPECIFIED'
  | 0
  | 'FAILURE_MODE_FAIL_OPEN'
  | 1
  | 'FAILURE_MODE_FAIL_CLOSED'
  | 2

/**
 * Decision taken when required evaluation infrastructure cannot produce a verdict.
 */
export type FailureMode__Output = typeof FailureMode[keyof typeof FailureMode]
