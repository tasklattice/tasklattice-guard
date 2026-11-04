// Original file: runner_control.proto

import type { Long } from '@grpc/proto-loader';

/**
 * Cumulative process-local admission outcomes; no counter grants authority.
 */
export interface ProjectAdmissionOutcomes {
  /**
   * Accepted admission starts; absence is invalid rather than zero.
   */
  'admitted'?: (number | string | Long);
  /**
   * Rejected because the bounded local queue was full; absence is invalid.
   */
  'queueFull'?: (number | string | Long);
  /**
   * Rejected after the bounded local wait expired; absence is invalid.
   */
  'queueTimeout'?: (number | string | Long);
  /**
   * Rejected by a start-rate budget; absence is invalid.
   */
  'rateLimited'?: (number | string | Long);
  /**
   * Cancelled before admission completed; absence is invalid.
   */
  'cancelled'?: (number | string | Long);
  /**
   * Rejected because admission authority was unavailable; absence is invalid.
   */
  'unavailable'?: (number | string | Long);
  '_admitted'?: "admitted";
  '_queueFull'?: "queueFull";
  '_queueTimeout'?: "queueTimeout";
  '_rateLimited'?: "rateLimited";
  '_cancelled'?: "cancelled";
  '_unavailable'?: "unavailable";
}

/**
 * Cumulative process-local admission outcomes; no counter grants authority.
 */
export interface ProjectAdmissionOutcomes__Output {
  /**
   * Accepted admission starts; absence is invalid rather than zero.
   */
  'admitted'?: (string);
  /**
   * Rejected because the bounded local queue was full; absence is invalid.
   */
  'queueFull'?: (string);
  /**
   * Rejected after the bounded local wait expired; absence is invalid.
   */
  'queueTimeout'?: (string);
  /**
   * Rejected by a start-rate budget; absence is invalid.
   */
  'rateLimited'?: (string);
  /**
   * Cancelled before admission completed; absence is invalid.
   */
  'cancelled'?: (string);
  /**
   * Rejected because admission authority was unavailable; absence is invalid.
   */
  'unavailable'?: (string);
  '_admitted'?: "admitted";
  '_queueFull'?: "queueFull";
  '_queueTimeout'?: "queueTimeout";
  '_rateLimited'?: "rateLimited";
  '_cancelled'?: "cancelled";
  '_unavailable'?: "unavailable";
}
