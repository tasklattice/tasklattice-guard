// Original file: runner_control.proto

import type { Long } from '@grpc/proto-loader';

/**
 * Cumulative fixed-bucket histogram; its final bucket must equal count.
 */
export interface TenantAdmissionHistogram {
  /**
   * Ordered cumulative counts for the fourteen documented finite bounds and infinity.
   */
  'buckets'?: (number | string | Long)[];
  /**
   * Nonnegative cumulative observations; absence is invalid rather than zero.
   */
  'count'?: (number | string | Long);
  /**
   * Nonnegative finite cumulative elapsed seconds; absence is invalid.
   */
  'totalSeconds'?: (number | string);
  '_count'?: "count";
  '_totalSeconds'?: "totalSeconds";
}

/**
 * Cumulative fixed-bucket histogram; its final bucket must equal count.
 */
export interface TenantAdmissionHistogram__Output {
  /**
   * Ordered cumulative counts for the fourteen documented finite bounds and infinity.
   */
  'buckets': (string)[];
  /**
   * Nonnegative cumulative observations; absence is invalid rather than zero.
   */
  'count'?: (string);
  /**
   * Nonnegative finite cumulative elapsed seconds; absence is invalid.
   */
  'totalSeconds'?: (number);
  '_count'?: "count";
  '_totalSeconds'?: "totalSeconds";
}
