import "@/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Guardrail, Endpoint } from "@/lib/api";

import { CreateRouterSheet } from "./routers";

const createBindingsMock = vi.fn();
const getEndpointsMock = vi.fn();
const getTrafficScopeFieldsMock = vi.fn();



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

  it("renders Router creation as one page", async () => {
    renderWithProviders(
      <CreateRouterSheet
        open
        onOpenChange={vi.fn()}
        onCreated={vi.fn()}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Create Router" })).toBeTruthy();
    expect(screen.getByLabelText("Router name")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Source Endpoints" })).toBeTruthy();
    expect(screen.getByText("Route settings")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create Router" })).toBeTruthy();
  });

});
