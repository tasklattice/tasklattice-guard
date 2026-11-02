// Original file: runner_control.proto

import type { Long } from '@grpc/proto-loader';

/**
 * Authenticates HTTP delivery from this registration, not physical workload
 * attestation. Never project the capability into public APIs, logs or metrics.
 */
export interface TelemetryUploadAuthorization {
  'walId'?: (string);
  'capability'?: (string);
  'acknowledgedCursor'?: (number | string | Long);
  'producedCursor'?: (number | string | Long);
  'lastBatchId'?: (string);
  'lastBatchDigest'?: (string);
}

/**
 * Authenticates HTTP delivery from this registration, not physical workload
 * attestation. Never project the capability into public APIs, logs or metrics.
 */
export interface TelemetryUploadAuthorization__Output {
  'walId': (string);
  'capability': (string);
  'acknowledgedCursor': (string);
  'producedCursor': (string);
  'lastBatchId': (string);
  'lastBatchDigest': (string);
}
