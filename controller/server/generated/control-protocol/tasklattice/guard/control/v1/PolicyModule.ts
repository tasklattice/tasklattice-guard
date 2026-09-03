// Original file: common.proto

/**
 * Product-level policy domain used to group plan modules.
 */
export const PolicyModule = {
  POLICY_MODULE_UNSPECIFIED: 'POLICY_MODULE_UNSPECIFIED',
  POLICY_MODULE_DATA_PROTECTION: 'POLICY_MODULE_DATA_PROTECTION',
  POLICY_MODULE_INTERACTION_SAFETY: 'POLICY_MODULE_INTERACTION_SAFETY',
  POLICY_MODULE_BUSINESS_ASSURANCE: 'POLICY_MODULE_BUSINESS_ASSURANCE',
} as const;

/**
 * Product-level policy domain used to group plan modules.
 */
export type PolicyModule =
  | 'POLICY_MODULE_UNSPECIFIED'
  | 0
  | 'POLICY_MODULE_DATA_PROTECTION'
  | 1
  | 'POLICY_MODULE_INTERACTION_SAFETY'
  | 2
  | 'POLICY_MODULE_BUSINESS_ASSURANCE'
  | 3

/**
 * Product-level policy domain used to group plan modules.
 */
export type PolicyModule__Output = typeof PolicyModule[keyof typeof PolicyModule]
