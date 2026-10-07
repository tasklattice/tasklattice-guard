import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Guardrail } from "@/lib/api";

import { GuardrailRegistry } from "./guardrail-registry";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

function renderRegistry(onOpen = vi.fn()) {
  return render(<QueryClientProvider client={new QueryClient()}><GuardrailRegistry guardrails={[guardrail]} onOpen={onOpen} /></QueryClientProvider>);
}

vi.mock("@tanstack/react-router", () => ({
  Link: ({ params, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { params: { guardrailId: string }; children: ReactNode }) => (
    <a href={`/guardrails/${params.guardrailId}`} {...props}>{children}</a>
  ),
}));

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: "viewer" } }) }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      const labels: Record<string, string> = {
        "common.status": "Status",
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
  status: "protected",
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

  it("shows Policy-based registry metadata without a purpose", () => {
    renderRegistry();

    expect(screen.getByRole("table").className).toContain("table-fixed");
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Policies" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Testing Report" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Updated" })).toBeTruthy();
  });

  it("supports a real detail link and whole-row pointer navigation", () => {
    const onOpen = vi.fn();
    renderRegistry(onOpen);

    const link = screen.getByRole("link", { name: "Open Default Guardrail" });
    expect(link.getAttribute("href")).toBe("/guardrails/guardrail-default");

    fireEvent.click(screen.getByText("protected"));
    expect(onOpen).toHaveBeenCalledWith("guardrail-default");
  });
});
