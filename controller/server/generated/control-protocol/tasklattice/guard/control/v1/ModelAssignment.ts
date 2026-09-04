// Original file: model.proto


/**
 * Bind one Guardrail Catalog detector type to a registered Model.
 */
export interface ModelAssignment {
  'detectorType'?: (string);
  'modelRef'?: (string);
  'profileRef'?: (string);
  'contractRefs'?: (string)[];
}

/**
 * Bind one Guardrail Catalog detector type to a registered Model.
 */
export interface ModelAssignment__Output {
  'detectorType': (string);
  'modelRef': (string);
  'profileRef': (string);
  'contractRefs': (string)[];
}
