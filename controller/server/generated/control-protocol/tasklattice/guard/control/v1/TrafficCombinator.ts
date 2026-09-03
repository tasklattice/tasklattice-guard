// Original file: routing.proto

/**
 * Boolean operator applied to all members of one traffic-scope group.
 */
export const TrafficCombinator = {
  TRAFFIC_COMBINATOR_UNSPECIFIED: 'TRAFFIC_COMBINATOR_UNSPECIFIED',
  TRAFFIC_COMBINATOR_AND: 'TRAFFIC_COMBINATOR_AND',
  TRAFFIC_COMBINATOR_OR: 'TRAFFIC_COMBINATOR_OR',
} as const;

/**
 * Boolean operator applied to all members of one traffic-scope group.
 */
export type TrafficCombinator =
  | 'TRAFFIC_COMBINATOR_UNSPECIFIED'
  | 0
  | 'TRAFFIC_COMBINATOR_AND'
  | 1
  | 'TRAFFIC_COMBINATOR_OR'
  | 2

/**
 * Boolean operator applied to all members of one traffic-scope group.
 */
export type TrafficCombinator__Output = typeof TrafficCombinator[keyof typeof TrafficCombinator]
