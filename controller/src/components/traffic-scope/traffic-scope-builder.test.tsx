import { fireEvent, render, screen } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { TrafficScopeBuilder } from "./traffic-scope-builder";
import type { TrafficScopeBuilderProps, TrafficScopeFieldDefinition } from "./types";

const definitions: TrafficScopeFieldDefinition[] = [
  {
    id: "protocol",
    group: "request",
    source: "field",
    key: "protocol",
    operators: ["equals"],
    values: ["http", "a2a"],
  },
];

const conflictQuery: TrafficScopeBuilderProps["query"] = {
  combinator: "and",
  rules: [
    { field: "protocol", operator: "equals", value: "http" },
    { field: "protocol", operator: "equals", value: "a2a" },
  ],
};

const testI18n = i18next.createInstance();
const labels: Record<string, string> = {
  "routers.trafficScopeBuilder.title": "Traffic Scope",
  "routers.trafficScopeBuilder.description": "Build a Traffic Scope.",
  "routers.trafficScopeBuilder.expressionDescription": "Match requests with these conditions.",
  "routers.trafficScopeBuilder.allConditions": "Match all (AND)",
  "routers.trafficScopeBuilder.anyCondition": "Match any (OR)",
  "routers.trafficScopeBuilder.add": "Add condition",
  "routers.trafficScopeBuilder.addGroup": "Add group",
  "routers.trafficScopeBuilder.remove": "Remove condition",
  "routers.trafficScopeBuilder.removeGroup": "Remove group",
  "routers.trafficScopeBuilder.ruleRelation": "Rule relation",
  "routers.trafficScopeBuilder.field": "Request field",
  "routers.trafficScopeBuilder.operator": "Operator",
  "routers.trafficScopeBuilder.value": "Value",
  "routers.trafficScopeBuilder.conflictTitle": "This group cannot match",
  "routers.trafficScopeBuilder.exclusiveEqualsConflict": "{{field}} cannot equal {{values}} at the same time.",
  "routers.trafficScopeBuilder.changeGroupToOr": "Change this group to OR",
  "routers.trafficScopeFields.protocol": "Protocol",
  "routers.trafficScopeGroups.request": "Request",
  "routers.trafficScopeOperators.equals": "equals",
};

function renderBuilder(props: TrafficScopeBuilderProps) {
  return render(<I18nextProvider i18n={testI18n}><TrafficScopeBuilder {...props} /></I18nextProvider>);
}

describe("TrafficScopeBuilder", () => {
  beforeAll(async () => {
    await testI18n.use(initReactI18next).init({
      lng: "en",
      fallbackLng: false,
      resources: { en: { translation: labels } },
      interpolation: { escapeValue: false },
    });
  });

  it("renders as a standalone compact builder", () => {
    renderBuilder({
      definitions,
      query: { combinator: "and", rules: [{ field: "protocol", operator: "equals", value: "http" }] },
      onQueryChange: vi.fn(),
    });

    expect(screen.getByRole("heading", { name: "Traffic Scope" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add condition" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add group" })).toBeTruthy();
    expect(screen.getByText("1 / 16")).toBeTruthy();
    expect(screen.queryByText("All traffic")).toBeNull();
  });

  it("explains an impossible AND group and offers one-click recovery", () => {
    const onQueryChange = vi.fn();
    renderBuilder({
      definitions,
      query: conflictQuery,
      onQueryChange,
    });

    expect(screen.getByRole("alert").textContent).toContain("Protocol cannot equal http / a2a at the same time.");
    fireEvent.click(screen.getByRole("button", { name: "Change this group to OR" }));
    expect(onQueryChange).toHaveBeenCalledWith(expect.objectContaining({ combinator: "or" }));
  });
});
