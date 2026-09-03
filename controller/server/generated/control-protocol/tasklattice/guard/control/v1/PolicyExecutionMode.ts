// Original file: common.proto

/**
 * Whether a policy only detects findings or may also mutate content.
 */
export const PolicyExecutionMode = {
  POLICY_EXECUTION_MODE_UNSPECIFIED: 'POLICY_EXECUTION_MODE_UNSPECIFIED',
  POLICY_EXECUTION_MODE_DETECT: 'POLICY_EXECUTION_MODE_DETECT',
  POLICY_EXECUTION_MODE_MUTATE: 'POLICY_EXECUTION_MODE_MUTATE',
} as const;

/**
 * Whether a policy only detects findings or may also mutate content.
 */
export type PolicyExecutionMode =
  | 'POLICY_EXECUTION_MODE_UNSPECIFIED'
  | 0
  | 'POLICY_EXECUTION_MODE_DETECT'
  | 1
  | 'POLICY_EXECUTION_MODE_MUTATE'
  | 2

/**
 * Whether a policy only detects findings or may also mutate content.
 */
export type PolicyExecutionMode__Output = typeof PolicyExecutionMode[keyof typeof PolicyExecutionMode]
