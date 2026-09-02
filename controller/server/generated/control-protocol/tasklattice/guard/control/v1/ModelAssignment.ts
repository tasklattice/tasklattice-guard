// Original file: model.proto


/**
 * Bind one product module role to a registered Model.
 */
export interface ModelAssignment {
  'role'?: (string);
  'modelRef'?: (string);
  'profileRef'?: (string);
  'contractRefs'?: (string)[];
}

/**
 * Bind one product module role to a registered Model.
 */
export interface ModelAssignment__Output {
  'role': (string);
  'modelRef': (string);
  'profileRef': (string);
  'contractRefs': (string)[];
}
