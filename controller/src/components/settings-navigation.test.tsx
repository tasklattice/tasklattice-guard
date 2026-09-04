import { cleanup, render, screen } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsNavigation } from "./settings-navigation";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => string }) => select({ location: { pathname: "/settings/models" } }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("SettingsNavigation", () => {
  afterEach(cleanup);

  it("uses route-backed tabs for Health, Runner, Providers, Models, and Guardrail Catalog", () => {
    render(<SettingsNavigation />);

    const tablist = screen.getByRole("tablist", { name: "nav.settings" });
    const models = screen.getByRole("tab", { name: "nav.models" });
    const health = screen.getByRole("tab", { name: "nav.health" });
    const runner = screen.getByRole("tab", { name: "nav.runner" });
    const providers = screen.getByRole("tab", { name: "nav.providers" });
    const catalog = screen.getByRole("tab", { name: "nav.guardrailCatalog" });

    expect(tablist.contains(models)).toBe(true);
    expect(tablist.contains(health)).toBe(true);
    expect(tablist.contains(runner)).toBe(true);
    expect(tablist.contains(providers)).toBe(true);
    expect(tablist.contains(catalog)).toBe(true);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent?.trim())).toEqual([
      "nav.health",
      "nav.runner",
      "nav.providers",
      "nav.models",
      "nav.guardrailCatalog",
    ]);
    expect(models.getAttribute("aria-selected")).toBe("true");
    expect(models.getAttribute("href")).toBe("/settings/models");
    expect(health.getAttribute("href")).toBe("/settings/health");
    expect(runner.getAttribute("href")).toBe("/settings/runner");
    expect(providers.getAttribute("href")).toBe("/settings/providers");
    expect(catalog.getAttribute("href")).toBe("/settings/guardrail-catalog");
  });
});
