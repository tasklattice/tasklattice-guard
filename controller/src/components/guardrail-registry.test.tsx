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
  Link: ({ params, search, to: _to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { params: { guardrailId?: string; routerId?: string }; search?: Record<string, string>; to?: string; children: ReactNode }) => (
    <a href={`${params.routerId ? `/integration/routers/${params.routerId}` : `/guardrails/${params.guardrailId}`}${search ? `?${new URLSearchParams(search)}` : ""}`} {...props}>{children}</a>
  ),
}));

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: "viewer" } }) }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      const labels: Record<string, string> = {
        "common.status": "Status",
        "guardrails.registryReadiness": "Readiness",
        "guardrails.registryVersions": "Versions",
        "guardrails.registryTraffic": "Traffic versions",
        "guardrails.guardrail": "Guardrail",
        "guardrails.notRun": "Not run",
        "guardrails.openNamedGuardrail": "Open {{name}}",
        "guardrails.policies": "Policies",
        "guardrails.registry": "Guardrail registry · {{count}}",
        "guardrails.updated": "Updated",
        "guardrails.validation": "Testing Report",
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
  status: "ready",
  latest_validation_run: null,
  router_count: 1,
  test_case_count: 140,
  excluded_test_case_count: 0,
  excluded_test_case_ids: [],
  tested_current: false,
  published_current: true,
  is_default: true,
  system_managed: true,
  local_only: true,
  coverage: [],
} satisfies Guardrail;

describe("GuardrailRegistry", () => {
  afterEach(cleanup);

  it("shows resource readiness, version capacity and exact traffic references instead of draft Policy or latest-report summaries", () => {
    renderRegistry();

    expect(screen.getByRole("table").className).toContain("table-fixed");
    expect(screen.getByRole("columnheader", { name: "Readiness" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Policies" })).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Versions" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Testing Report" })).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Traffic versions" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Updated" })).toBeTruthy();
  });

  it("supports a real detail link and whole-row pointer navigation", () => {
    const onOpen = vi.fn();
    renderRegistry(onOpen);

    const link = screen.getByRole("link", { name: "Open Default Guardrail" });
    expect(link.getAttribute("href")).toBe("/guardrails/guardrail-default");

    fireEvent.click(screen.getByText("ready"));
    expect(onOpen).toHaveBeenCalledWith("guardrail-default");
  });

  it("links capacity to the version list and each traffic version to its own detail, without triggering row navigation", () => {
    const onOpen = vi.fn();
    renderRegistry(onOpen, { ...guardrail, version_summary: { total: 3, released: 2, pending: 1, missingEvidence: 0 }, traffic_versions: [
      { version: "20261009-090837.640Z", baseline: false, routers: [{ id: "router-a", name: "Bank traffic", status: "distributing" }] },
      { version: "20261009-090835.526Z", baseline: true, routers: [] },
    ] });
    expect(screen.getByText("3/10").getAttribute("href")).toBe("/guardrails/guardrail-default?tab=immutable");
    const version = screen.getByRole("link", { name: "20261009-090835.526Z" });
    expect(version.getAttribute("href")).toBe("/guardrails/guardrail-default?tab=immutable&version=20261009-090835.526Z");
    expect(screen.getByRole("link", { name: "Bank traffic" }).getAttribute("href")).toBe("/integration/routers/router-a");
    fireEvent.click(version);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
