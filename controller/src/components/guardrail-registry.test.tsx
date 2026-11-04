import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Guardrail } from "@/lib/api";

import { GuardrailRegistry } from "./guardrail-registry";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

function renderRegistry(onOpen = vi.fn(), row: Guardrail = guardrail) {
  return render(<QueryClientProvider client={new QueryClient()}><GuardrailRegistry guardrails={[row]} onOpen={onOpen} /></QueryClientProvider>);
}

vi.mock("@tanstack/react-router", () => ({
  Link: ({ params, search, hash, to: _to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { params: { guardrailId?: string; routerId?: string }; search?: Record<string, string>; hash?: string; to?: string; children: ReactNode }) => (
    <a href={`${params.routerId ? `/integration/routers/${params.routerId}` : `/guardrails/${params.guardrailId}`}${search ? `?${new URLSearchParams(search)}` : ""}${hash ? `#${hash}` : ""}`} {...props}>{children}</a>
  ),
}));

const identity = vi.hoisted(() => ({ role: "viewer", project_id: "projectB" }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: identity }) }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      const labels: Record<string, string> = {
        "common.status": "Status",
        "guardrails.registryReadiness": "Readiness",
        "guardrails.registryVersions": "Versions",
        "modelPricing.monthlyCost": "Month cost (USD)",
        "modelPricing.openCosts": "View costs for {{name}}",
        "modelPricing.incomplete": "{{count}} calls unaccounted",
        "modelPricing.unpriced": "Unaccounted",
        "dashboard.metrics.request_rate": "Request rate",
        "guardrails.requestRateOpen": "View Request rate for {{name}}",
        "guardrails.guardrail": "Guardrail",
        "guardrails.notRun": "Not run",
        "guardrails.openNamedGuardrail": "Open {{name}}",
        "guardrails.policies": "Policies",
        "guardrails.registry": "Guardrail registry · {{count}}",
        "guardrails.updated": "Updated",
        "guardrails.validation": "Testing Report",
        "sharing.sharedFrom": "Shared from {{project}} · Read-only",
      };
      return Object.entries(values ?? {}).reduce(
        (label, [name, value]) => label.replace(`{{${name}}}`, String(value)),
        labels[key] ?? key,
      );
    },
    i18n: { language: "en", exists: () => false },
  }),
}));


const guardrail = {
  id: "guardrail-default",
  name: "Default Guardrail",
  allowed_topics: [],
  restricted_topics: [],
  policy_bindings: [],
  safety_level: "balanced",
  output_delivery: "window_buffered",
  updated_at: "2026-09-04T08:38:36Z",
  status: "enforce",
  latest_validation_run: null,
  router_count: 1,
  test_case_count: 140,
  excluded_test_case_count: 0,
  excluded_test_case_ids: [],
  tested_current: false,
  published_current: true,
  coverage: [],
} satisfies Guardrail;

describe("GuardrailRegistry", () => {
  afterEach(() => { cleanup(); identity.role = "viewer"; });

  it("keeps shared Guardrails read-only without repeating the current project", () => {
    identity.role = "user";
    const owned = { ...guardrail, id: "owned", name: "Owned Guardrail", project_id: "projectB" };
    const shared = { ...guardrail, id: "shared", name: "Shared Guardrail", project_id: "projectA" };
    render(<QueryClientProvider client={new QueryClient()}><GuardrailRegistry guardrails={[owned, shared]} onOpen={vi.fn()} /></QueryClientProvider>);
    expect(screen.queryByText("Owned by projectB")).toBeNull();
    expect(screen.getByText("Shared from projectA · Read-only")).toBeTruthy();
    expect(screen.getByRole("button", { name: "routing.actions: Owned Guardrail" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "routing.actions: Shared Guardrail" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open Shared Guardrail" })).toBeTruthy();
  });

  it("shows resource readiness and traffic without cost or version columns", () => {
    renderRegistry();

    expect(screen.getByRole("table").className).toContain("table-fixed");
    expect(screen.getByRole("columnheader", { name: "Readiness" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Policies" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Versions" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Month cost (USD)" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Testing Report" })).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Request rate" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Updated" })).toBeTruthy();
    expect(screen.queryByText("guardrails.registryUnrouted")).toBeNull();
  });

  it("supports a real detail link and whole-row pointer navigation", () => {
    const onOpen = vi.fn();
    renderRegistry(onOpen);

    const link = screen.getByRole("link", { name: "Open Default Guardrail" });
    expect(link.getAttribute("href")).toBe("/guardrails/guardrail-default");

    fireEvent.click(screen.getByText("enforce"));
    expect(onOpen).toHaveBeenCalledWith("guardrail-default");
  });

  it("links Request rate to Runtime metrics and omits routing references", () => {
    const onOpen = vi.fn();
    renderRegistry(onOpen, { ...guardrail, monthly_cost: { currency: "USD", cost: 0.00026, calls: 2, unpriced: 1, since: "2026-10-01", until: "2026-10-14" }, version_summary: { total: 3, released: 2, pending: 1, missingEvidence: 0 }, traffic_versions: [
      { version: "20261009-090837.640Z", baseline: false, routers: [{ id: "router-a", name: "Bank traffic", status: "distributing" }] },
      { version: "20261009-090835.526Z", baseline: true, routers: [] },
    ] });
    const rate = screen.getByRole("link", { name: "View Request rate for Default Guardrail" });
    expect(rate.getAttribute("href")).toBe("/guardrails/guardrail-default?tab=runtime&window=1h&metric=request_rate#runtime-metrics");
    fireEvent.click(rate);
    expect(screen.queryByText("20261009-090835.526Z")).toBeNull();
    expect(screen.queryByText("20261009-090837.640Z")).toBeNull();
    expect(screen.queryByText("guardrailPackage.baselineCurrent")).toBeNull();
    expect(screen.queryByText("Bank traffic")).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
  });
  it("keeps costs out of the registry even when usage data is present", () => {
    renderRegistry(vi.fn(), { ...guardrail, monthly_cost: { currency: "USD", cost: null, calls: 3, unpriced: 3, since: "2026-10-01", until: "2026-10-14" } });
    expect(screen.queryByRole("link", { name: "View costs for Default Guardrail" })).toBeNull();
    expect(screen.queryByText("USD 0.00")).toBeNull();
  });

});
