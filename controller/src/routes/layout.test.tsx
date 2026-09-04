import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ControlPlaneLayout } from "./layout";

let pathname = "/dashboard";

vi.mock("@tanstack/react-router", () => ({
  Outlet: () => <div>Page content</div>,
  useRouterState: () => pathname,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    isLoading: false,
    status: { authenticated: true },
    user: { role: "admin", display_name: "Administrator" },
  }),
}));

vi.mock("@/components/account-menu", () => ({
  AccountMenu: ({ placement }: { placement?: string }) => <button type="button">Account menu · {placement}</button>,
}));
vi.mock("@/components/control-plane-sidebar", () => ({ ControlPlaneSidebar: () => <aside>Navigation</aside> }));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("@/components/ui/sidebar", () => ({
  SidebarProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarInset: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarTrigger: () => <button type="button">Toggle navigation</button>,
}));
vi.mock("@/routes/login", () => ({ LoginPage: () => null }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      "nav.home": "Home",
      "nav.dashboard": "Dashboard",
      "nav.guardrailDesign": "Guardrail Design",
      "nav.guardrails": "Guardrails",
      "auth.sessionLoading": "Checking your session…",
    } as Record<string, string>)[key] ?? key,
  }),
}));

describe("ControlPlaneLayout", () => {
  afterEach(() => { cleanup(); pathname = "/dashboard"; });

  it("shows Dashboard as a standalone title instead of a breadcrumb trail", () => {
    render(<ControlPlaneLayout />);

    expect(screen.getByRole("button", { name: "Account menu · header" })).toBeTruthy();
    expect(screen.getByText("Page content")).toBeTruthy();
    expect(screen.getByText("Dashboard")).toBeTruthy();
    expect(screen.queryByText("Home")).toBeNull();
    expect(screen.queryByText("TaskLattice Guard")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "breadcrumb" })).toBeNull();
  });

  it("starts sidebar-page breadcrumbs at the navigation group", () => {
    pathname = "/guardrails";
    render(<ControlPlaneLayout />);

    expect(screen.getByText("Guardrail Design")).toBeTruthy();
    expect(screen.getByText("Guardrails")).toBeTruthy();
    expect(screen.queryByText("TaskLattice Guard")).toBeNull();
  });
});
