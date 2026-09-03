// Original file: common.proto

/**
 * NeMo rail surface to which a programmable policy binding applies.
 */
export const RailType = {
  RAIL_TYPE_UNSPECIFIED: 'RAIL_TYPE_UNSPECIFIED',
  RAIL_TYPE_INPUT: 'RAIL_TYPE_INPUT',
  RAIL_TYPE_OUTPUT: 'RAIL_TYPE_OUTPUT',
  RAIL_TYPE_RETRIEVAL: 'RAIL_TYPE_RETRIEVAL',
  RAIL_TYPE_DIALOG: 'RAIL_TYPE_DIALOG',
  RAIL_TYPE_EXECUTION: 'RAIL_TYPE_EXECUTION',
} as const;

/**
 * NeMo rail surface to which a programmable policy binding applies.
 */
export type RailType =
  | 'RAIL_TYPE_UNSPECIFIED'
  | 0
  | 'RAIL_TYPE_INPUT'
  | 1
  | 'RAIL_TYPE_OUTPUT'
  | 2
  | 'RAIL_TYPE_RETRIEVAL'
  | 3
  | 'RAIL_TYPE_DIALOG'
  | 4
  | 'RAIL_TYPE_EXECUTION'
  | 5

/**
 * NeMo rail surface to which a programmable policy binding applies.
 */
export type RailType__Output = typeof RailType[keyof typeof RailType]
