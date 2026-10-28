// Original file: runner_control.proto

import type { Long } from '@grpc/proto-loader';

/**
 * Large reports retain the typed ValidationResult contract: gzip-compressed
 * protobuf bytes, never JSON. Sizes and digest are checked before persistence.
 */
export interface ValidationReport {
  'runnerId'?: (string);
  'runId'?: (string);
  /**
   * A complete ValidationResult encoded as protobuf, then gzip-compressed.
   */
  'gzipResult'?: (Buffer | Uint8Array | string);
  /**
   * Exact decoded protobuf length; Controller rejects values above 128 MiB.
   */
  'rawSizeBytes'?: (number | string | Long);
  /**
   * Lowercase hexadecimal SHA-256 of the uncompressed protobuf bytes.
   */
  'sha256'?: (string);
}

/**
 * Large reports retain the typed ValidationResult contract: gzip-compressed
 * protobuf bytes, never JSON. Sizes and digest are checked before persistence.
 */
export interface ValidationReport__Output {
  'runnerId': (string);
  'runId': (string);
  /**
   * A complete ValidationResult encoded as protobuf, then gzip-compressed.
   */
  'gzipResult': (Buffer);
  /**
   * Exact decoded protobuf length; Controller rejects values above 128 MiB.
   */
  'rawSizeBytes': (string);
  /**
   * Lowercase hexadecimal SHA-256 of the uncompressed protobuf bytes.
   */
  'sha256': (string);
}
