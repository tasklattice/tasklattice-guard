// Original file: runner_control.proto


/**
 * Stop-and-wait delivery. Each payload is a bounded gzip ValidationResult;
 * data chunks contain cases only, the last chunk contains report metadata only.
 * The manifest is SHA256 of the ordered raw chunk digests joined by a newline.
 */
export interface ValidationReportChunk {
  'runnerId'?: (string);
  'runId'?: (string);
  'uploadId'?: (string);
  'manifestDigest'?: (string);
  'sequence'?: (number);
  'chunks'?: (number);
  'cases'?: (number);
  'caseOffset'?: (number);
  'rawSizeBytes'?: (number);
  'sha256'?: (string);
  'gzipResult'?: (Buffer | Uint8Array | string);
  'final'?: (boolean);
}

/**
 * Stop-and-wait delivery. Each payload is a bounded gzip ValidationResult;
 * data chunks contain cases only, the last chunk contains report metadata only.
 * The manifest is SHA256 of the ordered raw chunk digests joined by a newline.
 */
export interface ValidationReportChunk__Output {
  'runnerId': (string);
  'runId': (string);
  'uploadId': (string);
  'manifestDigest': (string);
  'sequence': (number);
  'chunks': (number);
  'cases': (number);
  'caseOffset': (number);
  'rawSizeBytes': (number);
  'sha256': (string);
  'gzipResult': (Buffer);
  'final': (boolean);
}
