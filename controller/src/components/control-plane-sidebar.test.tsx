import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";

import i18n from "@/i18n";

import { ControlPlaneSidebar } from "./control-plane-sidebar";

const queryData = vi.hoisted(() => ({ value: { items: [] } as Record<string, unknown> }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: queryData.value }),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => string }) => select({ location: { pathname: "/policy-library" } }),
}));

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

describe("ControlPlaneSidebar", () => {
  afterEach(() => { cleanup(); queryData.value = { items: [] }; });

  it("hides authoring-only areas in an environment that only receives released Guardrails", () => {
    queryData.value = { items: [], authoringEnabled: false };
    render(<SidebarProvider><TooltipProvider><ControlPlaneSidebar /></TooltipProvider></SidebarProvider>);
    expect(screen.getByRole("link", { name: "Guardrails" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Playground" })).toBeNull();
    // Policy Library stays: it lists the Policies of released versions there.
    expect(screen.getByRole("link", { name: "Policy Library" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Routers" })).toBeTruthy();
  });

  beforeEach(async () => { await i18n.changeLanguage("en"); });

  it("keeps the primary workflow flat while Dashboard remains on the logo", () => {
    render(
      <SidebarProvider>
        <TooltipProvider>
          <ControlPlaneSidebar />
        </TooltipProvider>
      </SidebarProvider>,
    );

    expect(screen.getByRole("link", { name: "Routers" }).getAttribute("href")).toBe("/integration/routers");
    expect(screen.getByRole("link", { name: "Endpoints" }).getAttribute("href")).toBe("/integration/endpoints");
    expect(document.body.textContent).toContain("Integration");
    expect(screen.queryByRole("link", { name: "Deployments" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Integrations" })).toBeNull();

    const help = screen.getByRole("link", { name: "Documentation" });
    const settings = screen.getByRole("link", { name: "Settings" });
    expect(help.closest('[data-sidebar="footer"]')).toBe(settings.closest('[data-sidebar="footer"]'));
    expect(help.getAttribute("href")).toBe("/document");
    expect(settings.getAttribute("href")).toBe("/settings/health");
    expect(settings.getAttribute("aria-haspopup")).toBeNull();
    expect(settings.querySelectorAll("svg")).toHaveLength(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent).toContain("Documentation");

    const links = screen.getAllByRole("link");
    expect(links.slice(0, 4).map((link) => link.textContent?.trim())).toEqual([
      "TaskLattice Guard",
      "Guardrails",
      "Playground",
      "Policy Library",
    ]);
    expect(links[0].getAttribute("href")).toBe("/dashboard");
    expect(screen.queryByRole("link", { name: "Dashboard" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Testing Reports" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Runner capacity" })).toBeNull();
    expect(document.body.textContent).toContain("Guardrail Design");
    expect(document.body.textContent).not.toContain("Build & validate");
  });
  it("preserves explicit collapse controls without expanding on hover", () => {
    const { container } = render(
      <SidebarProvider>
        <ControlPlaneSidebar />
        <SidebarTrigger />
      </SidebarProvider>,
    );
    const sidebar = container.querySelector('[data-slot="sidebar"]')!;
    const rail = container.querySelector<HTMLButtonElement>('[data-sidebar="rail"]')!;
    const toggle = screen.getAllByRole("button", { name: "Toggle navigation" }).find(button => button !== rail)!;
    expect(screen.getByRole("link", { name: "TaskLattice Guard" }).closest('[data-sidebar="header"]')).not.toBeNull();
    expect(sidebar.getAttribute("data-state")).toBe("expanded");
    fireEvent.click(toggle);
    expect(sidebar.getAttribute("data-state")).toBe("collapsed");
    fireEvent.mouseEnter(sidebar);
    expect(sidebar.getAttribute("data-state")).toBe("collapsed");
    fireEvent.click(rail);
    expect(sidebar.getAttribute("data-state")).toBe("expanded");
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(sidebar.getAttribute("data-state")).toBe("collapsed");
    fireEvent.keyDown(window, { key: "b", metaKey: true });
    expect(sidebar.getAttribute("data-state")).toBe("expanded");
  });

});
