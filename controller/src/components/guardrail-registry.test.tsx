import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Guardrail } from "@/lib/api";

import { GuardrailRegistry } from "./guardrail-registry";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ params, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { params: { guardrailId: string }; children: ReactNode }) => (
    <a href={`/guardrails/${params.guardrailId}`} {...props}>{children}</a>
  ),
}));

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
        "guardrails.validation": "Validation Run",
      };
      return Object.entries(values ?? {}).reduce(
        (label, [name, value]) => label.replace(`{{${name}}}`, String(value)),
        labels[key] ?? key,
      );
    },
    i18n: { language: "en", exists: () => false },
  }),
}));

const longPurpose = "Protect unmatched traffic with complete local Policies for PII, credentials, pattern matching, abusive language, harmful content, and prompt injection without calling an external model.";

const guardrail = {
  id: "guardrail-default",
  name: "Default Guardrail",
  purpose: longPurpose,
  purpose_details: { audience: "", tasks: "", protect: "", out_of_scope: "" },
  custom_content_rules: [],
  allowed_topics: [],
  restricted_topics: [],
  policy_bindings: [],
  safety_level: "balanced",
  output_delivery: "window_buffered",
  updated_at: "2026-09-04T08:38:36Z",
  status: "protected",
  latest_validation_run: null,
  deployment_count: 1,
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

  it("keeps registry metadata visible while constraining a long purpose", () => {
    render(<GuardrailRegistry guardrails={[guardrail]} onOpen={vi.fn()} />);

    expect(screen.getByRole("table").className).toContain("table-fixed");
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Policies" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Validation Run" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Updated" })).toBeTruthy();
    expect(screen.getByText(longPurpose).className).toContain("whitespace-normal");
    expect(screen.getByText(longPurpose).className).toContain("line-clamp-2");
  });

  it("supports a real detail link and whole-row pointer navigation", () => {
    const onOpen = vi.fn();
    render(<GuardrailRegistry guardrails={[guardrail]} onOpen={onOpen} />);

    const link = screen.getByRole("link", { name: "Open Default Guardrail" });
    expect(link.getAttribute("href")).toBe("/guardrails/guardrail-default");

    fireEvent.click(screen.getByText("protected"));
    expect(onOpen).toHaveBeenCalledWith("guardrail-default");
  });
});
