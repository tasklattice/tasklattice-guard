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

  it("uses route-backed tabs for Status, Providers, Models, and Capabilities", () => {
    render(<SettingsNavigation />);

    const tablist = screen.getByRole("tablist", { name: "nav.settings" });
    const models = screen.getByRole("tab", { name: "nav.models" });
    const status = screen.getByRole("tab", { name: "nav.status" });
    const providers = screen.getByRole("tab", { name: "nav.providers" });
    const capabilities = screen.getByRole("tab", { name: "nav.capabilities" });

    expect(tablist.contains(models)).toBe(true);
    expect(tablist.contains(status)).toBe(true);
    expect(tablist.contains(providers)).toBe(true);
    expect(tablist.contains(capabilities)).toBe(true);
    expect(models.getAttribute("aria-selected")).toBe("true");
    expect(models.getAttribute("href")).toBe("/settings/models");
    expect(status.getAttribute("href")).toBe("/settings/status");
    expect(providers.getAttribute("href")).toBe("/settings/providers");
    expect(capabilities.getAttribute("href")).toBe("/settings/capabilities");
  });
});
