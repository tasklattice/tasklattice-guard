import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Router, Guardrail, Endpoint } from "@/lib/api";

import { CreateRouterSheet, TrafficScopeBadges } from "./routers";

const createBindingsMock = vi.fn();
const getEndpointsMock = vi.fn();
const getTrafficScopeFieldsMock = vi.fn();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      const labels: Record<string, string> = {
        "common.cancel": "Cancel",
        "common.multiSelect.available": "{{count}} available",
        "common.multiSelect.options": "{{name}} options",
        "common.multiSelect.open": "Open {{name}}",
        "common.multiSelect.close": "Close {{name}}",
        "common.multiSelect.remove": "Remove {{name}}",
        "routers.routerName": "Router name",
        "routers.gateways": "Gateway Endpoints",
        "routers.selectGateways": "Select Gateways",
        "routers.searchGateways": "Search Gateways",
        "routers.allTraffic": "All traffic",
        "routers.filteredTraffic": "Only matching traffic",
        "routers.createBindings": "Create {{count}} bindings",
        "routers.creating": "Creating…",
        "routers.createdBindings": "Created {{count}} bindings",
        "routers.guardrail": "Guardrail",
        "endpoints.setupStatuses.verified": "Verified",
      };
      return Object.entries(values ?? {}).reduce(
        (label, [name, value]) => label.replace(`{{${name}}}`, String(value)),
        labels[key] ?? key,
      );
    },
    i18n: { language: "en", exists: () => false },
  }),
}));

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: "admin" } }) }));

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...original,
    createRouterBindings: (...args: unknown[]) => createBindingsMock(...args),
    getEndpoints: (...args: unknown[]) => getEndpointsMock(...args),
    getTrafficScopeFields: (...args: unknown[]) => getTrafficScopeFieldsMock(...args),
  };
});

const endpoints = [
  {
    id: "endpoint-cn",
    adapter_id: "litellm-generic-guardrail",
    protocol: "litellm",
    name: "Gateway CN",
    enabled: true,
    setup_status: "verified",
  },
  {
    id: "endpoint-us",
    adapter_id: "litellm-generic-guardrail",
    protocol: "litellm",
    name: "Gateway US",
    enabled: true,
    setup_status: "verified",
  },
] as Endpoint[];

const guardrail = {
  id: "guardrail-finance",
  name: "Finance Guardrail",
  allowed_topics: [],
  restricted_topics: [],
  safety_level: "balanced",
  output_delivery: "window_buffered",
  updated_at: "2026-08-14T08:00:00Z",
  status: "ready",
  latest_validation_run: null,
  router_count: 0,
  tested_current: true,
  published_current: true,
  is_default: false,
  system_managed: false,
  local_only: false,
  policy_bindings: [],
  test_case_count: 4,
  excluded_test_case_count: 0,
  excluded_test_case_ids: [],
  coverage: [],
} satisfies Guardrail;

function renderWithProviders(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe("Router Endpoint bindings", () => {
  beforeEach(() => {
    createBindingsMock.mockReset().mockResolvedValue({ items: [], count: 2 });
    getEndpointsMock.mockReset().mockResolvedValue({ items: endpoints, count: endpoints.length });
    getTrafficScopeFieldsMock.mockReset().mockResolvedValue({ items: [], count: 0 });
  });

  afterEach(cleanup);

  it("creates one independent all-traffic binding for every selected Gateway", async () => {
    const onCreated = vi.fn();
    renderWithProviders(
      <CreateRouterSheet
        open
        onOpenChange={vi.fn()}
        guardrails={[guardrail]}
        onCreated={onCreated}
      />,
    );

    fireEvent.change(await screen.findByPlaceholderText("Finance production traffic"), { target: { value: "Regional finance traffic" } });
    const gatewaySelector = await screen.findByRole("combobox", { name: "Gateway Endpoints" });
    fireEvent.focus(gatewaySelector);
    fireEvent.click(await screen.findByRole("option", { name: /Gateway CN/ }));
    await waitFor(() => expect(screen.getByRole("option", { name: /Gateway US/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("option", { name: /Gateway US/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create 2 bindings" }));

    await waitFor(() => expect(createBindingsMock).toHaveBeenCalledWith({
      name: "Regional finance traffic",
      guardrail_id: guardrail.id,
      endpoint_ids: ["endpoint-cn", "endpoint-us"],
      traffic_scope: { combinator: "and", conditions: [] },
      enabled: true,
    }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
  });

  it("labels Endpoint catch-all traffic separately from the system fallback", () => {
    const binding = {
      id: "router-binding",
      name: "All Gateway traffic",
      guardrail_id: guardrail.id,
      guardrail_version: "20260904-030000.003Z",
      endpoint_id: "endpoint-cn",
      route_order: 1,
      traffic_scope: { combinator: "and", conditions: [] },
      enabled: true,
      is_default: false,
      system_managed: false,
      updated_at: "2026-08-14T08:00:00Z",
    } satisfies Router;
    const fallback = { ...binding, id: "router-default", endpoint_id: null, is_default: true, system_managed: true } satisfies Router;

    const { rerender } = render(<TrafficScopeBadges router={binding} />);
    expect(screen.getByText("All traffic")).toBeTruthy();
    rerender(<TrafficScopeBadges router={fallback} />);
    expect(screen.getByText("routers.unmatchedTraffic")).toBeTruthy();
  });
});
