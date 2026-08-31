// Original file: evaluation.proto


/**
 * Native model/provider output retained alongside the normalized verdict.
 */
export interface ProviderEvidence {
  /**
   * Configured Provider registry ID, not a transport vendor enum.
   */
  'providerId'?: (string);
  /**
   * Exact model identifier sent to the Provider endpoint.
   */
  'model'?: (string);
  /**
   * Provider-native verdict before mapping to EvaluatorVerdict.
   */
  'nativeVerdict'?: (string);
  /**
   * Provider-native taxonomy/category when one was returned.
   */
  'nativeCategory'?: (string);
  /**
   * Mapping quality such as direct, parent, or partial; absence means unreported.
   */
  'mappingQuality'?: (string);
  '_nativeCategory'?: "nativeCategory";
  '_mappingQuality'?: "mappingQuality";
}

/**
 * Native model/provider output retained alongside the normalized verdict.
 */
export interface ProviderEvidence__Output {
  /**
   * Configured Provider registry ID, not a transport vendor enum.
   */
  'providerId': (string);
  /**
   * Exact model identifier sent to the Provider endpoint.
   */
  'model': (string);
  /**
   * Provider-native verdict before mapping to EvaluatorVerdict.
   */
  'nativeVerdict': (string);
  /**
   * Provider-native taxonomy/category when one was returned.
   */
  'nativeCategory'?: (string);
  /**
   * Mapping quality such as direct, parent, or partial; absence means unreported.
   */
  'mappingQuality'?: (string);
  '_nativeCategory'?: "nativeCategory";
  '_mappingQuality'?: "mappingQuality";
}
