// Original file: common.proto

/**
 * Version of content presented to a plan module after earlier transformations.
 */
export const ContentView = {
  CONTENT_VIEW_UNSPECIFIED: 'CONTENT_VIEW_UNSPECIFIED',
  CONTENT_VIEW_ORIGINAL: 'CONTENT_VIEW_ORIGINAL',
  CONTENT_VIEW_MASKED: 'CONTENT_VIEW_MASKED',
  CONTENT_VIEW_PREVIOUS_OUTPUT: 'CONTENT_VIEW_PREVIOUS_OUTPUT',
  CONTENT_VIEW_COMPLETE_OUTPUT: 'CONTENT_VIEW_COMPLETE_OUTPUT',
} as const;

/**
 * Version of content presented to a plan module after earlier transformations.
 */
export type ContentView =
  | 'CONTENT_VIEW_UNSPECIFIED'
  | 0
  | 'CONTENT_VIEW_ORIGINAL'
  | 1
  | 'CONTENT_VIEW_MASKED'
  | 2
  | 'CONTENT_VIEW_PREVIOUS_OUTPUT'
  | 3
  | 'CONTENT_VIEW_COMPLETE_OUTPUT'
  | 4

/**
 * Version of content presented to a plan module after earlier transformations.
 */
export type ContentView__Output = typeof ContentView[keyof typeof ContentView]
