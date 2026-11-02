import { describe, expect, it } from "vitest";
import { defaultEndpointContextStorageLimits as defaults, validateEndpointContextStorageLimits as validate } from "./endpoint-context-storage-policy.js";

describe("Endpoint context storage policy", () => {
  it.each([null, undefined, {}, [], { ...defaults, maxRowsGlobal: undefined }, { ...defaults, maxRowsGlobal: NaN },
    { ...defaults, maxRowsPerPool: true }, { ...defaults, extra: 1 }, { ...defaults, maxRowsPerPool: 2049 },
    { ...defaults, maxPayloadBytesPerContext: 16777217 }])("fails closed for invalid policy %j", invalid => {
    expect(() => validate(invalid as never)).toThrow("Endpoint context storage limits");
  });
  it("copies and freezes a validated policy", () => {
    const input = { ...defaults }, result = validate(input);
    input.maxRowsPerPool = 1;
    expect(result.maxRowsPerPool).toBe(256);
    expect(Object.isFrozen(result)).toBe(true);
  });
});
