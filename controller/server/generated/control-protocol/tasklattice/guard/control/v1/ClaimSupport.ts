// Original file: common.proto

/**
 * Normalized evidence support for one generated claim.
 */
export const ClaimSupport = {
  CLAIM_SUPPORT_UNSPECIFIED: 'CLAIM_SUPPORT_UNSPECIFIED',
  CLAIM_SUPPORT_SUPPORTED: 'CLAIM_SUPPORT_SUPPORTED',
  CLAIM_SUPPORT_UNSUPPORTED: 'CLAIM_SUPPORT_UNSUPPORTED',
  CLAIM_SUPPORT_UNCERTAIN: 'CLAIM_SUPPORT_UNCERTAIN',
} as const;

/**
 * Normalized evidence support for one generated claim.
 */
export type ClaimSupport =
  | 'CLAIM_SUPPORT_UNSPECIFIED'
  | 0
  | 'CLAIM_SUPPORT_SUPPORTED'
  | 1
  | 'CLAIM_SUPPORT_UNSUPPORTED'
  | 2
  | 'CLAIM_SUPPORT_UNCERTAIN'
  | 3

/**
 * Normalized evidence support for one generated claim.
 */
export type ClaimSupport__Output = typeof ClaimSupport[keyof typeof ClaimSupport]
