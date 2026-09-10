import { describe, expect, it } from "vitest";

import { assertCatchAllTopology, isCatchAllTrafficScope } from "../services/control-plane.js";

const filtered = { combinator: "and", conditions: [{ field: "protocol", operator: "equals", value: "litellm" }] };
const catchAll = { combinator: "and", conditions: [] };

describe("Router route topology", () => {
  it("recognizes only an explicit empty condition group as catch-all", () => {
    expect(isCatchAllTrafficScope(catchAll)).toBe(true);
    expect(isCatchAllTrafficScope(filtered)).toBe(false);
    expect(isCatchAllTrafficScope({})).toBe(false);
  });

  it("allows at most one catch-all and requires it to be last", () => {
    expect(() => assertCatchAllTopology([
      { routeOrder: 0, trafficScope: filtered },
      { routeOrder: 1, trafficScope: catchAll },
    ])).not.toThrow();
    expect(() => assertCatchAllTopology([
      { routeOrder: 0, trafficScope: catchAll },
      { routeOrder: 1, trafficScope: filtered },
    ])).toThrow("final route");
    expect(() => assertCatchAllTopology([
      { routeOrder: 0, trafficScope: catchAll },
      { routeOrder: 1, trafficScope: catchAll },
    ])).toThrow("only one catch-all");
  });
});
