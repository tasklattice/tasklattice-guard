// Original file: common.proto

/**
 * Semantic origin of content supplied to a validation case.
 */
export const TargetSource = {
  TARGET_SOURCE_UNSPECIFIED: 'TARGET_SOURCE_UNSPECIFIED',
  TARGET_SOURCE_USER_INPUT: 'TARGET_SOURCE_USER_INPUT',
  TARGET_SOURCE_RETRIEVED_CONTENT: 'TARGET_SOURCE_RETRIEVED_CONTENT',
  TARGET_SOURCE_TOOL_OUTPUT: 'TARGET_SOURCE_TOOL_OUTPUT',
  TARGET_SOURCE_MODEL_OUTPUT: 'TARGET_SOURCE_MODEL_OUTPUT',
} as const;

/**
 * Semantic origin of content supplied to a validation case.
 */
export type TargetSource =
  | 'TARGET_SOURCE_UNSPECIFIED'
  | 0
  | 'TARGET_SOURCE_USER_INPUT'
  | 1
  | 'TARGET_SOURCE_RETRIEVED_CONTENT'
  | 2
  | 'TARGET_SOURCE_TOOL_OUTPUT'
  | 3
  | 'TARGET_SOURCE_MODEL_OUTPUT'
  | 4

/**
 * Semantic origin of content supplied to a validation case.
 */
export type TargetSource__Output = typeof TargetSource[keyof typeof TargetSource]
