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
      "nav.guardrailDesign": "Guardrail Design",
      "nav.guardrails": "Guardrails",
      "nav.playground": "Playground",
      "nav.policyLibrary": "Policy Library",
      "nav.helpCenter": "Help center",
      "nav.settings": "Settings",
      "nav.settingsDescription": "Platform settings and operational information.",
      "nav.health": "Health",
      "nav.healthDescription": "View platform health.",
      "sidebar.toggleNavigation": "Toggle navigation",
    } as Record<string, string>)[key] ?? key,
  }),
}));

describe("ControlPlaneSidebar", () => {
  afterEach(cleanup);

  it("keeps the primary workflow flat while Dashboard remains on the logo", () => {
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
    expect(settings.getAttribute("href")).toBe("/settings/health");
    expect(settings.getAttribute("aria-haspopup")).toBeNull();
    expect(settings.querySelectorAll("svg")).toHaveLength(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent).toContain("Help center");

    const links = screen.getAllByRole("link");
    expect(links.slice(0, 4).map((link) => link.textContent?.trim())).toEqual([
      "TaskLattice Guard",
      "Guardrails",
      "Playground",
      "Policy Library",
    ]);
    expect(links[0].getAttribute("href")).toBe("/dashboard");
    expect(screen.queryByRole("link", { name: "Dashboard" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Validation Runs" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Runner capacity" })).toBeNull();
    expect(document.body.textContent).toContain("Guardrail Design");
    expect(document.body.textContent).not.toContain("Build & validate");
  });
});
