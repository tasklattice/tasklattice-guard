import { describe, expect, it } from "vitest";

import {
  fromTrafficScopeExpression,
  getTrafficScopeConflicts,
  isTrafficScopeValid,
  setTrafficGroupCombinator,
  toTrafficScopeExpression,
} from "./model";
import type { TrafficScopeFieldDefinition, TrafficScopeQuery } from "./types";

const definitions: TrafficScopeFieldDefinition[] = [
  {
    id: "protocol",
    group: "request",
    source: "field",
    key: "protocol",
    operators: ["equals"],
    values: ["http", "litellm", "a2a"],
  },
  {
    id: "http.header",
    group: "http",
    source: "header",
    key: "",
    operators: ["equals", "contains"],
    values: [],
    custom_key: true,
  },
];

describe("traffic scope model", () => {
  it("reserves an empty expression for the product default Router", () => {
    expect(isTrafficScopeValid({ combinator: "and", rules: [] }, definitions)).toBe(false);
  });

  it("detects mutually exclusive equals rules inside an AND group", () => {
    const query: TrafficScopeQuery = {
      combinator: "and",
      rules: [
        { field: "protocol", operator: "equals", value: "http" },
        { field: "protocol", operator: "equals", value: "a2a" },
      ],
    };

    expect(getTrafficScopeConflicts(query, definitions)).toEqual([
      { path: [], field: "protocol", key: "", values: ["http", "a2a"] },
    ]);
    expect(isTrafficScopeValid(query, definitions)).toBe(false);
  });

  it("allows the same alternatives inside an OR group", () => {
    const query: TrafficScopeQuery = {
      combinator: "or",
      rules: [
        { field: "protocol", operator: "equals", value: "http" },
        { field: "protocol", operator: "equals", value: "a2a" },
      ],
    };

    expect(getTrafficScopeConflicts(query, definitions)).toEqual([]);
    expect(isTrafficScopeValid(query, definitions)).toBe(true);
  });

  it("updates only the conflicting nested group", () => {
    const query: TrafficScopeQuery = {
      combinator: "and",
      rules: [
        { field: "protocol", operator: "equals", value: "http" },
        {
          combinator: "and",
          rules: [
            { field: "protocol", operator: "equals", value: "http" },
            { field: "protocol", operator: "equals", value: "a2a" },
          ],
        },
      ],
    };

    const updated = setTrafficGroupCombinator(query, [1], "or");

    expect(updated.combinator).toBe("and");
    expect(updated.rules[1]).toMatchObject({ combinator: "or" });
  });

  it("converts custom request attributes into the backend expression", () => {
    const query: TrafficScopeQuery = {
      combinator: "and",
      rules: [
        { field: "protocol", operator: "equals", value: "http" },
        {
          combinator: "or",
          rules: [
            {
              field: "http.header",
              operator: "equals",
              value: { key: "x-app-id", value: "finance-agent" },
            },
          ],
        },
      ],
    };

    expect(toTrafficScopeExpression(query, definitions)).toEqual({
      combinator: "and",
      conditions: [
        { field: "protocol", operator: "equals", value: "http" },
        {
          combinator: "or",
          conditions: [
            {
              field: "http.header",
              key: "x-app-id",
              operator: "equals",
              value: "finance-agent",
            },
          ],
        },
      ],
    });
  });

  it("restores a persisted selector for Router editing", () => {
    const expression = {
      combinator: "and" as const,
      conditions: [
        {
          field: "http.header",
          key: "x-app-id",
          operator: "equals" as const,
          value: "finance-agent",
        },
      ],
    };

    const query = fromTrafficScopeExpression(expression, definitions);

    expect(query.rules[0]).toMatchObject({
      field: "http.header",
      operator: "equals",
      value: { key: "x-app-id", value: "finance-agent" },
    });
    expect(toTrafficScopeExpression(query, definitions)).toEqual(expression);
  });
});
