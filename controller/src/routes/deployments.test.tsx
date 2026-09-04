import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Deployment, Guardrail, Integration } from "@/lib/api";

import { CreateDeploymentSheet, TrafficScopeBadges } from "./deployments";

const createBindingsMock = vi.fn();
const getIntegrationsMock = vi.fn();
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
        "deployments.deploymentName": "Deployment name",
        "deployments.gateways": "Gateway Integrations",
        "deployments.selectGateways": "Select Gateways",
        "deployments.searchGateways": "Search Gateways",
        "deployments.allTraffic": "All traffic",
        "deployments.filteredTraffic": "Only matching traffic",
        "deployments.createBindings": "Create {{count}} bindings",
        "deployments.creating": "Creating…",
        "deployments.createdBindings": "Created {{count}} bindings",
        "deployments.guardrail": "Guardrail",
        "integrations.setupStatuses.verified": "Verified",
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
    createDeploymentBindings: (...args: unknown[]) => createBindingsMock(...args),
    getIntegrations: (...args: unknown[]) => getIntegrationsMock(...args),
    getTrafficScopeFields: (...args: unknown[]) => getTrafficScopeFieldsMock(...args),
  };
});

const integrations = [
  {
    id: "integration-cn",
    adapter_id: "litellm-generic-guardrail",
    protocol: "litellm",
    name: "Gateway CN",
    enabled: true,
    setup_status: "verified",
  },
  {
    id: "integration-us",
    adapter_id: "litellm-generic-guardrail",
    protocol: "litellm",
    name: "Gateway US",
    enabled: true,
    setup_status: "verified",
  },
] as Integration[];

const guardrail = {
  id: "guardrail-finance",
  name: "Finance Guardrail",
  purpose: "Protect regional finance traffic.",
  allowed_topics: [],
  restricted_topics: [],
  safety_level: "balanced",
  output_delivery: "window_buffered",
  updated_at: "2026-08-14T08:00:00Z",
  status: "ready",
  latest_validation_run: null,
  deployment_count: 0,
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

describe("Deployment Integration bindings", () => {
  beforeEach(() => {
    createBindingsMock.mockReset().mockResolvedValue({ items: [], count: 2 });
    getIntegrationsMock.mockReset().mockResolvedValue({ items: integrations, count: integrations.length });
    getTrafficScopeFieldsMock.mockReset().mockResolvedValue({ items: [], count: 0 });
  });

  afterEach(cleanup);

  it("creates one independent all-traffic binding for every selected Gateway", async () => {
    const onCreated = vi.fn();
    renderWithProviders(
      <CreateDeploymentSheet
        open
        onOpenChange={vi.fn()}
        guardrails={[guardrail]}
        onCreated={onCreated}
      />,
    );

    fireEvent.change(await screen.findByPlaceholderText("Finance production traffic"), { target: { value: "Regional finance traffic" } });
    const gatewaySelector = await screen.findByRole("combobox", { name: "Gateway Integrations" });
    fireEvent.focus(gatewaySelector);
    fireEvent.click(await screen.findByRole("option", { name: /Gateway CN/ }));
    await waitFor(() => expect(screen.getByRole("option", { name: /Gateway US/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("option", { name: /Gateway US/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create 2 bindings" }));

    await waitFor(() => expect(createBindingsMock).toHaveBeenCalledWith({
      name: "Regional finance traffic",
      guardrail_id: guardrail.id,
      integration_ids: ["integration-cn", "integration-us"],
      traffic_scope: { combinator: "and", conditions: [] },
      enabled: true,
    }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
  });

  it("labels Integration catch-all traffic separately from the system fallback", () => {
    const binding = {
      id: "deployment-binding",
      name: "All Gateway traffic",
      guardrail_id: guardrail.id,
      guardrail_version: "20260904-030000.003Z",
      integration_id: "integration-cn",
      route_order: 1,
      traffic_scope: { combinator: "and", conditions: [] },
      enabled: true,
      is_default: false,
      system_managed: false,
      updated_at: "2026-08-14T08:00:00Z",
    } satisfies Deployment;
    const fallback = { ...binding, id: "deployment-default", integration_id: null, is_default: true, system_managed: true } satisfies Deployment;

    const { rerender } = render(<TrafficScopeBadges deployment={binding} />);
    expect(screen.getByText("All traffic")).toBeTruthy();
    rerender(<TrafficScopeBadges deployment={fallback} />);
    expect(screen.getByText("deployments.unmatchedTraffic")).toBeTruthy();
  });
});
