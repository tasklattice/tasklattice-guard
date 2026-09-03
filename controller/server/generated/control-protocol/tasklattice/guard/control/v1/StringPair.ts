// Original file: common.proto


/**
 * A stable key/value entry. Repeated pairs are used where order is meaningful;
 * maps are reserved for unordered lookup data.
 */
export interface StringPair {
  'key'?: (string);
  'value'?: (string);
}

/**
 * A stable key/value entry. Repeated pairs are used where order is meaningful;
 * maps are reserved for unordered lookup data.
 */
export interface StringPair__Output {
  'key': (string);
  'value': (string);
}
