// Original file: common.proto

/**
 * Scoring dimension produced by a grounding evaluator.
 */
export const GroundingFilterType = {
  GROUNDING_FILTER_TYPE_UNSPECIFIED: 'GROUNDING_FILTER_TYPE_UNSPECIFIED',
  GROUNDING_FILTER_TYPE_GROUNDING: 'GROUNDING_FILTER_TYPE_GROUNDING',
  GROUNDING_FILTER_TYPE_RELEVANCE: 'GROUNDING_FILTER_TYPE_RELEVANCE',
} as const;

/**
 * Scoring dimension produced by a grounding evaluator.
 */
export type GroundingFilterType =
  | 'GROUNDING_FILTER_TYPE_UNSPECIFIED'
  | 0
  | 'GROUNDING_FILTER_TYPE_GROUNDING'
  | 1
  | 'GROUNDING_FILTER_TYPE_RELEVANCE'
  | 2

/**
 * Scoring dimension produced by a grounding evaluator.
 */
export type GroundingFilterType__Output = typeof GroundingFilterType[keyof typeof GroundingFilterType]
