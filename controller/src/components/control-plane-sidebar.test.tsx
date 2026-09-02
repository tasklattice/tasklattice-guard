import { cleanup, render, screen } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";

import { ControlPlaneSidebar } from "./control-plane-sidebar";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { items: [] } }),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => string }) => select({ location: { pathname: "/policy-library" } }),
}));

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      "common.close": "Close",
      "nav.helpCenter": "Help center",
      "nav.settings": "Settings",
      "nav.settingsDescription": "Platform settings and operational information.",
      "nav.status": "Status",
      "nav.statusDescription": "View Controller, Runner, and model connection health.",
      "sidebar.toggleNavigation": "Toggle navigation",
    } as Record<string, string>)[key] ?? key,
  }),
}));

describe("ControlPlaneSidebar", () => {
  afterEach(cleanup);

  it("keeps Help and Settings together and navigates directly to Models", () => {
    render(
      <SidebarProvider>
        <TooltipProvider>
          <ControlPlaneSidebar />
        </TooltipProvider>
      </SidebarProvider>,
    );

    const help = screen.getByRole("link", { name: "Help center" });
    const settings = screen.getByRole("link", { name: "Settings" });
    expect(help.closest('[data-sidebar="footer"]')).toBe(settings.closest('[data-sidebar="footer"]'));
    expect(settings.getAttribute("href")).toBe("/settings/status");
    expect(settings.getAttribute("aria-haspopup")).toBeNull();
    expect(settings.querySelectorAll("svg")).toHaveLength(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent).toContain("Help center");
  });
});
